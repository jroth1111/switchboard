// Planner: canonicalizes models, selects candidates, builds execution plans.
// Ports behavior from litellm_logic/routing/planner.py, candidates.py, preflight.py.

import { MANIFEST } from "../config/manifest";
import type { RouteDecision } from "../observability/receipt";
import type {
  Deployment, RouteGroup, Policy, Surface, Operation, FailureClass, ContentClass,
} from "../config/schema";
import { hasTypedContentNormalization, normalizeTypedContentParts } from "../nim/repair/content-parts";
import { classifyPromptComplexity, smartRouteModelForTier } from "./complexity-router";

const MULTIMODAL_PART_TYPES = new Set(["image_url", "input_image", "image", "audio", "input_audio"]);
const VISIBLE_TEXT_PART_TYPES = new Set(["text", "input_text", "output_text", "summary_text"]);
const THINK_BLOCK_RE = /<think\b[^>]*>[\s\S]*?<\/think\s*>/gi;
const THINK_SELF_CLOSING_RE = /<think\b[^>]*\/\s*>/gi;

// ─── Request envelope ─────────────────────────────────────────────

export interface RequestEnvelope {
  requestId: string;
  originalModel: string;
  surface?: Surface;
  clientId?: string;
  appId?: string;
  userHash?: string;
  policyId?: string;
  policyVersion?: string;
  routeVersion?: string;
  body: Record<string, unknown>;
  stream: boolean;
  hasTools: boolean;
  hasStrictTools: boolean;
  isMultiTool: boolean;
  hasTypedContent: boolean;
  requiresJsonMode: boolean;
  requiresReasoning: boolean;
}

export interface RequestClass {
  stream: boolean;
  hasTools: boolean;
  hasStrictTools: boolean;
  isMultiTool: boolean;
  hasTypedContent: boolean;
  requiresJsonMode: boolean;
  requiresReasoning: boolean;
  operation: Operation;
  surface: Surface;
}

export function computeRequestClass(envelope: RequestEnvelope): RequestClass {
  return {
    stream: envelope.stream,
    hasTools: envelope.hasTools,
    hasStrictTools: envelope.hasStrictTools,
    isMultiTool: Boolean(envelope.isMultiTool),
    hasTypedContent: envelope.hasTypedContent,
    requiresJsonMode: envelope.requiresJsonMode,
    requiresReasoning: Boolean(envelope.requiresReasoning),
    operation: getOperation(envelope),
    surface: getSurface(envelope),
  };
}

// ─── Canonicalization ─────────────────────────────────────────────

export interface CanonicalizationResult {
  canonicalTarget: string;
  isManaged: boolean;
  reason: "alias" | "prefix" | "direct" | "unmanaged";
}

export function canonicalize(model: string): CanonicalizationResult {
  // Check explicit aliases first
  const alias = MANIFEST.aliases[model];
  if (alias) {
    return { canonicalTarget: alias, isManaged: true, reason: "alias" };
  }

  // Check managed prefixes
  for (const prefix of MANIFEST.managedModelPrefixes) {
    if (model.startsWith(prefix)) {
      const rest = model.slice(prefix.length);
      // The rest might itself be an alias or a direct group name
      const resolved = MANIFEST.aliases[rest] ?? rest;
      if (MANIFEST.routeGroups[resolved]) {
        return { canonicalTarget: resolved, isManaged: true, reason: "prefix" };
      }
      return { canonicalTarget: model, isManaged: false, reason: "unmanaged" };
    }
  }

  // Check if model is already a route group name
  if (MANIFEST.routeGroups[model]) {
    return { canonicalTarget: model, isManaged: true, reason: "direct" };
  }

  // Check ambiguous aliases — try alternative names in the same group
  for (const group of MANIFEST.allowedAmbiguousAliases ?? []) {
    const idx = group.indexOf(model);
    if (idx === -1) continue;
    for (let i = 0; i < group.length; i++) {
      if (i === idx) continue;
      const alt = group[i];
      const altAlias = MANIFEST.aliases[alt];
      if (altAlias) {
        return { canonicalTarget: altAlias, isManaged: true, reason: "alias" };
      }
    }
  }

  return { canonicalTarget: model, isManaged: false, reason: "unmanaged" };
}

// ─── Candidate selection ──────────────────────────────────────────

export interface CandidateGroup {
  group: string;
  routeGroup: RouteGroup;
  policy: Policy;
  deployments: Deployment[];
  score: number;
  rejectionReason?: string;
}

export function selectCandidateGroups(
  canonicalTarget: string,
  envelope: RequestEnvelope,
): CandidateGroup[] {
  const mainGroup = MANIFEST.routeGroups[canonicalTarget];
  if (!mainGroup) return [];

  const candidates: CandidateGroup[] = [];
  const seen = new Set<string>();

  // Check if tool/strict_tool request should use a dedicated tool group
  const toolGroup = mainGroup.planner?.toolGroup;
  const strictToolGroup = mainGroup.planner?.strictToolGroup;

  if (envelope.hasStrictTools && strictToolGroup) {
    const rg = MANIFEST.routeGroups[strictToolGroup];
    if (rg) {
      candidates.push(buildCandidate(strictToolGroup, rg, 100, envelope));
      seen.add(strictToolGroup);
    }
  } else if (envelope.hasTools && toolGroup) {
    const rg = MANIFEST.routeGroups[toolGroup];
    if (rg) {
      candidates.push(buildCandidate(toolGroup, rg, 100, envelope));
      seen.add(toolGroup);
    }
  }

  // Add the main group
  if (!seen.has(canonicalTarget)) {
    candidates.push(buildCandidate(canonicalTarget, mainGroup, 90, envelope));
    seen.add(canonicalTarget);
  }

  // Add full fallback closure in configured order. A one-hop list misses
  // terminal escape paths when the first fallback family is unhealthy.
  const fallbackQueue = [...mainGroup.fallbacks];
  const maxFallbackDepth = Object.keys(MANIFEST.routeGroups).length;
  while (fallbackQueue.length > 0 && seen.size < maxFallbackDepth) {
    const fallbackName = fallbackQueue.shift()!;
    if (seen.has(fallbackName)) continue;
    const rg = MANIFEST.routeGroups[fallbackName];
    if (!rg) continue;
    candidates.push(buildCandidate(fallbackName, rg, 70 - seen.size, envelope));
    seen.add(fallbackName);
    for (const nestedFallback of rg.fallbacks) {
      if (!seen.has(nestedFallback)) fallbackQueue.push(nestedFallback);
    }
  }

  return candidates;
}

function buildCandidate(
  groupName: string,
  rg: RouteGroup,
  baseScore: number,
  envelope: RequestEnvelope,
): CandidateGroup {
  const policy = MANIFEST.policies[groupName] ?? MANIFEST.defaultPolicy;
  const deployments = MANIFEST.deploymentsByGroup[groupName] ?? [];
  const contentClass = detectContentClass(envelope);
  let score = baseScore;
  let rejectionReason: string | undefined;

  // Preflight checks — hidden routes (subscriptions) bypass surface/operation
  // checks since they handle request transformation internally.
  const op = getOperation(envelope);
  const surface = getSurface(envelope);

  if (!rg.hidden) {
    if (!policy.request.supportedSurfaces.includes(surface)) {
      rejectionReason = `surface ${surface} not supported`;
    }

    if (!policy.request.supportedOperations.includes(op)) {
      rejectionReason = rejectionReason ?? `operation ${op} not supported`;
    }

    // Content class validation
    if (contentClass && !policy.request.allowedContentClasses.includes(contentClass)) {
      rejectionReason = rejectionReason ?? `content class ${contentClass} not allowed`;
    }
  }

  if (envelope.stream && envelope.hasTools && policy.request.rejectStreamingTools) {
    rejectionReason = rejectionReason ?? "streaming tools rejected by policy";
  }

  const compatibleDeployments: Deployment[] = [];
  const deploymentRejectionReasons: string[] = [];
  const requestedTokens = typeof envelope.body.max_tokens === "number" ? envelope.body.max_tokens : undefined;

  for (const deployment of deployments) {
    const deploymentRejection = deploymentCapabilityRejectionReason(deployment, envelope, contentClass, requestedTokens);
    if (deploymentRejection) {
      deploymentRejectionReasons.push(deploymentRejection);
    } else {
      compatibleDeployments.push(deployment);
    }
  }

  if (deployments.length === 0) {
    rejectionReason = rejectionReason ?? "no_deployments";
  } else if (compatibleDeployments.length === 0) {
    rejectionReason = rejectionReason ?? deploymentRejectionReasons[0] ?? "no_compatible_deployments";
  }

  return { group: groupName, routeGroup: rg, policy, deployments: compatibleDeployments, score, rejectionReason };
}

function detectContentClass(envelope: RequestEnvelope): ContentClass | undefined {
  const messages = envelope.body.messages as Array<Record<string, unknown>> | undefined;
  if (!messages?.length) return "empty";
  let hasText = false;
  let hasToolResult = false;
  for (const msg of messages) {
    const content = msg.content;
    if (typeof content === "string") {
      if (content.trim()) hasText = true;
      continue;
    }
    if (Array.isArray(content)) {
      for (const part of content) {
        if (typeof part === "object" && part !== null) {
          const type = typedPartType(part);
          if (MULTIMODAL_PART_TYPES.has(type)) return "multimodal";
          if (type === "tool_result") hasToolResult = true;
          if (VISIBLE_TEXT_PART_TYPES.has(type) && typedPartText(part) !== undefined) hasText = true;
        }
      }
    }
  }
  if (hasToolResult) return "tool_result";
  if (hasText) return "text";
  return "empty";
}

function deploymentCapabilityRejectionReason(
  deployment: Deployment,
  envelope: RequestEnvelope,
  contentClass: ContentClass | undefined,
  requestedTokens: number | undefined,
): string | undefined {
  if (envelope.stream && !deployment.supportsStreaming) return "streaming not supported";
  if (envelope.hasTools && capabilityUnavailable(deployment.capabilities.toolCalling)) return "tool calling not supported";
  if (envelope.stream && envelope.hasTools && capabilityUnavailable(deployment.capabilities.streamingWithTools)) return "streaming tools not supported";
  if (envelope.requiresJsonMode && capabilityUnavailable(deployment.capabilities.jsonMode)) return "json mode not supported";
  if (contentClass === "multimodal" && capabilityUnavailable(deployment.capabilities.multimodal)) return "unsupported_multimodal";
  if (envelope.requiresReasoning && deployment.capabilities.reasoning !== "native") return "unsupported_reasoning";
  if (envelope.hasStrictTools && deployment.capabilities.toolCalling !== "native") return "non_native_strict_tools";
  if (requestedTokens && deployment.contextWindow > 0 && requestedTokens > deployment.contextWindow) {
    return `max_tokens ${requestedTokens} exceeds context window ${deployment.contextWindow}`;
  }
  return undefined;
}

function capabilityUnavailable(level: Deployment["capabilities"][keyof Deployment["capabilities"]]): boolean {
  return level === "broken" || level === "none";
}

function typedPartType(part: unknown): string {
  if (typeof part !== "object" || part === null) return "";
  const raw = (part as Record<string, unknown>).type;
  return typeof raw === "string" ? raw.trim().toLowerCase() : "";
}

function typedPartText(part: unknown): string | undefined {
  if (typeof part !== "object" || part === null) return undefined;
  const record = part as Record<string, unknown>;
  for (const field of ["text", "input_text", "output_text", "summary_text"]) {
    const value = record[field];
    if (typeof value === "string") return value;
  }
  return undefined;
}

function stripReasoningFromTextPart(part: unknown): void {
  if (typeof part !== "object" || part === null) return;
  const record = part as Record<string, unknown>;
  for (const field of ["text", "input_text", "output_text", "summary_text"]) {
    const value = record[field];
    if (typeof value === "string") {
      record[field] = stripUserReasoningText(value);
    }
  }
}

function hasUserReasoningContent(msg: Record<string, unknown>): boolean {
  if (msg.role !== "user") return false;
  if (typeof msg.content === "string") return /<think\b/i.test(msg.content);
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some((part) => VISIBLE_TEXT_PART_TYPES.has(typedPartType(part)) && /<think\b/i.test(typedPartText(part) ?? ""));
}

function stripUserReasoningText(text: string): string {
  return text
    .replace(THINK_BLOCK_RE, "")
    .replace(THINK_SELF_CLOSING_RE, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

// ─── Operation / surface helpers ──────────────────────────────────

export function getSurface(envelope: RequestEnvelope): Surface {
  return envelope.surface ?? "chat_completions";
}

export function getOperation(envelope: RequestEnvelope): Operation {
  if (getSurface(envelope) === "responses") {
    return envelope.stream ? "responses_stream" : "responses";
  }
  if (envelope.stream) {
    if (envelope.hasStrictTools) return "strict_tool_stream";
    if (envelope.hasTools) return "tool_stream";
    return "chat_stream";
  }
  if (envelope.hasStrictTools) return "strict_tool";
  if (envelope.hasTools) return "tool";
  return "chat";
}

// ─── Execution plan ───────────────────────────────────────────────

export interface ExecutionPlan {
  requestId: string;
  originalModel: string;
  canonicalTarget: string;
  selectedGroup: string;
  selectedPolicy: Policy;
  selectedDeployments: Deployment[];
  fallbackSequence: Array<{
    group: string;
    policy: Policy;
    deployments: Deployment[];
  }>;
  transforms: RequestTransform[];
  routeDecision: RouteDecision;
  receipt: PlanReceiptDraft;
  isManaged: boolean;
}

export interface RequestTransform {
  type: "strip_param" | "set_param" | "strip_reasoning" | "clamp_max_tokens" | "raise_min_tokens" | "strip_user_reasoning" | "strip_response_format" | "normalize_typed_content_parts";
  param: string;
  value?: unknown;
}

export interface PlanReceiptDraft {
  requestId: string;
  timestamp: number;
  originalModel: string;
  canonicalTarget: string;
  selectedGroup: string;
  fallbackGroups: string[];
  attempts: Array<{
    group: string;
    deploymentId?: string;
    failureClass?: FailureClass;
    failureMessage?: string;
    durationMs?: number;
  }>;
}

export function resolveSmartRouteModel(envelope: RequestEnvelope): string {
  const initial = canonicalize(envelope.originalModel);
  if (initial.canonicalTarget !== "smart-route-worker") return envelope.originalModel;
  const tier = classifyPromptComplexity(envelope.body.messages ?? envelope.body.input);
  return smartRouteModelForTier(tier);
}

export function planRequest(
  envelope: RequestEnvelope,
  now = Date.now(),
): ExecutionPlan | null {
  const planningModel = resolveSmartRouteModel(envelope);
  const canon = canonicalize(planningModel);
  if (!canon.isManaged) return null;

  const candidates = selectCandidateGroups(canon.canonicalTarget, envelope);

  // Sort non-rejected candidates by score descending (health-aware: higher score = healthier)
  const viable = candidates
    .filter((c) => !c.rejectionReason)
    .sort((a, b) => b.score - a.score);

  const selected = viable[0];
  if (!selected) return null;

  const selectedDeployments = selected.deployments;
  if (selected.deployments.length === 0) return null;

  // Build fallback sequence from remaining viable candidates (sorted by score)
  const fallbackSequence = viable
    .filter((c) => c.group !== selected.group)
    .map((c) => ({
      group: c.group,
      policy: c.policy,
      deployments: c.deployments,
    }))
    .filter((f) => f.deployments.length > 0);

  // Compute transforms
  const transforms = buildTransforms(envelope, selected.policy, selectedDeployments);
  const requestClass = computeRequestClass(envelope);
  const routeDecision: RouteDecision = {
    canonicalization: {
      requestedModel: envelope.originalModel,
      canonicalTarget: canon.canonicalTarget,
      reason: canon.reason,
    },
    requestClass: {
      stream: requestClass.stream,
      hasTools: requestClass.hasTools,
      hasStrictTools: requestClass.hasStrictTools,
      isMultiTool: requestClass.isMultiTool,
      hasTypedContent: requestClass.hasTypedContent,
      requiresJsonMode: requestClass.requiresJsonMode,
      requiresReasoning: requestClass.requiresReasoning,
      operation: requestClass.operation,
      surface: requestClass.surface,
    },
    selectedGroup: selected.group,
    selectedReason: `highest scoring viable candidate (${selected.score})`,
    fallbackGroups: fallbackSequence.map((f) => f.group),
    candidates: candidates.map((candidate) => ({
      group: candidate.group,
      score: candidate.score,
      viable: !candidate.rejectionReason,
      rejectionReason: candidate.rejectionReason,
      hidden: candidate.routeGroup.hidden,
      deploymentCount: candidate.deployments.length,
    })),
    transforms: transforms.map((transform) => ({ ...transform })),
  };

  return {
    requestId: envelope.requestId,
    originalModel: envelope.originalModel,
    canonicalTarget: canon.canonicalTarget,
    selectedGroup: selected.group,
    selectedPolicy: selected.policy,
    selectedDeployments,
    fallbackSequence,
    transforms,
    routeDecision,
    receipt: {
      requestId: envelope.requestId,
      timestamp: now,
      originalModel: envelope.originalModel,
      canonicalTarget: canon.canonicalTarget,
      selectedGroup: selected.group,
      fallbackGroups: fallbackSequence.map((f) => f.group),
      attempts: [],
    },
    isManaged: true,
  };
}

function buildTransforms(envelope: RequestEnvelope, policy: Policy, deployments: Deployment[]): RequestTransform[] {
  const transforms: RequestTransform[] = [];

  // Strip unsupported top-level params
  for (const param of policy.request.unsupportedParams) {
    if (param in envelope.body) {
      transforms.push({ type: "strip_param", param });
    }
  }

  if (hasTypedContentNormalization(envelope.body)) {
    transforms.push({ type: "normalize_typed_content_parts", param: "messages" });
  }

  // Strip reasoning when not enabled or response-side stripping is configured
  const shouldStripReasoning = !policy.request.enableReasoning || policy.request.stripReasoningFromSuccess;
  if (shouldStripReasoning) {
    const hasReasoningParam = "reasoning_effort" in envelope.body
      || (envelope.body.extra_body as Record<string, unknown> | undefined)?.reasoning_effort
      || (envelope.body.extra_body as Record<string, unknown> | undefined)?.reasoning;
    if (hasReasoningParam) {
      transforms.push({ type: "strip_reasoning", param: "__reasoning__" });
    }
  }

  // Clamp max_tokens to policy ceiling
  if ((policy.request.maxRequestTokens !== null && policy.request.maxRequestTokens !== undefined)) {
    const maxTokens = envelope.body.max_tokens as number | undefined;
    if ((maxTokens !== null && maxTokens !== undefined) && maxTokens > policy.request.maxRequestTokens) {
      transforms.push({ type: "clamp_max_tokens", param: "max_tokens", value: policy.request.maxRequestTokens });
    }
  }

  // Raise max_tokens to policy floor
  if ((policy.request.minRequestTokens !== null && policy.request.minRequestTokens !== undefined)) {
    const maxTokens = envelope.body.max_tokens as number | undefined;
    if ((maxTokens !== null && maxTokens !== undefined) && maxTokens < policy.request.minRequestTokens) {
      transforms.push({ type: "raise_min_tokens", param: "max_tokens", value: policy.request.minRequestTokens });
    }
  }

  // Strip <think/> blocks from user messages (NIM sometimes echoes reasoning)
  if (policy.request.stripReasoningFromSuccess) {
    const messages = envelope.body.messages as Array<Record<string, unknown>> | undefined;
    if (messages) {
      for (const msg of messages) {
        if (hasUserReasoningContent(msg)) {
          transforms.push({ type: "strip_user_reasoning", param: "__user_reasoning__" });
          break;
        }
      }
    }
  }

  // Strip response_format when no deployment supports JSON mode
  if (envelope.requiresJsonMode && "response_format" in envelope.body) {
    const anyJsonSupport = deployments.some(
      (d) => d.capabilities.jsonMode === "native" || d.capabilities.jsonMode === "best_effort",
    );
    if (!anyJsonSupport) {
      transforms.push({ type: "strip_response_format", param: "response_format" });
    }
  }

  return transforms;
}

export function applyTransforms(
  body: Record<string, unknown>,
  transforms: RequestTransform[],
): Record<string, unknown> {
  const result = structuredClone(body);
  for (const t of transforms) {
    if (t.type === "strip_param") {
      delete result[t.param];
    } else if (t.type === "set_param") {
      result[t.param] = t.value;
    } else if (t.type === "clamp_max_tokens" || t.type === "raise_min_tokens") {
      result[t.param] = t.value;
    } else if (t.type === "strip_reasoning") {
      // Strip reasoning fields from top-level and extra_body
      delete result.reasoning_effort;
      const extraBody = result.extra_body as Record<string, unknown> | undefined;
      if (extraBody) {
        delete extraBody.reasoning_effort;
        delete extraBody.reasoning;
      }
    } else if (t.type === "strip_response_format") {
      delete result[t.param];
    } else if (t.type === "normalize_typed_content_parts") {
      normalizeTypedContentParts(result);
    } else if (t.type === "strip_user_reasoning") {
      // Strip thinking blocks from user messages
      const messages = result.messages as Array<Record<string, unknown>> | undefined;
      if (messages) {
        for (const msg of messages) {
          if (msg.role === "user") {
            if (typeof msg.content === "string") {
              msg.content = stripUserReasoningText(msg.content);
            } else if (Array.isArray(msg.content)) {
              for (const part of msg.content) {
                if (VISIBLE_TEXT_PART_TYPES.has(typedPartType(part))) {
                  stripReasoningFromTextPart(part);
                }
              }
            }
          }
        }
      }
    }
  }
  return result;
}
