// Operator health endpoint with auth.
// Ports litellm_logic/obs/health_endpoint.py.

import { MANIFEST } from "../config/manifest";
import type { Deployment } from "../config/schema";
import { getAllReceipts, type RouteReceipt } from "../observability/receipt";
import { verifyBearerToken } from "../http/auth";
import {
  canonicalize,
  computeRequestClass,
  selectCandidateGroups,
  type RequestClass,
  type RequestEnvelope,
} from "../planner/planner";
import { isOAuthExcluded, modelIdentitySet } from "../http/oauth-exclusions";
import {
  createEmptyFilterState,
  filterCandidates,
  filterOptionsForPolicy,
  policyForDeploymentGroup,
  type FilterState,
} from "../planner/deployment-filter";

type HealthProvider = {
  getHealth(): Promise<unknown>;
  getRecentReceipts?(limit?: number): Promise<Record<string, unknown>[]>;
  getRecentRouteDispatch?(canonicalTarget: string, requestClass: string, maxAgeSeconds: number): Promise<Record<string, unknown> | null>;
};

export interface HealthReport {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: number;
  routeGroups: Record<string, GroupHealth>;
  dependencies: HealthDependencies;
  requestShapes?: Record<RequestShapeId, RequestShapeDefinition>;
  aliasVisibility?: Record<string, AliasVisibility>;
  deploymentDiagnostics?: Record<string, DeploymentDiagnostics>;
  workerPressure?: WorkerPressureSummary;
  plannerSettings: {
    healthFallbackMargin: number;
    halfOpenPenalty: number;
    recentDispatchBonus: number;
    recentDispatchTtlSeconds: number;
  };
  recentOutcomes: {
    total: number;
    success: number;
    exhausted: number;
    clientError: number;
  };
  circuitBreakers: Record<string, CircuitState>;
  cooldowns: Record<string, CooldownState>;
}

export interface HealthDependencies {
  controlPlaneState: DependencyStatus;
  receiptHistory: DependencyStatus;
}

export interface DependencyStatus {
  status: "ok" | "degraded";
  reason?: string;
}

export interface CompleteHealthReport extends HealthReport {
  requestShapes: Record<RequestShapeId, RequestShapeDefinition>;
  aliasVisibility: Record<string, AliasVisibility>;
  deploymentDiagnostics: Record<string, DeploymentDiagnostics>;
  workerPressure: WorkerPressureSummary;
}

export interface GroupHealth {
  available: boolean;
  deployments: number;
  availableDeployments: number;
  blockedDeployments: number;
  circuitState?: string;
  avgHealthScore?: number;
}

export interface CircuitState {
  state: string;
  failureCount: number;
  successCount: number;
  openedAt?: number;
  halfOpenAfter?: number;
  updatedAt?: number;
}

export interface CooldownState {
  reason: string;
  until: number;
  details?: unknown;
}

export type RequestShapeId =
  | "chat"
  | "chat_stream"
  | "tool"
  | "tool_stream"
  | "strict_tool"
  | "strict_tool_stream"
  | "multi_tool"
  | "typed_content"
  | "reasoning"
  | "multimodal"
  | "responses"
  | "responses_stream";

export interface RequestShapeDefinition {
  id: RequestShapeId;
  surface: RequestClass["surface"];
  operation: RequestClass["operation"];
  stream: boolean;
  hasTools: boolean;
  hasStrictTools: boolean;
  isMultiTool: boolean;
  hasTypedContent: boolean;
  requiresJsonMode: boolean;
  requiresReasoning: boolean;
}

export interface AliasVisibility {
  alias: string;
  managed: boolean;
  canonicalTarget: string;
  resolutionReason: string;
  targetHidden?: boolean;
  oauthExcluded?: boolean;
  aliasesForTarget: string[];
  requestShapes: Record<RequestShapeId, AliasRequestShapeStatus>;
}

export interface AliasRequestShapeStatus {
  shape: RequestShapeId;
  requestClass: RequestClass;
  dispatchable: boolean;
  dispatchableCandidates: DispatchableCandidate[];
  rejectedCandidates: RejectedCandidate[];
  candidateGroups: CandidateGroupStatus[];
  recentDispatch?: RecentRouteDispatchMetadata;
}

export interface RecentRouteDispatchMetadata {
  alias: string;
  canonicalTarget: string;
  requestShape: RequestShapeId;
  requestClass: string;
  group: string;
  dispatchedAt: number;
}

export interface DispatchableCandidate {
  group: string;
  deploymentId: string;
  provider: Deployment["provider"];
  model: string;
  providerModel: string;
  pressureCategory: WorkerPressureCategory;
  healthScore?: number;
}

export interface RejectedCandidate {
  group: string;
  deploymentId?: string;
  reason: string;
  scope: "group" | "deployment";
}

export interface CandidateGroupStatus {
  group: string;
  score: number;
  viable: boolean;
  rejectionReason?: string;
  hidden: boolean;
  deploymentCount: number;
  dispatchableDeploymentCount: number;
}

export interface DeploymentDiagnostics {
  id: string;
  group: string;
  provider: Deployment["provider"];
  model: string;
  providerModel: string;
  hidden: boolean;
  rpm: number;
  maxParallelRequests: number;
  effectiveMaxParallel: number;
  supportsStreaming: boolean;
  capabilities: Deployment["capabilities"];
  healthScore?: number;
  health?: DeploymentHealthSummary;
  circuit?: CircuitState;
  cooldown?: CooldownState & { active: boolean };
  inflight: { count: number; updatedAt?: number };
  learnedConcurrencyLimit?: LearnedLimitState & { active: boolean };
  recentOutcome?: RecentDeploymentOutcome;
  pressure: DeploymentPressure;
}

export interface DeploymentHealthSummary {
  lastSuccessAt?: number;
  lastFailureAt?: number;
  failureClass?: string;
  updatedAt?: number;
  successCount?: number;
  failureCount?: number;
  consecutiveFailureCount?: number;
  latencyEmaMs?: number | null;
  latencySampleCount?: number;
  rollingMetrics?: RollingMetrics;
}

export type WorkerPressureCategory =
  | "healthy"
  | "quota_window_pressure"
  | "concurrency_pressure"
  | "timeout_pressure"
  | "malformed_output_pressure"
  | "cooldown"
  | "circuit_open"
  | "unavailable"
  | "unknown";

export interface DeploymentPressure {
  category: WorkerPressureCategory;
  reasons: string[];
}

export interface WorkerPressureSummary {
  totalDeployments: number;
  totalRouteGroups: number;
  deploymentCounts: Record<WorkerPressureCategory, number>;
  deploymentsByCategory: Record<WorkerPressureCategory, string[]>;
  routeGroupCounts: Record<WorkerPressureCategory, number>;
  routeGroupsByCategory: Record<WorkerPressureCategory, string[]>;
}

export interface RecentDeploymentOutcome {
  requestId: string;
  timestamp: number;
  originalModel: string;
  canonicalTarget: string;
  selectedGroup: string;
  finalOutcome: RouteReceipt["finalOutcome"];
  stream: boolean;
  action: string;
  failureClass?: string;
  durationMs?: number;
  firstByteLatencyMs?: number;
}

interface HealthState {
  circuits?: Record<string, CircuitState>;
  healthScores?: Record<string, HealthScoreState>;
  cooldowns?: Record<string, CooldownState>;
  inflight?: Record<string, InflightState>;
  learnedLimits?: Record<string, LearnedLimitState>;
  keyWindows?: Record<string, WindowCountState>;
  groupWindows?: Record<string, WindowCountState>;
  tokenWindows?: Record<string, TokenWindowState>;
  routeDispatchMemory?: RouteDispatchMemorySnapshot;
}

interface RouteDispatchMemorySnapshot {
  [canonicalTarget: string]: Record<string, RecentRouteDispatchState>;
}

interface RecentRouteDispatchState {
  group?: string;
  dispatchedAt?: number;
}

interface HealthScoreState {
  score?: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  failureClass?: string | null;
  updatedAt?: number;
  successCount?: number;
  failureCount?: number;
  consecutiveFailureCount?: number;
  latencyEmaMs?: number | null;
  latencySampleCount?: number;
  rollingMetrics?: RollingMetrics;
}

interface RollingMetrics {
  recentOutcomeCount?: number;
  recentFailureRate?: number;
  timeoutRate?: number;
  invalidSuccessRate?: number;
  p95FirstByteLatencyMs?: number | null;
  p95TotalLatencyMs?: number | null;
}

interface InflightState {
  count?: number;
  updatedAt?: number;
}

interface LearnedLimitState {
  maxParallel?: number;
  reason?: string;
  expiresAt?: number | null;
}

interface WindowCountState {
  windowStart?: number;
  count?: number;
}

interface TokenWindowState {
  windowStart?: number;
  promptTokens?: number;
  completionTokens?: number;
}

const CIRCUIT_STATE_RANK: Record<string, number> = {
  closed: 0,
  suspect: 1,
  half_open: 2,
  open: 3,
};

function groupCircuitState(
  deploymentIds: string[],
  circuits?: Record<string, CircuitState>,
): string {
  let worst = "closed";
  let worstRank = CIRCUIT_STATE_RANK.closed;
  for (const deploymentId of deploymentIds) {
    const state = circuits?.[deploymentId]?.state ?? "closed";
    const rank = CIRCUIT_STATE_RANK[state] ?? 0;
    if (rank > worstRank) {
      worst = state;
      worstRank = rank;
    }
  }
  return worst;
}

export async function buildHealthReport(stateDo: HealthProvider): Promise<CompleteHealthReport> {
  const now = Date.now();
  const dependencies: HealthDependencies = {
    controlPlaneState: { status: "ok" },
    receiptHistory: { status: "ok" },
  };
  let health: HealthState = {};
  try {
    const snapshot = await stateDo.getHealth();
    if (isRecord(snapshot)) {
      health = snapshot as HealthState;
    } else {
      dependencies.controlPlaneState = { status: "degraded", reason: "invalid_health_snapshot" };
    }
  } catch {
    dependencies.controlPlaneState = { status: "degraded", reason: "health_snapshot_unavailable" };
  }

  const circuits = health.circuits;
  const healthScores = health.healthScores;
  const cooldownsMap = health.cooldowns;

  let receipts: RouteReceipt[];
  if (stateDo.getRecentReceipts) {
    try {
      const recent = await stateDo.getRecentReceipts(200);
      if (Array.isArray(recent)) {
        receipts = recent as unknown as RouteReceipt[];
      } else {
        receipts = [];
        dependencies.receiptHistory = { status: "degraded", reason: "invalid_recent_receipts" };
      }
    } catch {
      receipts = [];
      dependencies.receiptHistory = { status: "degraded", reason: "recent_receipts_unavailable" };
    }
  } else {
    receipts = getAllReceipts();
  }
  const recentReceipts = receipts.filter((r) => now - r.timestamp < 300_000); // last 5 min
  const recentDeploymentOutcomes = buildRecentDeploymentOutcomes(recentReceipts);
  const filterState = buildFilterState(health);
  const deploymentDiagnostics = buildDeploymentDiagnostics(health, recentDeploymentOutcomes, now);

  // Build per-group health
  const routeGroups: Record<string, GroupHealth> = {};
  for (const [groupName, rg] of Object.entries(MANIFEST.routeGroups)) {
    if (rg.hidden) continue;

    const deployments = MANIFEST.deploymentsByGroup[groupName] ?? [];
    let totalScore = 0;
    let scoreCount = 0;
    const runtimeAvailability = summarizeRouteGroupAvailability(groupName, deployments, filterState, now);

    for (const d of deployments) {
      const hs = healthScores?.[d.id];
      if (typeof hs?.score === "number" && runtimeAvailability.passedDeploymentIds.has(d.id)) {
        totalScore += hs.score;
        scoreCount++;
      }
    }

    routeGroups[groupName] = {
      available: runtimeAvailability.availableDeployments > 0,
      deployments: deployments.length,
      availableDeployments: runtimeAvailability.availableDeployments,
      blockedDeployments: runtimeAvailability.blockedDeployments,
      circuitState: groupCircuitState(deployments.map((d) => d.id), circuits),
      avgHealthScore: scoreCount > 0 ? totalScore / scoreCount : undefined,
    };
  }

  // Recent outcomes from receipts
  const recentOutcomes = {
    total: recentReceipts.length,
    success: recentReceipts.filter((r) => r.finalOutcome === "success" || r.finalOutcome === "repaired_success").length,
    exhausted: recentReceipts.filter((r) => r.finalOutcome === "exhausted").length,
    clientError: recentReceipts.filter((r) => r.finalOutcome === "client_error").length,
  };

  // Overall status
  const availableGroups = Object.values(routeGroups).filter((g) => g.available).length;
  const totalGroups = Object.keys(routeGroups).length;
  let status: HealthReport["status"] = "healthy";
  if (availableGroups === 0) {
    status = "unhealthy";
  } else if (availableGroups < totalGroups || hasDegradedDependency(dependencies)) {
    status = "degraded";
  }

  const requestShapes = buildRequestShapeDefinitions();
  const aliasVisibility = await buildAliasVisibility(
    stateDo, filterState, deploymentDiagnostics, now, health.routeDispatchMemory,
    MANIFEST.oauthExcludedModels,
  );
  const workerPressure = buildWorkerPressureSummary(deploymentDiagnostics);

  return {
    status,
    timestamp: now,
    routeGroups,
    dependencies,
    requestShapes,
    aliasVisibility,
    deploymentDiagnostics,
    workerPressure,
    plannerSettings: { ...MANIFEST.plannerSettings },
    recentOutcomes,
    circuitBreakers: circuits ?? {},
    cooldowns: cooldownsMap ?? {},
  };
}

const REQUEST_SHAPES: Array<{ id: RequestShapeId; overrides: Partial<RequestEnvelope>; body: Record<string, unknown> }> = [
  {
    id: "chat",
    overrides: {},
    body: { messages: [{ role: "user", content: "hello" }] },
  },
  {
    id: "chat_stream",
    overrides: { stream: true },
    body: { messages: [{ role: "user", content: "hello" }], stream: true },
  },
  {
    id: "tool",
    overrides: { hasTools: true },
    body: { messages: [{ role: "user", content: "use tool" }], tools: [weatherTool()] },
  },
  {
    id: "tool_stream",
    overrides: { stream: true, hasTools: true },
    body: { messages: [{ role: "user", content: "use tool" }], tools: [weatherTool()], stream: true },
  },
  {
    id: "strict_tool",
    overrides: { hasTools: true, hasStrictTools: true },
    body: { messages: [{ role: "user", content: "use tool" }], tools: [weatherTool()], tool_choice: "required" },
  },
  {
    id: "strict_tool_stream",
    overrides: { stream: true, hasTools: true, hasStrictTools: true },
    body: { messages: [{ role: "user", content: "use tool" }], tools: [weatherTool()], tool_choice: "required", stream: true },
  },
  {
    id: "multi_tool",
    overrides: { hasTools: true, isMultiTool: true },
    body: { messages: [{ role: "user", content: "use tools" }], tools: [weatherTool(), clockTool()] },
  },
  {
    id: "typed_content",
    overrides: {},
    body: { messages: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }] },
  },
  {
    id: "reasoning",
    overrides: { requiresReasoning: true },
    body: { messages: [{ role: "user", content: "think carefully" }], reasoning_effort: "medium" },
  },
  {
    id: "multimodal",
    overrides: { hasTypedContent: true },
    body: {
      messages: [{
        role: "user",
        content: [{ type: "text", text: "describe this" }, { type: "image_url", image_url: { url: "data:image/png;base64,AA==" } }],
      }],
    },
  },
  {
    id: "responses",
    overrides: { surface: "responses" },
    body: { input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }] },
  },
  {
    id: "responses_stream",
    overrides: { surface: "responses", stream: true },
    body: { input: [{ role: "user", content: [{ type: "input_text", text: "hello" }] }], stream: true },
  },
];

const PRESSURE_CATEGORIES: WorkerPressureCategory[] = [
  "healthy",
  "quota_window_pressure",
  "concurrency_pressure",
  "timeout_pressure",
  "malformed_output_pressure",
  "cooldown",
  "circuit_open",
  "unavailable",
  "unknown",
];

const QUOTA_FAILURE_CLASSES = new Set(["rate_limit_quota_window", "subscription_limit"]);
const CONCURRENCY_FAILURE_CLASSES = new Set(["rate_limit_concurrency", "rate_limit_concurrency_ambiguous", "rate_limit_overload"]);
const TIMEOUT_FAILURE_CLASSES = new Set(["transport_timeout", "stream_interruption"]);
const MALFORMED_OUTPUT_FAILURE_CLASSES = new Set([
  "malformed_response",
  "empty_response",
  "truncated_response",
  "semantic_failure",
  "success_shaped_failure",
  "tool_contract_failure",
  "repetition_detected",
  "reasoning_leak",
  "special_token_leak",
  "input_echo",
]);

function weatherTool(): Record<string, unknown> {
  return {
    type: "function",
    function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
  };
}

function clockTool(): Record<string, unknown> {
  return {
    type: "function",
    function: { name: "get_time", description: "Get time", parameters: { type: "object", properties: { zone: { type: "string" } } } },
  };
}

function buildRequestShapeDefinitions(): Record<RequestShapeId, RequestShapeDefinition> {
  return Object.fromEntries(REQUEST_SHAPES.map((shape) => {
    const envelope = representativeEnvelope("worker", shape);
    const requestClass = computeRequestClass(envelope);
    return [shape.id, {
      id: shape.id,
      surface: requestClass.surface,
      operation: requestClass.operation,
      stream: requestClass.stream,
      hasTools: requestClass.hasTools,
      hasStrictTools: requestClass.hasStrictTools,
      isMultiTool: envelope.isMultiTool,
      hasTypedContent: requestClass.hasTypedContent,
      requiresJsonMode: requestClass.requiresJsonMode,
      requiresReasoning: envelope.requiresReasoning,
    }];
  })) as Record<RequestShapeId, RequestShapeDefinition>;
}

async function buildAliasVisibility(
  stateDo: HealthProvider,
  filterState: FilterState,
  deploymentDiagnostics: Record<string, DeploymentDiagnostics>,
  now: number,
  routeDispatchMemory: RouteDispatchMemorySnapshot | undefined,
  oauthExclusions?: Record<string, string[]>,
): Promise<Record<string, AliasVisibility>> {
  const aliases = Array.from(new Set([...Object.keys(MANIFEST.aliases), ...Object.keys(MANIFEST.routeGroups)])).sort();
  const aliasesByTarget = buildAliasesByTarget(aliases);
  const result: Record<string, AliasVisibility> = {};

  for (const alias of aliases) {
    const canonical = canonicalize(alias);
    const routeGroup = MANIFEST.routeGroups[canonical.canonicalTarget];
    const modelKeys = modelIdentitySet(alias, canonical.canonicalTarget);
    const oauthExcluded = canonical.isManaged
      && isOAuthExcluded(canonical.canonicalTarget, modelKeys, oauthExclusions);
    const requestShapeStatuses = await Promise.all(REQUEST_SHAPES.map(async (shape) => [
      shape.id,
      await evaluateAliasShape(
        alias, canonical.canonicalTarget, canonical.isManaged, shape,
        filterState, deploymentDiagnostics, now, stateDo, routeDispatchMemory,
        oauthExcluded,
      ),
    ] as const));
    result[alias] = {
      alias,
      managed: canonical.isManaged,
      canonicalTarget: canonical.canonicalTarget,
      resolutionReason: canonical.reason,
      targetHidden: routeGroup?.hidden,
      ...(oauthExcluded ? { oauthExcluded: true } : {}),
      aliasesForTarget: aliasesByTarget[canonical.canonicalTarget] ?? [],
      requestShapes: Object.fromEntries(requestShapeStatuses) as Record<RequestShapeId, AliasRequestShapeStatus>,
    };
  }

  return result;
}

async function evaluateAliasShape(
  alias: string,
  canonicalTarget: string,
  managed: boolean,
  shape: { id: RequestShapeId; overrides: Partial<RequestEnvelope>; body: Record<string, unknown> },
  filterState: FilterState,
  deploymentDiagnostics: Record<string, DeploymentDiagnostics>,
  now: number,
  stateDo: HealthProvider,
  routeDispatchMemory: RouteDispatchMemorySnapshot | undefined,
  oauthExcluded?: boolean,
): Promise<AliasRequestShapeStatus> {
  const envelope = representativeEnvelope(alias, shape);
  const requestClass = computeRequestClass(envelope);
  if (oauthExcluded) {
    return {
      shape: shape.id,
      requestClass,
      dispatchable: false,
      dispatchableCandidates: [],
      rejectedCandidates: [{ group: canonicalTarget, reason: "oauth_provider_excluded", scope: "group" }],
      candidateGroups: [],
    };
  }
  const dispatchableCandidates: DispatchableCandidate[] = [];
  const rejectedCandidates: RejectedCandidate[] = [];
  const candidateGroups: CandidateGroupStatus[] = [];

  if (!managed) {
    return {
      shape: shape.id,
      requestClass,
      dispatchable: false,
      dispatchableCandidates,
      rejectedCandidates: [{ group: canonicalTarget, reason: "unmanaged_model", scope: "group" }],
      candidateGroups,
    };
  }

  const candidates = selectCandidateGroups(canonicalTarget, envelope);
  for (const candidate of candidates) {
    const deployments = MANIFEST.deploymentsByGroup[candidate.group] ?? [];
    let dispatchableDeploymentCount = 0;

    if (candidate.rejectionReason) {
      rejectedCandidates.push({ group: candidate.group, reason: candidate.rejectionReason, scope: "group" });
    } else if (deployments.length === 0) {
      rejectedCandidates.push({ group: candidate.group, reason: "no_deployments", scope: "group" });
    } else {
      const filtered = filterCandidates(
        deployments,
        filterState,
        now,
        candidate.policy.budget.scopeMode,
        filterOptionsForPolicy(candidate.policy),
      );
      dispatchableDeploymentCount = filtered.passed.length;
      for (const passed of filtered.passed) {
        const diagnostic = deploymentDiagnostics[passed.deployment.id];
        dispatchableCandidates.push({
          group: candidate.group,
          deploymentId: passed.deployment.id,
          provider: passed.deployment.provider,
          model: passed.deployment.model,
          providerModel: passed.deployment.providerModel,
          pressureCategory: diagnostic?.pressure.category ?? "unknown",
          healthScore: diagnostic?.healthScore,
        });
      }
      for (const rejected of filtered.rejected) {
        rejectedCandidates.push({
          group: candidate.group,
          deploymentId: rejected.deployment.id,
          reason: rejected.reason,
          scope: "deployment",
        });
      }
    }

    candidateGroups.push({
      group: candidate.group,
      score: candidate.score,
      viable: !candidate.rejectionReason && dispatchableDeploymentCount > 0,
      rejectionReason: candidate.rejectionReason,
      hidden: candidate.routeGroup.hidden,
      deploymentCount: deployments.length,
      dispatchableDeploymentCount,
    });
  }

  const recentDispatch = await buildRecentDispatchMetadata(
    stateDo, alias, canonicalTarget, managed, shape.id, envelope, now, routeDispatchMemory,
  );

  return {
    shape: shape.id,
    requestClass,
    dispatchable: dispatchableCandidates.length > 0,
    dispatchableCandidates,
    rejectedCandidates,
    candidateGroups,
    ...(recentDispatch ? { recentDispatch } : {}),
  };
}

async function buildRecentDispatchMetadata(
  stateDo: HealthProvider,
  alias: string,
  canonicalTarget: string,
  managed: boolean,
  requestShape: RequestShapeId,
  envelope: RequestEnvelope,
  now: number,
  routeDispatchMemory: RouteDispatchMemorySnapshot | undefined,
): Promise<RecentRouteDispatchMetadata | undefined> {
  if (!managed) return undefined;
  const requestClass = dispatchRequestClass(envelope);
  const snapshotRecent = lookupRecentDispatch(routeDispatchMemory, canonicalTarget, requestClass, now);
  if (snapshotRecent) {
    return {
      alias,
      canonicalTarget,
      requestShape,
      requestClass,
      group: snapshotRecent.group,
      dispatchedAt: snapshotRecent.dispatchedAt,
    };
  }
  if (routeDispatchMemory !== undefined || !stateDo.getRecentRouteDispatch) return undefined;
  try {
    const recent = await stateDo.getRecentRouteDispatch(
      canonicalTarget,
      requestClass,
      MANIFEST.plannerSettings.recentDispatchTtlSeconds,
    );
    if (typeof recent?.group !== "string" || typeof recent.dispatchedAt !== "number") return undefined;
    return {
      alias,
      canonicalTarget,
      requestShape,
      requestClass,
      group: recent.group,
      dispatchedAt: recent.dispatchedAt,
    };
  } catch {
    return undefined;
  }
}

function lookupRecentDispatch(
  routeDispatchMemory: RouteDispatchMemorySnapshot | undefined,
  canonicalTarget: string,
  requestClass: string,
  now: number,
): { group: string; dispatchedAt: number } | undefined {
  const recent = routeDispatchMemory?.[canonicalTarget]?.[requestClass];
  if (typeof recent?.group !== "string" || typeof recent.dispatchedAt !== "number") return undefined;
  const maxAgeMs = MANIFEST.plannerSettings.recentDispatchTtlSeconds * 1000;
  if (now - recent.dispatchedAt > maxAgeMs) return undefined;
  return { group: recent.group, dispatchedAt: recent.dispatchedAt };
}

function dispatchRequestClass(envelope: RequestEnvelope): string {
  if (envelope.surface === "responses") {
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

function representativeEnvelope(
  alias: string,
  shape: { overrides: Partial<RequestEnvelope>; body: Record<string, unknown> },
): RequestEnvelope {
  const body = cloneBody(shape.body);
  body.model = alias;
  return {
    requestId: `health:${alias}`,
    originalModel: alias,
    body,
    stream: false,
    hasTools: false,
    hasStrictTools: false,
    isMultiTool: false,
    hasTypedContent: false,
    requiresJsonMode: false,
    requiresReasoning: false,
    ...shape.overrides,
  };
}

function cloneBody(body: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(body)) as Record<string, unknown>;
}

function buildAliasesByTarget(aliases: string[]): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const alias of aliases) {
    const canonical = canonicalize(alias);
    if (!canonical.isManaged) continue;
    (result[canonical.canonicalTarget] ??= []).push(alias);
  }
  for (const value of Object.values(result)) value.sort();
  return result;
}

function buildFilterState(health: HealthState): FilterState {
  const state = createEmptyFilterState();
  for (const [deploymentId, cooldown] of Object.entries(health.cooldowns ?? {})) {
    if (typeof cooldown.until === "number") state.cooldowns.set(deploymentId, { until: cooldown.until });
  }
  for (const [deploymentId, circuit] of Object.entries(health.circuits ?? {})) {
    if (circuit.state === "open" || circuit.state === "half_open" || circuit.state === "closed" || circuit.state === "suspect") {
      state.circuits.set(deploymentId, {
        state: circuit.state,
        failureCount: circuit.failureCount,
        halfOpenAfter: circuit.halfOpenAfter,
      });
    }
  }
  for (const [deploymentId, inflight] of Object.entries(health.inflight ?? {})) {
    if (typeof inflight.count === "number") state.inflight.set(deploymentId, inflight.count);
  }
  for (const [deploymentId, learned] of Object.entries(health.learnedLimits ?? {})) {
    if (typeof learned.maxParallel === "number") {
      state.learnedLimits.set(deploymentId, { maxParallel: learned.maxParallel, expiresAt: learned.expiresAt ?? undefined });
    }
  }
  for (const [deploymentId, score] of Object.entries(health.healthScores ?? {})) {
    state.healthScores.set(deploymentId, { consecutiveFailureCount: score.consecutiveFailureCount });
  }
  for (const [scope, window] of Object.entries(health.keyWindows ?? {})) {
    if (typeof window.count === "number" && typeof window.windowStart === "number") {
      state.keyWindows.set(scope, { windowStart: window.windowStart, count: window.count });
    }
  }
  for (const [group, window] of Object.entries(health.groupWindows ?? {})) {
    if (typeof window.count === "number" && typeof window.windowStart === "number") {
      state.groupWindows.set(group, { windowStart: window.windowStart, count: window.count });
    }
  }
  for (const [keyRef, window] of Object.entries(health.tokenWindows ?? {})) {
    if (
      typeof window.windowStart === "number" &&
      (typeof window.promptTokens === "number" || typeof window.completionTokens === "number")
    ) {
      state.tokenWindows.set(keyRef, {
        windowStart: window.windowStart,
        promptTokens: window.promptTokens ?? 0,
        completionTokens: window.completionTokens ?? 0,
      });
    }
  }
  return state;
}

function summarizeRouteGroupAvailability(
  groupName: string,
  deployments: Deployment[],
  filterState: FilterState,
  now: number,
): { availableDeployments: number; blockedDeployments: number; passedDeploymentIds: Set<string> } {
  const policy = policyForDeploymentGroup(groupName);
  const filtered = filterCandidates(
    deployments,
    filterState,
    now,
    policy.budget.scopeMode,
    filterOptionsForPolicy(policy),
  );
  return {
    availableDeployments: filtered.passed.length,
    blockedDeployments: filtered.rejected.length,
    passedDeploymentIds: new Set(filtered.passed.map((candidate) => candidate.deployment.id)),
  };
}

function hasDegradedDependency(dependencies: HealthDependencies): boolean {
  return Object.values(dependencies).some((dependency) => dependency.status === "degraded");
}

function buildDeploymentDiagnostics(
  health: HealthState,
  recentOutcomesByDeployment: Map<string, RecentDeploymentOutcome>,
  now: number,
): Record<string, DeploymentDiagnostics> {
  const result: Record<string, DeploymentDiagnostics> = {};
  for (const deployment of MANIFEST.deployments) {
    const healthScore = health.healthScores?.[deployment.id];
    const circuit = health.circuits?.[deployment.id];
    const cooldown = health.cooldowns?.[deployment.id];
    const inflight = health.inflight?.[deployment.id];
    const learned = health.learnedLimits?.[deployment.id];
    const recentOutcome = recentOutcomesByDeployment.get(deployment.id);
    const effectiveMaxParallel = effectiveMaxParallelForDeployment(deployment, learned, circuit, now);
    const pressure = categorizeDeploymentPressure(deployment, healthScore, circuit, cooldown, inflight, learned, recentOutcome, now);

    result[deployment.id] = {
      id: deployment.id,
      group: deployment.group,
      provider: deployment.provider,
      model: deployment.model,
      providerModel: deployment.providerModel,
      hidden: deployment.hidden,
      rpm: deployment.rpm,
      maxParallelRequests: deployment.maxParallelRequests,
      effectiveMaxParallel,
      supportsStreaming: deployment.supportsStreaming,
      capabilities: deployment.capabilities,
      healthScore: typeof healthScore?.score === "number" ? healthScore.score : undefined,
      health: buildDeploymentHealthSummary(healthScore),
      circuit,
      cooldown: cooldown ? { ...cooldown, active: cooldown.until > now } : undefined,
      inflight: { count: inflight?.count ?? 0, updatedAt: inflight?.updatedAt },
      learnedConcurrencyLimit: learned ? { ...learned, active: isLearnedLimitActive(learned, now) } : undefined,
      recentOutcome,
      pressure,
    };
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildDeploymentHealthSummary(score: HealthScoreState | undefined): DeploymentHealthSummary | undefined {
  if (!score) return undefined;
  return {
    lastSuccessAt: score.lastSuccessAt,
    lastFailureAt: score.lastFailureAt,
    failureClass: score.failureClass ?? undefined,
    updatedAt: score.updatedAt,
    successCount: score.successCount,
    failureCount: score.failureCount,
    consecutiveFailureCount: score.consecutiveFailureCount,
    latencyEmaMs: score.latencyEmaMs,
    latencySampleCount: score.latencySampleCount,
    rollingMetrics: score.rollingMetrics,
  };
}

function categorizeDeploymentPressure(
  deployment: Deployment,
  score: HealthScoreState | undefined,
  circuit: CircuitState | undefined,
  cooldown: CooldownState | undefined,
  inflight: InflightState | undefined,
  learned: LearnedLimitState | undefined,
  recentOutcome: RecentDeploymentOutcome | undefined,
  now: number,
): DeploymentPressure {
  if (cooldown && cooldown.until > now) {
    return { category: "cooldown", reasons: [`cooldown:${cooldown.reason}`] };
  }

  if (isCircuitBlocking(circuit, now)) {
    return { category: "circuit_open", reasons: ["circuit_open"] };
  }

  const effectiveMaxParallel = effectiveMaxParallelForDeployment(deployment, learned, circuit, now);
  const inflightCount = inflight?.count ?? 0;
  if (effectiveMaxParallel <= 0) {
    return { category: "unavailable", reasons: ["effective_max_parallel_zero"] };
  }
  if (inflightCount >= effectiveMaxParallel) {
    return { category: "concurrency_pressure", reasons: [`inflight:${inflightCount}/${effectiveMaxParallel}`] };
  }

  const failureClass = latestFailureClass(score, recentOutcome);
  if (failureClass && QUOTA_FAILURE_CLASSES.has(failureClass)) {
    return { category: "quota_window_pressure", reasons: [`failure_class:${failureClass}`] };
  }
  if (failureClass && CONCURRENCY_FAILURE_CLASSES.has(failureClass)) {
    return { category: "concurrency_pressure", reasons: [`failure_class:${failureClass}`] };
  }
  if (failureClass && TIMEOUT_FAILURE_CLASSES.has(failureClass)) {
    return { category: "timeout_pressure", reasons: [`failure_class:${failureClass}`] };
  }
  if (failureClass && MALFORMED_OUTPUT_FAILURE_CLASSES.has(failureClass)) {
    return { category: "malformed_output_pressure", reasons: [`failure_class:${failureClass}`] };
  }
  if ((score?.rollingMetrics?.timeoutRate ?? 0) > 0) {
    return { category: "timeout_pressure", reasons: [`timeout_rate:${score?.rollingMetrics?.timeoutRate}`] };
  }
  if ((score?.rollingMetrics?.invalidSuccessRate ?? 0) > 0) {
    return { category: "malformed_output_pressure", reasons: [`invalid_success_rate:${score?.rollingMetrics?.invalidSuccessRate}`] };
  }

  return { category: "healthy", reasons: [] };
}

function latestFailureClass(score: HealthScoreState | undefined, recentOutcome: RecentDeploymentOutcome | undefined): string | undefined {
  if (
    recentOutcome &&
    recentOutcome.action !== "accept" &&
    recentOutcome.action !== "repair_accept" &&
    typeof recentOutcome.failureClass === "string" &&
    recentOutcome.failureClass
  ) {
    return recentOutcome.failureClass;
  }
  if (typeof score?.failureClass === "string" && score.failureClass) {
    const lastFailureAt = score.lastFailureAt ?? 0;
    const lastSuccessAt = score.lastSuccessAt ?? 0;
    if (lastFailureAt >= lastSuccessAt) return score.failureClass;
  }
  return undefined;
}

function effectiveMaxParallelForDeployment(
  deployment: Deployment,
  learned: LearnedLimitState | undefined,
  circuit: CircuitState | undefined,
  now: number,
): number {
  const policy = MANIFEST.policies[deployment.group] ?? MANIFEST.defaultPolicy;
  let effectiveMax = deployment.maxParallelRequests;
  if (typeof policy.budget.maxParallelRequests === "number" && policy.budget.maxParallelRequests > 0) {
    effectiveMax = Math.min(effectiveMax, policy.budget.maxParallelRequests);
  }
  if (learned && isLearnedLimitActive(learned, now) && typeof learned.maxParallel === "number") {
    effectiveMax = Math.min(effectiveMax, learned.maxParallel);
  }
  if (isCircuitBlocking(circuit, now)) {
    effectiveMax = 0;
  } else if (isCircuitHalfOpen(circuit, now)) {
    effectiveMax = Math.min(effectiveMax, 1);
  }
  return effectiveMax;
}

function isLearnedLimitActive(learned: LearnedLimitState, now: number): boolean {
  return !learned.expiresAt || learned.expiresAt > now;
}

function isCircuitBlocking(circuit: CircuitState | undefined, now: number): boolean {
  return circuit?.state === "open" && (!circuit.halfOpenAfter || circuit.halfOpenAfter > now);
}

function isCircuitHalfOpen(circuit: CircuitState | undefined, now: number): boolean {
  return circuit?.state === "half_open" || (circuit?.state === "open" && typeof circuit.halfOpenAfter === "number" && circuit.halfOpenAfter <= now);
}

function buildWorkerPressureSummary(
  deploymentDiagnostics: Record<string, DeploymentDiagnostics>,
): WorkerPressureSummary {
  const deploymentsByCategory = emptyPressureBuckets();
  for (const diagnostic of Object.values(deploymentDiagnostics)) {
    deploymentsByCategory[diagnostic.pressure.category].push(diagnostic.id);
  }

  const routeGroupsByCategory = emptyPressureBuckets();
  for (const groupName of Object.keys(MANIFEST.routeGroups).sort()) {
    const category = categorizeRouteGroupPressure(groupName, deploymentDiagnostics);
    routeGroupsByCategory[category].push(groupName);
  }

  return {
    totalDeployments: Object.keys(deploymentDiagnostics).length,
    totalRouteGroups: Object.keys(MANIFEST.routeGroups).length,
    deploymentCounts: pressureCounts(deploymentsByCategory),
    deploymentsByCategory,
    routeGroupCounts: pressureCounts(routeGroupsByCategory),
    routeGroupsByCategory,
  };
}

function categorizeRouteGroupPressure(
  groupName: string,
  deploymentDiagnostics: Record<string, DeploymentDiagnostics>,
): WorkerPressureCategory {
  const deployments = MANIFEST.deploymentsByGroup[groupName] ?? [];
  if (deployments.length === 0) return "unavailable";

  const categories = deployments.map((deployment) => deploymentDiagnostics[deployment.id]?.pressure.category ?? "unknown");
  if (categories.some((category) => category === "healthy")) return "healthy";
  for (const category of ["cooldown", "circuit_open", "concurrency_pressure", "quota_window_pressure", "timeout_pressure", "malformed_output_pressure"] as WorkerPressureCategory[]) {
    if (categories.some((item) => item === category)) return category;
  }
  return "unknown";
}

function emptyPressureBuckets(): Record<WorkerPressureCategory, string[]> {
  const buckets = {} as Record<WorkerPressureCategory, string[]>;
  for (const category of PRESSURE_CATEGORIES) {
    buckets[category] = [];
  }
  return buckets;
}

function pressureCounts(buckets: Record<WorkerPressureCategory, string[]>): Record<WorkerPressureCategory, number> {
  return Object.fromEntries(PRESSURE_CATEGORIES.map((category) => [category, buckets[category].length])) as Record<WorkerPressureCategory, number>;
}

function buildRecentDeploymentOutcomes(receipts: RouteReceipt[]): Map<string, RecentDeploymentOutcome> {
  const result = new Map<string, RecentDeploymentOutcome>();
  const newestFirst = [...receipts].sort((a, b) => b.timestamp - a.timestamp);
  for (const receipt of newestFirst) {
    for (const attempt of [...receipt.attempts].reverse()) {
      if (!attempt.deploymentId || result.has(attempt.deploymentId)) continue;
      result.set(attempt.deploymentId, {
        requestId: receipt.requestId,
        timestamp: receipt.timestamp,
        originalModel: receipt.originalModel,
        canonicalTarget: receipt.canonicalTarget,
        selectedGroup: receipt.selectedGroup,
        finalOutcome: receipt.finalOutcome,
        stream: receipt.stream,
        action: attempt.action,
        failureClass: attempt.failureClass,
        durationMs: attempt.durationMs,
        firstByteLatencyMs: attempt.firstByteLatencyMs,
      });
    }
  }
  return result;
}

export function verifyHealthAuth(request: Request, healthToken?: string): boolean {
  if (!healthToken) return false;
  return verifyBearerToken(request, healthToken);
}

export function buildFailureSummary(
  receipt: RouteReceipt,
): Record<string, unknown> {
  return {
    requestId: receipt.requestId,
    timestamp: receipt.timestamp,
    model: receipt.originalModel,
    target: receipt.canonicalTarget,
    group: receipt.selectedGroup,
    outcome: receipt.finalOutcome,
    attempts: receipt.attempts.map((a) => ({
      group: a.group,
      deploymentId: a.deploymentId,
      failureClass: a.failureClass,
      action: a.action,
      durationMs: a.durationMs,
    })),
    stream: receipt.stream,
  };
}
