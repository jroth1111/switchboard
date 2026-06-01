// Pre-routing deployment filter: evaluates candidate deployments against
// runtime state (cooldowns, circuits, inflight, learned limits, key RPM)
// to produce a partition of passed vs rejected candidates.

import { keyWindowScope, tokenWindowKey } from "../config/budget-keys";
import { MANIFEST } from "../config/manifest";
import type { Deployment, Policy } from "../config/schema";
import { credentialCooldownScope } from "../credentials/types";

// ─── State ────────────────────────────────────────────────────────

export interface FilterState {
  cooldowns: Map<string, { until: number }>;
  credentialCooldowns: Map<string, { until: number }>;
  circuits: Map<string, { state: "open" | "half_open" | "closed" | "suspect"; failureCount?: number; halfOpenAfter?: number }>;
  inflight: Map<string, number>;
  learnedLimits: Map<string, { maxParallel: number; expiresAt?: number }>;
  keyWindows: Map<string, { windowStart: number; count: number }>;
  groupWindows: Map<string, { windowStart: number; count: number }>;
  tokenWindows: Map<string, { windowStart: number; promptTokens: number; completionTokens: number }>;
  healthScores: Map<string, { consecutiveFailureCount?: number }>;
}

export function createEmptyFilterState(): FilterState {
  return {
    cooldowns: new Map(),
    credentialCooldowns: new Map(),
    circuits: new Map(),
    inflight: new Map(),
    learnedLimits: new Map(),
    keyWindows: new Map(),
    groupWindows: new Map(),
    tokenWindows: new Map(),
    healthScores: new Map(),
  };
}

export interface DurableHealthForFilter {
  cooldowns?: Record<string, { until?: number }>;
  credentialCooldowns?: Record<string, { until?: number }>;
  circuits?: Record<string, { state?: string; halfOpenAfter?: number | null; failureCount?: number }>;
  inflight?: Record<string, { count?: number }>;
  learnedLimits?: Record<string, { maxParallel?: number; expiresAt?: number }>;
  keyWindows?: Record<string, { windowStart?: number; count?: number }>;
  groupWindows?: Record<string, { windowStart?: number; count?: number }>;
  tokenWindows?: Record<string, { windowStart?: number; promptTokens?: number; completionTokens?: number }>;
  healthScores?: Record<string, { consecutiveFailureCount?: number }>;
}

export function buildFilterStateFromHealth(
  health: DurableHealthForFilter | null | undefined,
): FilterState {
  const state = createEmptyFilterState();
  if (!health) return state;

  for (const [id, cooldown] of Object.entries(health.cooldowns ?? {})) {
    if (typeof cooldown?.until === "number") {
      state.cooldowns.set(id, { until: cooldown.until });
    }
  }

  for (const [scope, cooldown] of Object.entries(health.credentialCooldowns ?? {})) {
    if (typeof cooldown?.until === "number") {
      state.credentialCooldowns.set(scope, { until: cooldown.until });
    }
  }

  for (const [id, circuit] of Object.entries(health.circuits ?? {})) {
    const normalized = normalizeCircuitState(circuit?.state);
    if (!normalized) continue;
    state.circuits.set(id, {
      state: normalized,
      halfOpenAfter: circuit.halfOpenAfter ?? undefined,
      failureCount: circuit.failureCount,
    });
  }

  for (const [id, inflight] of Object.entries(health.inflight ?? {})) {
    if (typeof inflight?.count === "number") {
      state.inflight.set(id, inflight.count);
    }
  }

  for (const [id, learned] of Object.entries(health.learnedLimits ?? {})) {
    if (typeof learned?.maxParallel === "number") {
      state.learnedLimits.set(id, {
        maxParallel: learned.maxParallel,
        expiresAt: learned.expiresAt,
      });
    }
  }

  for (const [id, score] of Object.entries(health.healthScores ?? {})) {
    state.healthScores.set(id, {
      consecutiveFailureCount: score.consecutiveFailureCount,
    });
  }

  for (const [scope, window] of Object.entries(health.keyWindows ?? {})) {
    if (typeof window.windowStart === "number" && typeof window.count === "number") {
      state.keyWindows.set(scope, { windowStart: window.windowStart, count: window.count });
    }
  }

  for (const [group, window] of Object.entries(health.groupWindows ?? {})) {
    if (typeof window.windowStart === "number" && typeof window.count === "number") {
      state.groupWindows.set(group, { windowStart: window.windowStart, count: window.count });
    }
  }

  for (const [keyRef, window] of Object.entries(health.tokenWindows ?? {})) {
    if (
      typeof window.windowStart === "number"
      && (typeof window.promptTokens === "number" || typeof window.completionTokens === "number")
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

function normalizeCircuitState(
  state: string | undefined,
): "open" | "half_open" | "closed" | "suspect" | null {
  if (state === "open" || state === "half_open" || state === "closed" || state === "suspect") {
    return state;
  }
  return null;
}

// ─── Result ───────────────────────────────────────────────────────

export interface FilterResult {
  passed: Array<{ deployment: Deployment; keyRef: string }>;
  rejected: Array<{ deployment: Deployment; reason: string }>;
}

// ─── Filter ───────────────────────────────────────────────────────

export function filterCandidates(
  candidates: Deployment[],
  state: FilterState,
  now: number,
  scopeMode: "global" | "per_key" = "per_key",
  options: {
    maxParallelOverride?: number | null;
    quarantineFailureThreshold?: number;
    suspectMaxParallelDivisor?: number;
    rpmLimit?: number | null;
    tokenBudgetPerMinute?: number | null;
    credentialIdsByDeployment?: Map<string, string[]>;
  } = {},
): FilterResult {
  const passed: FilterResult["passed"] = [];
  const rejected: FilterResult["rejected"] = [];

  for (const deployment of candidates) {
    // Cooldown
    const cooldown = state.cooldowns.get(deployment.id);
    if (cooldown && cooldown.until > now) {
      rejected.push({ deployment, reason: "cooldown" });
      continue;
    }

    const credentialIds = options.credentialIdsByDeployment?.get(deployment.id);
    if (credentialIds && credentialIds.length > 0 && !deployment.credentialOptional) {
      const anyAvailable = credentialIds.some((credentialId) => {
        const scope = credentialCooldownScope(credentialId);
        const credCooldown = state.credentialCooldowns.get(scope);
        return !credCooldown || credCooldown.until <= now;
      });
      if (!anyAvailable) {
        rejected.push({ deployment, reason: "credential_pool_exhausted" });
        continue;
      }
    }

    // Circuit breaker
    const circuit = state.circuits.get(deployment.id);
    if (circuit) {
      if (circuit.state === "open") {
        if (!circuit.halfOpenAfter || now < circuit.halfOpenAfter) {
          rejected.push({ deployment, reason: "circuit_open" });
          continue;
        }
      }
    }

    const inHalfOpenRecovery =
      circuit?.state === "open" && circuit.halfOpenAfter !== undefined && circuit.halfOpenAfter <= now;
    const isRecoveryState = circuit && (circuit.state === "half_open" || circuit.state === "suspect" || inHalfOpenRecovery);
    if ((options.quarantineFailureThreshold ?? 0) > 0 && !isRecoveryState) {
      const consecutiveFailures = state.healthScores.get(deployment.id)?.consecutiveFailureCount ?? 0;
      const circuitFailures = circuit?.failureCount ?? 0;
      if (Math.max(consecutiveFailures, circuitFailures) >= options.quarantineFailureThreshold!) {
        rejected.push({ deployment, reason: "quarantine" });
        continue;
      }
    }

    // Inflight with learned concurrency
    const learned = state.learnedLimits.get(deployment.id);
    const learnedExpired = (learned?.expiresAt !== null && learned?.expiresAt !== undefined) && learned.expiresAt <= now;
    let effectiveMax = (learned && !learnedExpired) ? learned.maxParallel : deployment.maxParallelRequests;
    if ((options.maxParallelOverride ?? 0) > 0) {
      effectiveMax = Math.min(effectiveMax, options.maxParallelOverride!);
    }
    if (circuit?.state === "half_open" || inHalfOpenRecovery) {
      effectiveMax = 1;
    } else if (circuit?.state === "suspect" && (options.suspectMaxParallelDivisor ?? 0) > 0) {
      effectiveMax = Math.max(1, Math.floor(effectiveMax / options.suspectMaxParallelDivisor!));
    }

    const currentInflight = state.inflight.get(deployment.id) ?? 0;
    if (currentInflight >= effectiveMax) {
      rejected.push({ deployment, reason: "inflight_exhausted" });
      continue;
    }

    // Key RPM — check if any stored window overlaps the current 60-second period
    const keyWindow = state.keyWindows.get(keyWindowScope(deployment.keyRef, deployment.group, scopeMode));
    if (keyWindow) {
      const windowEnd = keyWindow.windowStart + 60000;
      if (windowEnd > now && keyWindow.count >= deployment.rpm) {
        rejected.push({ deployment, reason: "key_rpm_exhausted" });
        continue;
      }
    }

    if ((options.rpmLimit ?? 0) > 0) {
      const groupWindow = state.groupWindows.get(deployment.group);
      if (groupWindow) {
        const windowEnd = groupWindow.windowStart + 60000;
        if (windowEnd > now && groupWindow.count >= options.rpmLimit!) {
          rejected.push({ deployment, reason: "group_rpm_exhausted" });
          continue;
        }
      }
    }

    if ((options.tokenBudgetPerMinute ?? 0) > 0) {
      const tokenWindow = state.tokenWindows.get(
        tokenWindowKey(deployment.keyRef, deployment.group, scopeMode),
      );
      if (tokenWindow) {
        const windowEnd = tokenWindow.windowStart + 60000;
        const used = tokenWindow.promptTokens + tokenWindow.completionTokens;
        if (windowEnd > now && used >= options.tokenBudgetPerMinute!) {
          rejected.push({ deployment, reason: "token_budget_exhausted" });
          continue;
        }
      }
    }

    passed.push({ deployment, keyRef: deployment.keyRef });
  }

  return { passed, rejected };
}

export function policyForDeploymentGroup(group: string): Policy {
  return MANIFEST.policies[group] ?? MANIFEST.defaultPolicy;
}

export function filterOptionsForPolicy(policy: Policy) {
  return {
    maxParallelOverride: policy.budget.maxParallelRequests,
    quarantineFailureThreshold: policy.health.circuitFailureThreshold,
    suspectMaxParallelDivisor: policy.health.suspectMaxParallelDivisor,
    rpmLimit: policy.budget.rpmLimit,
    tokenBudgetPerMinute: policy.budget.tokenBudgetPerMinute,
  };
}
