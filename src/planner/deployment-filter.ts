// Pre-routing deployment filter: evaluates candidate deployments against
// runtime state (cooldowns, circuits, inflight, learned limits, key RPM)
// to produce a partition of passed vs rejected candidates.

import type { Deployment } from "../config/schema";

// ─── State ────────────────────────────────────────────────────────

export interface FilterState {
  cooldowns: Map<string, { until: number }>;
  circuits: Map<string, { state: "open" | "half_open" | "closed"; halfOpenAfter?: number }>;
  inflight: Map<string, number>;
  learnedLimits: Map<string, { maxParallel: number; expiresAt?: number }>;
  keyWindows: Map<string, { windowStart: number; count: number }>;
}

export function createEmptyFilterState(): FilterState {
  return {
    cooldowns: new Map(),
    circuits: new Map(),
    inflight: new Map(),
    learnedLimits: new Map(),
    keyWindows: new Map(),
  };
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

    // Inflight with learned concurrency
    const learned = state.learnedLimits.get(deployment.id);
    const learnedExpired = (learned?.expiresAt !== null && learned?.expiresAt !== undefined) && learned.expiresAt <= now;
    const effectiveMax = (learned && !learnedExpired) ? learned.maxParallel : deployment.maxParallelRequests;

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
