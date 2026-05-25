// Build-time manifest validation: catches misconfigurations before deploy.
// Run in tests (vitest) or build scripts to fail CI on invalid manifests.

import type {
  CapabilityLevel,
  ContentClass,
  Deployment,
  FailureClass,
  Operation,
  Policy,
  ProviderType,
  RouteManifest,
  Surface,
} from "./schema";

export interface ValidationIssue {
  kind: "error" | "warning";
  code: string;
  message: string;
  detail?: string;
}

/** Route groups that forward to other groups and intentionally own no deployments. */
export const ROUTING_ONLY_ROUTE_GROUPS = new Set(["nim-secondary"]);

export function validateManifest(m: RouteManifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  validateAliases(m, issues);
  validateFallbackGraph(m, issues);
  validateDeployments(m, issues);
  validateDeploymentsByGroup(m, issues);
  validatePolicies(m, issues);
  validateOAuthExcludedModels(m, issues);

  return issues;
}

const OAUTH_EXCLUSION_PROVIDER_KEYS = new Set(["anthropic", "chatgpt", "nim", "openai"]);

function validateOAuthExcludedModels(m: RouteManifest, issues: ValidationIssue[]): void {
  const exclusions = m.oauthExcludedModels;
  if (!exclusions) return;
  if (!isPlainRecord(exclusions)) {
    issues.push({ kind: "error", code: "oauth_excluded_invalid", message: "oauthExcludedModels must be an object" });
    return;
  }
  for (const [provider, models] of Object.entries(exclusions)) {
    if (!OAUTH_EXCLUSION_PROVIDER_KEYS.has(provider)) {
      issues.push({
        kind: "error",
        code: "oauth_excluded_provider_unknown",
        message: `oauthExcludedModels unknown provider '${provider}'`,
        detail: `expected one of: ${[...OAUTH_EXCLUSION_PROVIDER_KEYS].join(", ")}`,
      });
    }
    if (!Array.isArray(models) || !models.every((m) => typeof m === "string" && m.trim().length > 0)) {
      issues.push({
        kind: "error",
        code: "oauth_excluded_models_invalid",
        message: `oauthExcludedModels['${provider}'] must be a non-empty string array`,
      });
    }
  }
}

const PROVIDERS = new Set<ProviderType>(["nvidia_nim", "openai", "chatgpt", "anthropic_subscription"]);
const CAPABILITY_LEVELS = new Set<CapabilityLevel>(["native", "best_effort", "broken", "none"]);
const SURFACES = new Set<Surface>(["chat_completions", "responses"]);
const OPERATIONS = new Set<Operation>([
  "chat", "chat_stream",
  "tool", "tool_stream",
  "strict_tool", "strict_tool_stream",
  "responses", "responses_stream",
]);
const CONTENT_CLASSES = new Set<ContentClass>(["empty", "text", "multimodal", "tool_result"]);
const FAILURE_CLASSES = new Set<FailureClass>([
  "rate_limit_overload",
  "rate_limit_quota_window",
  "rate_limit_concurrency",
  "rate_limit_concurrency_ambiguous",
  "server_5xx",
  "transport_error",
  "transport_timeout",
  "auth_failure",
  "oauth_session_failure",
  "oauth_refresh_failure",
  "subscription_limit",
  "responses_api_error",
  "client_4xx",
  "client_4xx_bad_request",
  "context_length_exceeded",
  "invalid_model",
  "malformed_response",
  "empty_response",
  "truncated_response",
  "semantic_failure",
  "success_shaped_failure",
  "tool_contract_failure",
  "stream_interruption",
  "repetition_detected",
  "reasoning_leak",
  "special_token_leak",
  "input_echo",
  "unknown_failure",
]);

// ─── Alias resolution ──────────────────────────────────────────────

function validateAliases(m: RouteManifest, issues: ValidationIssue[]): void {
  const groupNames = new Set(Object.keys(m.routeGroups));

  for (const [alias, target] of Object.entries(m.aliases)) {
    if (!groupNames.has(target)) {
      issues.push({
        kind: "error",
        code: "alias_target_missing",
        message: `Alias "${alias}" resolves to "${target}" which is not a route group`,
      });
    }

    // Self-referencing alias is fine (e.g. "nim-primary" → "nim-primary")
    // but a chain through another alias is not allowed — aliases must point
    // directly to groups, not to other aliases.
    if (m.aliases[target] !== undefined && m.aliases[target] !== target) {
      issues.push({
        kind: "warning",
        code: "alias_chain",
        message: `Alias "${alias}" points to "${target}" which is itself an alias (not a group)`,
        detail: `Resolved chain: ${alias} → ${target} → ${m.aliases[target]}`,
      });
    }
  }

  // Check allowedAmbiguousAliases references are valid aliases
  for (const pair of m.allowedAmbiguousAliases ?? []) {
    for (const name of pair) {
      if (!(name in m.aliases)) {
        issues.push({
          kind: "warning",
          code: "ambiguous_alias_missing",
          message: `allowedAmbiguousAliases references "${name}" which is not an alias`,
        });
      }
    }
  }
}

// ─── Acyclic fallback graph ────────────────────────────────────────

function validateFallbackGraph(m: RouteManifest, issues: ValidationIssue[]): void {
  const groups = Object.keys(m.routeGroups);
  const reportedCycles = new Set<string>();

  for (const group of groups) {
    const visited = new Set<string>();
    detectCycle(m, group, group, visited, [], issues, reportedCycles);
  }

  // Check that all fallback group references exist
  for (const [group, rg] of Object.entries(m.routeGroups)) {
    for (const fb of rg.fallbacks) {
      if (!(fb in m.routeGroups)) {
        issues.push({
          kind: "error",
          code: "fallback_group_missing",
          message: `Route group "${group}" references fallback "${fb}" which does not exist`,
        });
      }
    }

    if (rg.planner?.toolGroup && !(rg.planner.toolGroup in m.routeGroups)) {
      issues.push({
        kind: "error",
        code: "planner_tool_group_missing",
        message: `Route group "${group}" references planner.toolGroup "${rg.planner.toolGroup}" which does not exist`,
      });
    }

    if (rg.planner?.strictToolGroup && !(rg.planner.strictToolGroup in m.routeGroups)) {
      issues.push({
        kind: "error",
        code: "planner_strict_tool_group_missing",
        message: `Route group "${group}" references planner.strictToolGroup "${rg.planner.strictToolGroup}" which does not exist`,
      });
    }
  }
}

function detectCycle(
  m: RouteManifest,
  start: string,
  current: string,
  visited: Set<string>,
  path: string[],
  issues: ValidationIssue[],
  reportedCycles: Set<string>,
): void {
  if (visited.has(current)) {
    if (current === start) {
      const cyclePath = [...path, current].join(" → ");
      // Deduplicate: normalize the cycle to a canonical key by starting
      // at the lexicographically smallest node to ensure A→B→C and B→C→A
      // share the same key, but A→C→B gets a different key.
      let minIdx = 0;
      for (let i = 1; i < path.length; i++) {
        if (path[i] < path[minIdx]) {
          minIdx = i;
        }
      }
      const canonicalCycle = [
        ...path.slice(minIdx),
        ...path.slice(0, minIdx)
      ];
      const cycleKey = canonicalCycle.join(",");
      if (!reportedCycles.has(cycleKey)) {
        reportedCycles.add(cycleKey);
        issues.push({
          kind: "error",
          code: "fallback_cycle",
          message: `Circular fallback chain detected starting at "${start}"`,
          detail: cyclePath,
        });
      }
    }
    return;
  }

  visited.add(current);
  path.push(current);

  const rg = m.routeGroups[current];
  if (rg) {
    for (const fb of rg.fallbacks) {
      detectCycle(m, start, fb, visited, path, issues, reportedCycles);
    }
  }

  path.pop();
  visited.delete(current);
}

// ─── Deployment consistency ────────────────────────────────────────

function validateDeployments(m: RouteManifest, issues: ValidationIssue[]): void {
  const deploymentIds = new Set<string>();
  const groupsWithDeployments = new Set<string>();

  for (const d of m.deployments) {
    // Duplicate IDs
    if (deploymentIds.has(d.id)) {
      issues.push({
        kind: "error",
        code: "duplicate_deployment_id",
        message: `Duplicate deployment ID "${d.id}"`,
      });
    }
    deploymentIds.add(d.id);

    // Group must exist in routeGroups
    if (!(d.group in m.routeGroups)) {
      issues.push({
        kind: "error",
        code: "deployment_group_missing",
        message: `Deployment "${d.id}" references group "${d.group}" which is not a route group`,
      });
    }

    groupsWithDeployments.add(d.group);
    validateDeploymentShape(d, issues);
  }

  // Groups with fallbacks (or that are fallback targets) should have deployments
  const fallbackTargets = new Set<string>();
  for (const rg of Object.values(m.routeGroups)) {
    for (const fb of rg.fallbacks) {
      fallbackTargets.add(fb);
    }
  }

  for (const group of Object.keys(m.routeGroups)) {
    const rg = m.routeGroups[group];
    if (ROUTING_ONLY_ROUTE_GROUPS.has(group)) continue;
    // Only warn about groups that are reachable (non-hidden, or a fallback target)
    if (!groupsWithDeployments.has(group) && (!rg.hidden || fallbackTargets.has(group))) {
      issues.push({
        kind: "warning",
        code: "group_has_no_deployments",
        message: `Route group "${group}" has no deployments`,
        detail: rg.hidden
          ? "Hidden group is a fallback target but has no deployments"
          : undefined,
      });
    }
  }
}

function validateDeploymentShape(d: Deployment, issues: ValidationIssue[]): void {
  for (const field of ["id", "group", "model", "providerModel", "keyRef"] as const) {
    if (!isNonEmptyString(d[field])) {
      issues.push({
        kind: "error",
        code: "deployment_string_invalid",
        message: `Deployment "${String(d.id)}" field "${field}" must be a non-empty string`,
      });
    }
  }

  if (!PROVIDERS.has(d.provider)) {
    issues.push({
      kind: "error",
      code: "deployment_provider_invalid",
      message: `Deployment "${d.id}" provider "${String(d.provider)}" is not supported`,
    });
  }

  positiveInteger(d.rpm, `Deployment "${d.id}" rpm`, "deployment_rpm_invalid", issues);
  positiveInteger(d.maxParallelRequests, `Deployment "${d.id}" maxParallelRequests`, "deployment_parallel_invalid", issues);
  positiveNumber(d.timeout, `Deployment "${d.id}" timeout`, "deployment_timeout_invalid", issues);
  positiveNumber(d.streamTimeout, `Deployment "${d.id}" streamTimeout`, "deployment_timeout_invalid", issues);
  positiveInteger(d.contextWindow, `Deployment "${d.id}" contextWindow`, "deployment_context_invalid", issues);

  if (typeof d.supportsStreaming !== "boolean") {
    issues.push({
      kind: "error",
      code: "deployment_streaming_invalid",
      message: `Deployment "${d.id}" supportsStreaming must be boolean`,
    });
  }
  if (typeof d.hidden !== "boolean") {
    issues.push({
      kind: "error",
      code: "deployment_hidden_invalid",
      message: `Deployment "${d.id}" hidden must be boolean`,
    });
  }

  if (d.apiBase !== undefined && !isSafeProviderApiBase(d.apiBase)) {
    issues.push({
      kind: "error",
      code: "deployment_api_base_invalid",
      message: `Deployment "${d.id}" apiBase must be an absolute https URL, or localhost http URL for local fixtures`,
    });
  }

  const caps = d.capabilities as Record<string, unknown> | undefined;
  for (const key of ["toolCalling", "streamingWithTools", "jsonMode", "reasoning", "multimodal"]) {
    if (!caps || !CAPABILITY_LEVELS.has(caps[key] as CapabilityLevel)) {
      issues.push({
        kind: "error",
        code: "deployment_capability_invalid",
        message: `Deployment "${d.id}" capability "${key}" is invalid`,
      });
    }
  }

  if (d.mode !== undefined && !isNonEmptyString(d.mode)) {
    issues.push({
      kind: "error",
      code: "deployment_mode_invalid",
      message: `Deployment "${d.id}" mode must be a non-empty string when set`,
    });
  }
  if (d.reasoningEffort !== undefined && !isNonEmptyString(d.reasoningEffort)) {
    issues.push({
      kind: "error",
      code: "deployment_reasoning_effort_invalid",
      message: `Deployment "${d.id}" reasoningEffort must be a non-empty string when set`,
    });
  }
  if (d.params !== undefined && !isPlainRecord(d.params)) {
    issues.push({
      kind: "error",
      code: "deployment_params_invalid",
      message: `Deployment "${d.id}" params must be an object when set`,
    });
  }
  if (d.extraBody !== undefined && !isPlainRecord(d.extraBody)) {
    issues.push({
      kind: "error",
      code: "deployment_extra_body_invalid",
      message: `Deployment "${d.id}" extraBody must be an object when set`,
    });
  }

  const cooldown = d.cooldownProfile;
  if (cooldown) {
    for (const [field, value] of Object.entries(cooldown)) {
      if (value !== undefined) {
        positiveNumber(value, `Deployment "${d.id}" cooldownProfile.${field}`, "deployment_cooldown_invalid", issues);
      }
    }
  }
}

function validateDeploymentsByGroup(m: RouteManifest, issues: ValidationIssue[]): void {
  const expected = new Map<string, string[]>();
  for (const deployment of m.deployments) {
    const ids = expected.get(deployment.group) ?? [];
    ids.push(deployment.id);
    expected.set(deployment.group, ids);
  }

  const indexedGroups = new Set(Object.keys(m.deploymentsByGroup ?? {}));
  for (const [group, expectedIds] of expected.entries()) {
    indexedGroups.delete(group);
    const indexedIds = (m.deploymentsByGroup?.[group] ?? []).map((deployment) => deployment.id);
    if (!sameStringList(indexedIds, expectedIds)) {
      issues.push({
        kind: "error",
        code: "deployments_by_group_drift",
        message: `deploymentsByGroup["${group}"] does not match deployments for that group`,
        detail: `expected ${expectedIds.join(", ")}; got ${indexedIds.join(", ")}`,
      });
    }
  }

  for (const staleGroup of indexedGroups) {
    const indexedIds = (m.deploymentsByGroup?.[staleGroup] ?? []).map((deployment) => deployment.id);
    if (indexedIds.length > 0) {
      issues.push({
        kind: "error",
        code: "deployments_by_group_stale",
        message: `deploymentsByGroup["${staleGroup}"] has deployments but no deployment declares that group`,
        detail: indexedIds.join(", "),
      });
    }
  }
}

// ─── Policy existence ──────────────────────────────────────────────

function validatePolicies(m: RouteManifest, issues: ValidationIssue[]): void {
  for (const group of Object.keys(m.routeGroups)) {
    if (!(group in m.policies)) {
      issues.push({
        kind: "warning",
        code: "missing_policy",
        message: `Route group "${group}" has no policy (will use default)`,
      });
    }
  }

  // Validate default policy exists
  if (!m.defaultPolicy) {
    issues.push({
      kind: "error",
      code: "no_default_policy",
      message: "Manifest has no defaultPolicy",
    });
  } else {
    validatePolicy("defaultPolicy", m.defaultPolicy, issues);
  }

  for (const [group, policy] of Object.entries(m.policies)) {
    validatePolicy(`policy "${group}"`, policy, issues);
  }
}

function validatePolicy(name: string, policy: Policy, issues: ValidationIssue[]): void {
  if (!isPlainRecord(policy)) {
    issues.push({
      kind: "error",
      code: "policy_invalid",
      message: `${name} must be an object`,
    });
    return;
  }

  const request = policy.request;
  if (!isPlainRecord(request)) {
    issues.push({ kind: "error", code: "policy_request_invalid", message: `${name}.request must be an object` });
  } else {
    stringList(request.unsupportedParams, `${name}.request.unsupportedParams`, "policy_request_invalid", issues);
    enumList(request.supportedSurfaces, SURFACES, `${name}.request.supportedSurfaces`, "policy_surface_invalid", issues);
    enumList(request.supportedOperations, OPERATIONS, `${name}.request.supportedOperations`, "policy_operation_invalid", issues);
    enumList(request.allowedContentClasses, CONTENT_CLASSES, `${name}.request.allowedContentClasses`, "policy_content_class_invalid", issues);
    booleanValue(request.rejectStreamingTools, `${name}.request.rejectStreamingTools`, "policy_request_invalid", issues);
    booleanValue(request.stripReasoningFromSuccess, `${name}.request.stripReasoningFromSuccess`, "policy_request_invalid", issues);
    booleanValue(request.enableReasoning, `${name}.request.enableReasoning`, "policy_request_invalid", issues);
    nullablePositiveInteger(request.minRequestTokens, `${name}.request.minRequestTokens`, "policy_token_limit_invalid", issues);
    nullablePositiveInteger(request.maxRequestTokens, `${name}.request.maxRequestTokens`, "policy_token_limit_invalid", issues);
    if (
      typeof request.minRequestTokens === "number"
      && typeof request.maxRequestTokens === "number"
      && request.maxRequestTokens < request.minRequestTokens
    ) {
      issues.push({
        kind: "error",
        code: "policy_token_limit_invalid",
        message: `${name}.request.maxRequestTokens must be >= minRequestTokens`,
      });
    }
  }

  const response = policy.response;
  if (!isPlainRecord(response)) {
    issues.push({ kind: "error", code: "policy_response_invalid", message: `${name}.response must be an object` });
  } else {
    booleanValue(response.enableSemanticValidation, `${name}.response.enableSemanticValidation`, "policy_response_invalid", issues);
    booleanValue(response.enableToolRepair, `${name}.response.enableToolRepair`, "policy_response_invalid", issues);
    booleanValue(response.enableSpecialTokenDetection, `${name}.response.enableSpecialTokenDetection`, "policy_response_invalid", issues);
    booleanValue(response.enableRepetitionDetection, `${name}.response.enableRepetitionDetection`, "policy_response_invalid", issues);
    booleanValue(response.enableSchemaAwareRepair, `${name}.response.enableSchemaAwareRepair`, "policy_response_invalid", issues);
    ratio(response.repetitionMaxRatio, `${name}.response.repetitionMaxRatio`, "policy_response_threshold_invalid", issues);
    nonNegativeInteger(response.semanticMinChars, `${name}.response.semanticMinChars`, "policy_response_threshold_invalid", issues);
    positiveNumber(response.semanticMinEntropy, `${name}.response.semanticMinEntropy`, "policy_response_threshold_invalid", issues);
    ratio(response.semanticMinPrintableRatio, `${name}.response.semanticMinPrintableRatio`, "policy_response_threshold_invalid", issues);
    validateRepairPolicy(name, response.repairPolicy, issues);
  }

  const deadline = policy.deadline;
  if (!isPlainRecord(deadline)) {
    issues.push({ kind: "error", code: "policy_deadline_invalid", message: `${name}.deadline must be an object` });
  } else {
    positiveNumber(deadline.attemptTimeoutSeconds, `${name}.deadline.attemptTimeoutSeconds`, "policy_deadline_invalid", issues);
    positiveNumber(deadline.firstTokenTimeoutSeconds, `${name}.deadline.firstTokenTimeoutSeconds`, "policy_deadline_invalid", issues);
    positiveNumber(deadline.streamIdleTimeoutSeconds, `${name}.deadline.streamIdleTimeoutSeconds`, "policy_deadline_invalid", issues);
    positiveNumber(deadline.totalTimeoutSeconds, `${name}.deadline.totalTimeoutSeconds`, "policy_deadline_invalid", issues);
    if (deadline.streamHardTimeoutSeconds !== undefined) {
      positiveNumber(deadline.streamHardTimeoutSeconds, `${name}.deadline.streamHardTimeoutSeconds`, "policy_deadline_invalid", issues);
    }
    if (
      typeof deadline.totalTimeoutSeconds === "number"
      && typeof deadline.attemptTimeoutSeconds === "number"
      && deadline.totalTimeoutSeconds < deadline.attemptTimeoutSeconds
    ) {
      issues.push({
        kind: "error",
        code: "policy_deadline_invalid",
        message: `${name}.deadline.totalTimeoutSeconds must be >= attemptTimeoutSeconds`,
      });
    }
  }

  const retry = policy.retry;
  if (!isPlainRecord(retry)) {
    issues.push({ kind: "error", code: "policy_retry_invalid", message: `${name}.retry must be an object` });
  } else {
    nonNegativeInteger(retry.transportRetries, `${name}.retry.transportRetries`, "policy_retry_invalid", issues);
    nonNegativeInteger(retry.semanticRetries, `${name}.retry.semanticRetries`, "policy_retry_invalid", issues);
    enumList(retry.retryableFailureClasses, FAILURE_CLASSES, `${name}.retry.retryableFailureClasses`, "policy_retry_failure_class_invalid", issues, true);
    nonNegativeNumber(retry.backoffBaseMs, `${name}.retry.backoffBaseMs`, "policy_retry_invalid", issues);
    nonNegativeNumber(retry.backoffMaxMs, `${name}.retry.backoffMaxMs`, "policy_retry_invalid", issues);
    if (typeof retry.backoffBaseMs === "number" && typeof retry.backoffMaxMs === "number" && retry.backoffMaxMs < retry.backoffBaseMs) {
      issues.push({
        kind: "error",
        code: "policy_retry_invalid",
        message: `${name}.retry.backoffMaxMs must be >= backoffBaseMs`,
      });
    }
    if (retry.hedge !== undefined) {
      const hedge = retry.hedge;
      if (!isPlainRecord(hedge)) {
        issues.push({ kind: "error", code: "policy_hedge_invalid", message: `${name}.retry.hedge must be an object when set` });
      } else {
        booleanValue(hedge.enabled, `${name}.retry.hedge.enabled`, "policy_hedge_invalid", issues);
        positiveInteger(hedge.maxCandidates, `${name}.retry.hedge.maxCandidates`, "policy_hedge_invalid", issues);
        booleanValue(hedge.onlyWhenSuspect, `${name}.retry.hedge.onlyWhenSuspect`, "policy_hedge_invalid", issues);
        nonNegativeNumber(hedge.hedgeDelayMs, `${name}.retry.hedge.hedgeDelayMs`, "policy_hedge_invalid", issues);
      }
    }
  }

  const health = policy.health;
  if (!isPlainRecord(health)) {
    issues.push({ kind: "error", code: "policy_health_invalid", message: `${name}.health must be an object` });
  } else {
    positiveInteger(health.circuitFailureThreshold, `${name}.health.circuitFailureThreshold`, "policy_health_invalid", issues);
    positiveNumber(health.circuitDurationSeconds, `${name}.health.circuitDurationSeconds`, "policy_health_invalid", issues);
    positiveInteger(health.transportCooldownThreshold, `${name}.health.transportCooldownThreshold`, "policy_health_invalid", issues);
    positiveNumber(health.transportCooldownSeconds, `${name}.health.transportCooldownSeconds`, "policy_health_invalid", issues);
    positiveInteger(health.semanticCooldownThreshold, `${name}.health.semanticCooldownThreshold`, "policy_health_invalid", issues);
    positiveInteger(health.rateLimitCooldownThreshold, `${name}.health.rateLimitCooldownThreshold`, "policy_health_invalid", issues);
    nonNegativeNumber(health.halfOpenPenalty, `${name}.health.halfOpenPenalty`, "policy_health_invalid", issues);
    positiveInteger(health.circuitSuccessThreshold, `${name}.health.circuitSuccessThreshold`, "policy_health_invalid", issues);
    positiveInteger(health.probeMaxInflight, `${name}.health.probeMaxInflight`, "policy_health_invalid", issues);
    ratio(health.suspectThresholdFraction, `${name}.health.suspectThresholdFraction`, "policy_health_invalid", issues);
    positiveNumber(health.suspectMaxParallelDivisor, `${name}.health.suspectMaxParallelDivisor`, "policy_health_invalid", issues);
    nonNegativeNumber(health.latencyPenaltyFactor, `${name}.health.latencyPenaltyFactor`, "policy_health_invalid", issues);
    ratio(health.latencyEmaAlpha, `${name}.health.latencyEmaAlpha`, "policy_health_invalid", issues);
    nonNegativeInteger(health.latencyWarmupSamples, `${name}.health.latencyWarmupSamples`, "policy_health_invalid", issues);
  }

  const budget = policy.budget;
  if (!isPlainRecord(budget)) {
    issues.push({ kind: "error", code: "policy_budget_invalid", message: `${name}.budget must be an object` });
  } else {
    if (budget.scopeMode !== "global" && budget.scopeMode !== "per_key") {
      issues.push({
        kind: "error",
        code: "policy_budget_scope_invalid",
        message: `${name}.budget.scopeMode must be "global" or "per_key"`,
      });
    }
    nullablePositiveInteger(budget.rpmLimit, `${name}.budget.rpmLimit`, "policy_budget_filter_invalid", issues);
    nullablePositiveInteger(budget.maxParallelRequests, `${name}.budget.maxParallelRequests`, "policy_budget_filter_invalid", issues);
    nullablePositiveInteger(budget.tokenBudgetPerMinute, `${name}.budget.tokenBudgetPerMinute`, "policy_budget_filter_invalid", issues);
    booleanValue(budget.learnedConcurrencyEnabled, `${name}.budget.learnedConcurrencyEnabled`, "policy_budget_invalid", issues);
    positiveInteger(budget.learnedConcurrencyTtlSeconds, `${name}.budget.learnedConcurrencyTtlSeconds`, "policy_budget_filter_invalid", issues);
    positiveInteger(budget.staleInflightSeconds, `${name}.budget.staleInflightSeconds`, "policy_budget_filter_invalid", issues);
  }
}

function validateRepairPolicy(name: string, repairPolicy: Policy["response"]["repairPolicy"], issues: ValidationIssue[]): void {
  if (!isPlainRecord(repairPolicy)) {
    issues.push({ kind: "error", code: "policy_repair_invalid", message: `${name}.response.repairPolicy must be an object` });
    return;
  }
  booleanValue(repairPolicy.allowDestructiveByDefault, `${name}.response.repairPolicy.allowDestructiveByDefault`, "policy_repair_invalid", issues);
  if (repairPolicy.allowDestructiveByDefault) {
    issues.push({
      kind: "warning",
      code: "policy_destructive_repair_enabled",
      message: `${name}.response.repairPolicy.allowDestructiveByDefault enables destructive argument repair`,
    });
  }
  stringList(repairPolicy.conservativeToolPatterns, `${name}.response.repairPolicy.conservativeToolPatterns`, "policy_repair_invalid", issues);
  recordOfRecords(repairPolicy.enumAliases, `${name}.response.repairPolicy.enumAliases`, "policy_repair_invalid", issues);
  recordOfStrings(repairPolicy.toolNameAliases, `${name}.response.repairPolicy.toolNameAliases`, "policy_repair_invalid", issues);
  recordOfArrays(repairPolicy.relationalDefaults, `${name}.response.repairPolicy.relationalDefaults`, "policy_repair_invalid", issues);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sameStringList(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function positiveNumber(value: unknown, label: string, code: string, issues: ValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
    issues.push({ kind: "error", code, message: `${label} must be > 0` });
  }
}

function nonNegativeNumber(value: unknown, label: string, code: string, issues: ValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    issues.push({ kind: "error", code, message: `${label} must be >= 0` });
  }
}

function positiveInteger(value: unknown, label: string, code: string, issues: ValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    issues.push({ kind: "error", code, message: `${label} must be a positive integer` });
  }
}

function nonNegativeInteger(value: unknown, label: string, code: string, issues: ValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    issues.push({ kind: "error", code, message: `${label} must be a non-negative integer` });
  }
}

function nullablePositiveInteger(value: unknown, label: string, code: string, issues: ValidationIssue[]): void {
  if (value !== null) positiveInteger(value, label, code, issues);
}

function ratio(value: unknown, label: string, code: string, issues: ValidationIssue[]): void {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    issues.push({ kind: "error", code, message: `${label} must be between 0 and 1` });
  }
}

function booleanValue(value: unknown, label: string, code: string, issues: ValidationIssue[]): void {
  if (typeof value !== "boolean") {
    issues.push({ kind: "error", code, message: `${label} must be boolean` });
  }
}

function stringList(value: unknown, label: string, code: string, issues: ValidationIssue[]): void {
  if (!Array.isArray(value) || !value.every(isNonEmptyString)) {
    issues.push({ kind: "error", code, message: `${label} must be a list of non-empty strings` });
  }
}

function enumList<T extends string>(
  value: unknown,
  allowed: Set<T>,
  label: string,
  code: string,
  issues: ValidationIssue[],
  allowEmpty = false,
): void {
  const isArr = Array.isArray(value);
  const isEmpty = isArr && value.length === 0;
  const isAllowed = isArr && value.every((entry) => typeof entry === "string" && allowed.has(entry as T));

  if (!isArr || (!allowEmpty && isEmpty) || (!isEmpty && !isAllowed)) {
    issues.push({ kind: "error", code, message: `${label} contains unsupported values` });
  }
}

function recordOfStrings(value: unknown, label: string, code: string, issues: ValidationIssue[]): void {
  if (!isPlainRecord(value) || !Object.values(value).every((entry) => typeof entry === "string")) {
    issues.push({ kind: "error", code, message: `${label} must be an object of string values` });
  }
}

function recordOfRecords(value: unknown, label: string, code: string, issues: ValidationIssue[]): void {
  if (!isPlainRecord(value) || !Object.values(value).every(isPlainRecord)) {
    issues.push({ kind: "error", code, message: `${label} must be an object of objects` });
  }
}

function recordOfArrays(value: unknown, label: string, code: string, issues: ValidationIssue[]): void {
  if (!isPlainRecord(value) || !Object.values(value).every(Array.isArray)) {
    issues.push({ kind: "error", code, message: `${label} must be an object of arrays` });
  }
}

function isSafeProviderApiBase(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.username || url.password || url.search || url.hash) return false;
  if (url.protocol === "https:") return true;
  return url.protocol === "http:" && isLocalHttpHost(url.hostname);
}

function isLocalHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "127.0.0.1"
    || host === "0.0.0.0"
    || host === "::1"
    || host === "[::1]";
}
