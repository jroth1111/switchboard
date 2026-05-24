// Pre-routing deployment filter: evaluates candidate deployments against
// runtime state (cooldowns, circuits, inflight, learned limits, key RPM)
// to produce a partition of passed vs rejected candidates.

import type { Deployment } from "../config/schema";

// ─── State ────────────────────────────────────────────────────────

export interface FilterState {
  cooldowns: Map<string, { until: number }>;
  circuits: Map<string, { state: "open" | "half_open" | "closed" | "suspect"; halfOpenAfter?: number; failureCount?: number }>;
  inflight: Map<string, number>;
  learnedLimits: Map<string, { maxParallel: number; expiresAt?: number }>;
  keyWindows: Map<string, { windowStart: number; count: number }>;
  healthScores: Map<string, { consecutiveFailureCount?: number }>;
}

export interface FilterOptions {
  scopeMode?: "global" | "per_key";
  quarantineFailureThreshold?: number;
  suspectMaxParallelDivisor?: number;
}

export function createEmptyFilterState(): FilterState {
  return {
    cooldowns: new Map(),
    circuits: new Map(),
    inflight: new Map(),
    learnedLimits: new Map(),
    keyWindows: new Map(),
    healthScores: new Map(),
  };
}

export interface DurableHealthForFilter {
  cooldowns?: Record<string, { until?: number }>;
  circuits?: Record<string, { state?: string; halfOpenAfter?: number | null; failureCount?: number }>;
  inflight?: Record<string, { count?: number }>;
  learnedLimits?: Record<string, { maxParallel?: number; expiresAt?: number }>;
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
  options: FilterOptions = {},
): FilterResult {
  const scopeMode = options.scopeMode ?? "per_key";
  const passed: FilterResult["passed"] = [];
  const rejected: FilterResult["rejected"] = [];

  for (const deployment of candidates) {
    // Cooldown
    const cooldown = state.cooldowns.get(deployment.id);
    if (cooldown && cooldown.until > now) {
      rejected.push({ deployment, reason: "cooldown" });
      continue;
    }

    // Circuit breaker — open circuits reject until halfOpenAfter; probe windows cap concurrency at 1.
    const circuit = state.circuits.get(deployment.id);
    let halfOpenProbe = false;
    let isRecoveryState = false;
    if (circuit) {
      if (circuit.state === "open") {
        if (!circuit.halfOpenAfter || now < circuit.halfOpenAfter) {
          rejected.push({ deployment, reason: "circuit_open" });
          continue;
        }
        halfOpenProbe = true;
        isRecoveryState = true;
      } else if (circuit.state === "half_open") {
        halfOpenProbe = true;
        isRecoveryState = true;
      } else if (circuit.state === "suspect") {
        isRecoveryState = true;
      }
    }

    // Quarantine (aligned with admission-engine admit())
    const quarantineThreshold = options.quarantineFailureThreshold ?? 0;
    if (quarantineThreshold > 0 && !isRecoveryState) {
      const healthSnap = state.healthScores.get(deployment.id);
      const consecutiveFailures = healthSnap?.consecutiveFailureCount ?? 0;
      const circuitFailureCount = circuit?.failureCount ?? 0;
      if (Math.max(consecutiveFailures, circuitFailureCount) >= quarantineThreshold) {
        rejected.push({ deployment, reason: "quarantine" });
        continue;
      }
    }

    // Inflight with learned concurrency
    const learned = state.learnedLimits.get(deployment.id);
    const learnedExpired = (learned?.expiresAt !== null && learned?.expiresAt !== undefined) && learned.expiresAt <= now;
    let effectiveMax = (learned && !learnedExpired) ? learned.maxParallel : deployment.maxParallelRequests;
    if (halfOpenProbe) {
      effectiveMax = Math.min(effectiveMax, 1);
    } else if (circuit?.state === "suspect" && options.suspectMaxParallelDivisor && options.suspectMaxParallelDivisor > 0) {
      effectiveMax = Math.max(1, Math.floor(effectiveMax / options.suspectMaxParallelDivisor));
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

    passed.push({ deployment, keyRef: deployment.keyRef });
  }

  return { passed, rejected };
}

function keyWindowScope(keyRef: string, group: string, scopeMode: "global" | "per_key"): string {
  return scopeMode === "global" ? `${group}:global` : `${group}:${keyRef}`;
}
