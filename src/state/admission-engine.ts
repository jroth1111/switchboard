// Unified admission engine: single authoritative implementation of
// admission, circuit breaking, health scoring, and rate budgeting.
// Delegates storage to StorageAdapter (SQL in production, Maps in tests).

import type { StorageAdapter, HealthScoreRow, CircuitRow, RecentOutcome } from "./storage-adapter";
import type { FailureClass } from "../config/schema";
import { RESERVATION_TTL_MS, LEARNED_CONCURRENCY_TTL_MS } from "../config/constants";

const EMA_BOOST_FACTOR = 0.3;
const EMA_DECAY_FACTOR = 0.7;
const RECENT_OUTCOME_CAP = 50;
const LATENCY_HISTORY_CAP = 50;
const IDLE_DECAY_HALF_LIFE_MS = 600_000;
const BURST_DEDUP_WINDOW_MS = 5_000;

// ─── Exported analytics helpers ───────────────────────────────────

export function decayedScore(score: number, updatedAtMs: number, nowMs: number): number {
  const dt = Math.max(0, nowMs - updatedAtMs);
  if (dt < 1000) return score;
  const k = Math.LN2 / IDLE_DECAY_HALF_LIFE_MS;
  return score + (100 - score) * (1 - Math.exp(-k * dt));
}

export function computeP95(samples: number[]): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const idx = Math.min(Math.ceil(sorted.length * 0.95) - 1, sorted.length - 1);
  return sorted[idx];
}

export function computeAdaptiveDeadlineMs(
  latencyEmaMs: number | null | undefined,
  latencySampleCount: number,
  warmupSamples: number,
  baseDeadlineMs: number,
): number {
  if (!latencyEmaMs || latencySampleCount < warmupSamples) return baseDeadlineMs;
  const adaptive = latencyEmaMs * 3.0;
  return Math.min(Math.max(adaptive, 5_000), baseDeadlineMs * 3.0);
}

export function computeRollingMetrics(recentOutcomes: RecentOutcome[]): RollingDeploymentMetrics {
  const n = recentOutcomes.length;
  if (n === 0) {
    return { recentOutcomeCount: 0, recentFailureRate: 0, timeoutRate: 0, invalidSuccessRate: 0, p95FirstByteLatencyMs: null, p95TotalLatencyMs: null };
  }
  let failures = 0; let timeouts = 0; let invalidSuccesses = 0;
  const fbLat: number[] = []; const totLat: number[] = [];
  for (const o of recentOutcomes) {
    if (o.outcome === "failure") failures++;
    if (o.timeout) timeouts++;
    if (o.invalidSuccess) invalidSuccesses++;
    if ((o.firstByteLatencyMs !== null && o.firstByteLatencyMs !== undefined)) fbLat.push(o.firstByteLatencyMs);
    if ((o.latencyMs !== null && o.latencyMs !== undefined)) totLat.push(o.latencyMs);
  }
  return {
    recentOutcomeCount: n,
    recentFailureRate: failures / n,
    timeoutRate: timeouts / n,
    invalidSuccessRate: invalidSuccesses / n,
    p95FirstByteLatencyMs: computeP95(fbLat),
    p95TotalLatencyMs: computeP95(totLat),
  };
}

// ─── Types ────────────────────────────────────────────────────────

export interface AdmissionRequest {
  requestId: string;
  candidates: Array<{
    deploymentId: string;
    keyRef: string;
    rpm: number;
    maxParallel: number;
    group: string;
  }>;
  rpmLimit?: number | null;
  staleInflightSeconds?: number;
  halfOpenPenalty?: number;
  maxParallelOverride?: number | null;
  scopeMode?: "global" | "per_key";
  learnedConcurrencyEnabled?: boolean;
  learnedConcurrencyTtlSeconds?: number;
  quarantineFailureThreshold?: number;
  suspectThresholdFraction?: number;
  suspectMaxParallelDivisor?: number;
  tokenBudgetPerMinute?: number | null;
}

export interface AdmissionResponse {
  admitted: boolean;
  deploymentId?: string;
  keyRef?: string;
  reservationId?: string;
  inflightAtDispatch?: number;
  effectiveMaxParallel?: number;
  reason?: string;
  rejected?: Array<{ deploymentId: string; reason: string }>;
}

export interface RecordSuccessOptions {
  firstByteLatencyMs?: number;
  inflightAtDispatch?: number;
}

export interface RecordFailureOptions {
  inflightAtDispatch?: number;
  maxParallelAtDispatch?: number;
  semanticSeverity?: "low" | "medium" | "high";
  transportCooldownThreshold?: number;
}

export interface RollingDeploymentMetrics {
  recentOutcomeCount: number;
  recentFailureRate: number;
  timeoutRate: number;
  invalidSuccessRate: number;
  p95FirstByteLatencyMs: number | null;
  p95TotalLatencyMs: number | null;
}

// ─── Admission ────────────────────────────────────────────────────

export function admit(
  store: StorageAdapter,
  req: AdmissionRequest,
): AdmissionResponse {
  const now = Date.now();
  const rpmCutoff = now - 60_000;
  const bucketStart = Math.floor(now / 1000) * 1000;
  const rejected: Array<{ deploymentId: string; reason: string }> = [];

  if (req.candidates.length === 0) {
    return { admitted: false, reason: "no_candidates", rejected: [] };
  }

  // Prune stale windows
  store.pruneKeyWindows(rpmCutoff);

  // Reap stale inflight entries
  if (req.staleInflightSeconds && req.staleInflightSeconds > 0) {
    store.pruneStaleInflight(now - req.staleInflightSeconds * 1000);
  }

  const scopeMode = req.scopeMode ?? "per_key";

  for (const candidate of req.candidates) {
    const windowKeyRef = keyWindowScope(candidate.keyRef, candidate.group, scopeMode);

    // Check cooldown
    if (store.getCooldown(candidate.deploymentId, now)) {
      rejected.push({ deploymentId: candidate.deploymentId, reason: "cooldown" });
      continue;
    }

    // Check circuit
    let circuit = store.getCircuit(candidate.deploymentId);
    if (circuit) {
      if (circuit.state === "open" && (!circuit.halfOpenAfter || now < circuit.halfOpenAfter)) {
        rejected.push({ deploymentId: candidate.deploymentId, reason: "circuit_open" });
        continue;
      } else if (circuit.state === "open") {
        circuit = { ...circuit, state: "half_open", successCount: 0, updatedAt: now };
        store.setCircuit(candidate.deploymentId, circuit);
        // Zero out stale unconfirmed inflight — confirmed reservations will decrement via
        // release() which clamps to 0, so this doesn't lose active request tracking.
        // Unconfirmed reservations that expired will be reaped by reapExpired.
        store.setInflight(candidate.deploymentId, 0, now);
      }
    }

    // Check quarantine — skip for half_open/suspect circuits that need recovery probes
    const isRecoveryState = circuit && ["half_open", "suspect"].includes(circuit.state || "");
    if (req.quarantineFailureThreshold && req.quarantineFailureThreshold > 0 && !isRecoveryState) {
      const healthSnap = store.getHealthScore(candidate.deploymentId);
      const consecutiveFailures = healthSnap?.consecutiveFailureCount ?? 0;
      const circuitFailureCount = circuit?.failureCount ?? 0;
      if (Math.max(consecutiveFailures, circuitFailureCount) >= req.quarantineFailureThreshold) {
        rejected.push({ deploymentId: candidate.deploymentId, reason: "quarantine" });
        continue;
      }
    }

    // Check learned concurrency limit
    const learned = store.getLearnedLimit(candidate.deploymentId, now);
    let effectiveMaxParallel = (learned !== null && learned !== undefined) ? learned.maxParallel : candidate.maxParallel;

    // Apply policy-level max parallel override
    if (req.maxParallelOverride && req.maxParallelOverride > 0) {
      effectiveMaxParallel = Math.min(effectiveMaxParallel, req.maxParallelOverride);
    }

    // Apply half-open penalty
    const isHalfOpen = circuit && circuit.state === "half_open";
    const isSuspect = circuit && circuit.state === "suspect";
    let effectiveMax = effectiveMaxParallel;
    if (isHalfOpen) {
      // Half-open allows exactly 1 concurrent probe request
      effectiveMax = 1;
    } else if (isSuspect && req.suspectMaxParallelDivisor && req.suspectMaxParallelDivisor > 0) {
      effectiveMax = Math.max(1, Math.floor(effectiveMaxParallel / req.suspectMaxParallelDivisor));
    }

    // Check inflight
    const currentInflight = store.getInflight(candidate.deploymentId);
    if (currentInflight >= effectiveMax) {
      rejected.push({ deploymentId: candidate.deploymentId, reason: "inflight_exhausted" });
      continue;
    }

    // Check key RPM
    {
      const currentRpm = store.getKeyRpm(windowKeyRef, rpmCutoff);
      if (currentRpm >= candidate.rpm) {
        rejected.push({ deploymentId: candidate.deploymentId, reason: "key_rpm_exhausted" });
        continue;
      }
    }

    // Check group-level RPM limit
    if (req.rpmLimit && req.rpmLimit > 0) {
      const groupRpm = store.getGroupRpm(candidate.group, rpmCutoff);
      if (groupRpm >= req.rpmLimit) {
        rejected.push({ deploymentId: candidate.deploymentId, reason: "group_rpm_exhausted" });
        continue;
      }
    }

    // Check token budget (per-minute token spend across this key)
    if (req.tokenBudgetPerMinute && req.tokenBudgetPerMinute > 0) {
      const used = store.getTokenUsage(candidate.keyRef, rpmCutoff);
      if (used >= req.tokenBudgetPerMinute) {
        rejected.push({ deploymentId: candidate.deploymentId, reason: "token_budget_exhausted" });
        continue;
      }
    }

    // Admit — create reservation atomically so a partial-write failure doesn't
    // leave inflight inflated with no corresponding reservation to release it.
    const reservationId = `${req.requestId}:${candidate.deploymentId}:${now}`;
    const inflightAtDispatch = currentInflight + 1;
    store.transaction(() => {
      store.insertReservation({
        reservationId, keyRef: candidate.keyRef, deploymentId: candidate.deploymentId,
        requestId: req.requestId, createdAt: now, expiresAt: now + RESERVATION_TTL_MS,
      });
      store.setInflight(candidate.deploymentId, inflightAtDispatch, now);
      store.incrementKeyWindow(windowKeyRef, bucketStart);
      store.incrementGroupWindow(candidate.group, bucketStart);
    });

    return {
      admitted: true,
      deploymentId: candidate.deploymentId,
      keyRef: candidate.keyRef,
      reservationId,
      inflightAtDispatch,
      effectiveMaxParallel: effectiveMax,
    };
  }

  return { admitted: false, reason: "all_candidates_rejected", rejected };
}

// ─── Release ──────────────────────────────────────────────────────

export function release(store: StorageAdapter, reservationId: string): void {
  // Atomic: if a crash occurs between deleteReservation and setInflight,
  // the reservation is gone but inflight remains elevated. The transaction
  // ensures both succeed or both are rolled back.
  store.transaction(() => {
    const res = store.deleteReservation(reservationId);
    if (!res) return;
    const current = store.getInflight(res.deploymentId);
    store.setInflight(res.deploymentId, Math.max(0, current - 1), Date.now());
  });
}

// ─── Record success ──────────────────────────────────────────────

export function recordSuccess(
  store: StorageAdapter,
  deploymentId: string,
  circuitSuccessThreshold: number = 3,
  durationMs?: number,
  latencyConfig?: { emaAlpha?: number; penaltyFactor?: number; warmupSamples?: number },
  learnedConcurrencyEnabled = false,
  learnedConcurrencyTtlSeconds = 300,
  options: RecordSuccessOptions = {},
): void {
  const now = Date.now();
  const existing = store.getHealthScore(deploymentId);
  const currentScore = existing?.score ?? 100;
  let newScore = currentScore + (100 - currentScore) * EMA_BOOST_FACTOR;
  const successCount = (existing?.successCount ?? 0) + 1;
  const failureCount = existing?.failureCount ?? 0;

  // Latency-aware scoring
  let latencyEmaMs: number | null = existing?.latencyEmaMs ?? null;
  let latencySampleCount = existing?.latencySampleCount ?? 0;
  if ((durationMs !== null && durationMs !== undefined)) {
    const currentLatencyEma = existing?.latencyEmaMs ?? null;
    latencySampleCount = (existing?.latencySampleCount ?? 0) + 1;
    const alpha = latencyConfig?.emaAlpha ?? 0.3;
    latencyEmaMs = (currentLatencyEma === null || currentLatencyEma === undefined) ? durationMs : currentLatencyEma + alpha * (durationMs - currentLatencyEma);
    if (latencySampleCount >= (latencyConfig?.warmupSamples ?? 5) && (currentLatencyEma !== null && currentLatencyEma !== undefined) && currentLatencyEma > 0) {
      const ratio = durationMs / currentLatencyEma;
      if (ratio > 1.0) {
        newScore = Math.max(0, newScore - (ratio - 1.0) * (latencyConfig?.penaltyFactor ?? 5.0));
      }
    }
  }
  const recentOutcomes = appendRecentOutcome(existing?.recentOutcomes, {
    outcome: "success",
    atMs: now,
    latencyMs: durationMs,
    firstByteLatencyMs: options.firstByteLatencyMs,
    inflightAtDispatch: options.inflightAtDispatch,
  });
  const totalLatencyHistoryMs = (durationMs !== null && durationMs !== undefined)
    ? appendBoundedNumber(existing?.totalLatencyHistoryMs, durationMs, LATENCY_HISTORY_CAP)
    : existing?.totalLatencyHistoryMs ?? [];
  const firstByteLatencyHistoryMs = (options.firstByteLatencyMs !== null && options.firstByteLatencyMs !== undefined)
    ? appendBoundedNumber(existing?.firstByteLatencyHistoryMs, options.firstByteLatencyMs, LATENCY_HISTORY_CAP)
    : existing?.firstByteLatencyHistoryMs ?? [];

  store.setHealthScore(deploymentId, {
    score: newScore,
    lastSuccessAt: now,
    lastFailureAt: existing?.lastFailureAt ?? null,
    failureClass: existing?.failureClass ?? null,
    updatedAt: now,
    successCount,
    failureCount,
    consecutiveFailureCount: 0,
    latencyEmaMs,
    latencySampleCount,
    recentOutcomes,
    firstByteLatencyHistoryMs,
    totalLatencyHistoryMs,
  });

  // Circuit recovery
  const circuit = store.getCircuit(deploymentId);
  if (circuit) {
    const newSuccessCount = circuit.successCount + 1;
    if (circuit.state === "half_open" && newSuccessCount >= circuitSuccessThreshold) {
      store.setCircuit(deploymentId, {
        state: "closed", failureCount: 0, successCount: newSuccessCount, updatedAt: now,
      });
    } else if (circuit.state === "suspect") {
      store.setCircuit(deploymentId, {
        state: "closed", failureCount: 0, successCount: newSuccessCount, updatedAt: now,
      });
    } else if (circuit.state === "half_open") {
      // Probe successes below threshold: count progress only; do not decay failureCount.
      store.setCircuit(deploymentId, {
        ...circuit, successCount: newSuccessCount, updatedAt: now,
      });
    } else {
      // In closed state, decrement failureCount by 1 (floor 0) rather than zeroing it.
      // Zeroing on every success lets a flaky endpoint (4 failures, 1 success) avoid
      // ever tripping the circuit breaker.
      store.setCircuit(deploymentId, {
        ...circuit, successCount: newSuccessCount,
        failureCount: Math.max(0, circuit.failureCount - 1), updatedAt: now,
      });
    }
  }

  // Learned concurrency: additive increase
  if (learnedConcurrencyEnabled) {
    const learned = store.getLearnedLimit(deploymentId, now);
    if ((learned !== null && learned !== undefined)) {
      const newLimit = learned.maxParallel + 1;
      store.setLearnedLimit(deploymentId, {
        maxParallel: newLimit, reason: "learned:success",
        expiresAt: now + learnedConcurrencyTtlSeconds * 1000,
      });
    }
  }
}

// ─── Record failure ──────────────────────────────────────────────

export function recordFailure(
  store: StorageAdapter,
  deploymentId: string,
  failureClass: FailureClass,
  cooldownSeconds: number,
  circuitThreshold: number,
  circuitDurationSeconds: number,
  suspectThresholdFraction?: number,
  learnedConcurrencyEnabled = false,
  learnedConcurrencyTtlSeconds = 300,
  options: RecordFailureOptions = {},
): void {
  const now = Date.now();

  if (isHealthNeutralFailure(failureClass)) {
    if (cooldownSeconds > 0) {
      store.setCooldown(deploymentId, failureClass, now + cooldownSeconds * 1000,
        JSON.stringify({ failureClass, healthNeutral: true }));
    }
    return;
  }

  const existing = store.getHealthScore(deploymentId);
  const disposition = failureDisposition(failureClass);
  if (disposition.kind === "pressure") {
    const pressure = recordPressureOutcome(store, deploymentId, failureClass, existing, now, options, disposition);
    const cooldownFailureCount = disposition.countsTowardRouteFailure
      ? pressure.consecutiveFailureCount
      : recentFailureClassStreak(pressure.recentOutcomes, failureClass);
    maybeSetFailureCooldown(store, deploymentId, failureClass, cooldownSeconds, now, cooldownFailureCount, options);
    applyPressureCircuitDisposition(
      store,
      deploymentId,
      failureClass,
      disposition.circuit,
      pressure.consecutiveFailureCount,
      now,
      circuitThreshold,
      circuitDurationSeconds,
      suspectThresholdFraction,
      options,
    );
    updatePressureLearnedConcurrency(
      store,
      deploymentId,
      failureClass,
      now,
      learnedConcurrencyTtlSeconds,
      options,
    );
    return;
  }

  // EMA decay
  const currentScore = existing?.score ?? 100;
  const penaltyWeight = failurePenaltyWeight(failureClass, options);
  // Reduce penalty for burst duplicates: same failure class within dedup window
  const isBurstDuplicate = existing?.failureClass === failureClass
    && typeof existing?.lastFailureAt === "number"
    && (now - existing.lastFailureAt) < BURST_DEDUP_WINDOW_MS;
  const effectivePenaltyWeight = isBurstDuplicate ? penaltyWeight * 0.1 : penaltyWeight;
  const newScore = currentScore * (EMA_DECAY_FACTOR ** effectivePenaltyWeight);
  const successCount = existing?.successCount ?? 0;
  const failureCount = (existing?.failureCount ?? 0) + 1;
  const consecutiveFailureCount = (existing?.consecutiveFailureCount ?? 0) + 1;
  const recentOutcomes = appendRecentOutcome(existing?.recentOutcomes, {
    outcome: "failure",
    atMs: now,
    failureClass,
    timeout: failureClass === "transport_timeout",
    invalidSuccess: isInvalidSuccessFailure(failureClass),
    semanticSeverity: options.semanticSeverity,
    inflightAtDispatch: options.inflightAtDispatch,
  });

  store.setHealthScore(deploymentId, {
    score: newScore,
    lastSuccessAt: existing?.lastSuccessAt ?? null,
    lastFailureAt: now,
    failureClass,
    updatedAt: now,
    successCount,
    failureCount,
    consecutiveFailureCount,
    latencyEmaMs: existing?.latencyEmaMs ?? null,
    latencySampleCount: existing?.latencySampleCount ?? 0,
    recentOutcomes,
    firstByteLatencyHistoryMs: existing?.firstByteLatencyHistoryMs ?? [],
    totalLatencyHistoryMs: existing?.totalLatencyHistoryMs ?? [],
  });

  maybeSetFailureCooldown(store, deploymentId, failureClass, cooldownSeconds, now, consecutiveFailureCount, options);
  recordCircuitFailure(
    store,
    deploymentId,
    now,
    circuitThreshold,
    circuitDurationSeconds,
    suspectThresholdFraction,
  );

  updateGenericLearnedConcurrency(
    store,
    deploymentId,
    failureClass,
    now,
    learnedConcurrencyEnabled,
    learnedConcurrencyTtlSeconds,
  );
}

// ─── Health check ─────────────────────────────────────────────────

export function isHealthNeutralFailure(failureClass: string): boolean {
  return [
    "auth_failure",
    "oauth_session_failure",
    "oauth_refresh_failure",
    "subscription_limit",
    "client_4xx_bad_request",
    "client_4xx",
    "context_length_exceeded",
    "invalid_model",
  ].includes(failureClass);
}

type PressureCircuitDisposition = "none" | "threshold" | "suspect";

type FailureDisposition =
  | { kind: "pressure"; circuit: PressureCircuitDisposition; countsTowardRouteFailure: boolean }
  | { kind: "route_failure" };

function failureDisposition(failureClass: FailureClass): FailureDisposition {
  if (
    failureClass === "rate_limit_overload" ||
    failureClass === "rate_limit_concurrency" ||
    failureClass === "rate_limit_concurrency_ambiguous"
  ) {
    return { kind: "pressure", circuit: "none", countsTowardRouteFailure: false };
  }

  if (
    failureClass === "rate_limit_quota_window" ||
    failureClass === "transport_timeout" ||
    failureClass === "transport_error" ||
    failureClass === "stream_interruption"
  ) {
    return { kind: "pressure", circuit: "none", countsTowardRouteFailure: false };
  }

  if (isInvalidSuccessFailure(failureClass)) {
    return { kind: "pressure", circuit: "suspect", countsTowardRouteFailure: true };
  }

  return { kind: "route_failure" };
}

function recordPressureOutcome(
  store: StorageAdapter,
  deploymentId: string,
  failureClass: FailureClass,
  existing: HealthScoreRow | null,
  now: number,
  options: RecordFailureOptions,
  disposition: FailureDisposition & { kind: "pressure" },
): HealthScoreRow {
  const consecutiveFailureCount = disposition.countsTowardRouteFailure
    ? (existing?.consecutiveFailureCount ?? 0) + 1
    : existing?.consecutiveFailureCount ?? 0;
  const row: HealthScoreRow = {
    score: existing?.score ?? 100,
    lastSuccessAt: existing?.lastSuccessAt ?? null,
    lastFailureAt: now,
    failureClass,
    updatedAt: now,
    successCount: existing?.successCount ?? 0,
    failureCount: (existing?.failureCount ?? 0) + 1,
    consecutiveFailureCount,
    latencyEmaMs: existing?.latencyEmaMs ?? null,
    latencySampleCount: existing?.latencySampleCount ?? 0,
    recentOutcomes: appendRecentOutcome(existing?.recentOutcomes, {
      outcome: "failure",
      atMs: now,
      failureClass,
      timeout: failureClass === "transport_timeout",
      invalidSuccess: isInvalidSuccessFailure(failureClass),
      semanticSeverity: options.semanticSeverity,
      inflightAtDispatch: options.inflightAtDispatch,
    }),
    firstByteLatencyHistoryMs: existing?.firstByteLatencyHistoryMs ?? [],
    totalLatencyHistoryMs: existing?.totalLatencyHistoryMs ?? [],
  };
  store.setHealthScore(deploymentId, row);
  return row;
}

function maybeSetFailureCooldown(
  store: StorageAdapter,
  deploymentId: string,
  failureClass: FailureClass,
  cooldownSeconds: number,
  now: number,
  consecutiveFailureCount: number,
  options: RecordFailureOptions,
): void {
  if (cooldownSeconds <= 0) return;
  if (isBelowTransportCooldownThreshold(failureClass, consecutiveFailureCount, options)) return;
  store.setCooldown(deploymentId, failureClass, now + cooldownSeconds * 1000,
    JSON.stringify({ failureClass }));
}

function isBelowTransportCooldownThreshold(
  failureClass: FailureClass,
  consecutiveFailureCount: number,
  options: RecordFailureOptions,
): boolean {
  const isTransportClass = failureClass === "transport_error" || failureClass === "transport_timeout" || failureClass === "server_5xx";
  return isTransportClass
    && typeof options.transportCooldownThreshold === "number"
    && options.transportCooldownThreshold > 0
    && consecutiveFailureCount < options.transportCooldownThreshold;
}

function applyPressureCircuitDisposition(
  store: StorageAdapter,
  deploymentId: string,
  failureClass: FailureClass,
  disposition: PressureCircuitDisposition,
  consecutiveFailureCount: number,
  now: number,
  circuitThreshold: number,
  circuitDurationSeconds: number,
  suspectThresholdFraction: number | undefined,
  options: RecordFailureOptions,
): void {
  if (disposition === "none") return;

  const threshold = pressureCircuitThreshold(failureClass, circuitThreshold, options);
  if (disposition === "threshold") {
    if (consecutiveFailureCount < threshold) return;
    recordCircuitFailure(
      store,
      deploymentId,
      now,
      circuitThreshold,
      circuitDurationSeconds,
      suspectThresholdFraction,
      consecutiveFailureCount,
    );
    return;
  }

  setSuspectCircuit(store, deploymentId, now, consecutiveFailureCount);
}

function pressureCircuitThreshold(
  failureClass: FailureClass,
  circuitThreshold: number,
  options: RecordFailureOptions,
): number {
  if (failureClass === "transport_timeout" || failureClass === "transport_error") {
    return Math.max(2, options.transportCooldownThreshold ?? 0);
  }
  return Math.max(2, circuitThreshold);
}

function setSuspectCircuit(
  store: StorageAdapter,
  deploymentId: string,
  now: number,
  observedFailureCount: number,
): void {
  const circuit = store.getCircuit(deploymentId);
  if (circuit?.state === "open") return;
  store.setCircuit(deploymentId, {
    state: "suspect",
    failureCount: Math.max(circuit?.failureCount ?? 0, observedFailureCount),
    successCount: 0,
    updatedAt: now,
  });
}

function recordCircuitFailure(
  store: StorageAdapter,
  deploymentId: string,
  now: number,
  circuitThreshold: number,
  circuitDurationSeconds: number,
  suspectThresholdFraction?: number,
  observedFailureCount?: number,
): void {
  const circuit = store.getCircuit(deploymentId);
  const currentFailures = circuit?.failureCount ?? 0;
  const currentState = circuit?.state ?? "closed";
  const nextFailureCount = Math.max(currentFailures + 1, observedFailureCount ?? 0);

  if (currentState === "half_open") {
    store.setCircuit(deploymentId, {
      state: "open", failureCount: nextFailureCount, successCount: 0,
      openedAt: now, halfOpenAfter: now + circuitDurationSeconds * 1000, updatedAt: now,
    });
  } else if (nextFailureCount >= circuitThreshold) {
    store.setCircuit(deploymentId, {
      state: "open", failureCount: nextFailureCount, successCount: 0,
      openedAt: now, halfOpenAfter: now + circuitDurationSeconds * 1000, updatedAt: now,
    });
  } else if (currentState === "closed" && nextFailureCount >= Math.floor(circuitThreshold * (suspectThresholdFraction ?? 0.6))) {
    store.setCircuit(deploymentId, {
      state: "suspect", failureCount: nextFailureCount, successCount: 0, updatedAt: now,
    });
  } else if (currentState === "suspect") {
    store.setCircuit(deploymentId, {
      state: "suspect", failureCount: nextFailureCount, successCount: 0, updatedAt: now,
    });
  } else {
    store.setCircuit(deploymentId, {
      state: currentState, failureCount: nextFailureCount, successCount: 0, updatedAt: now,
    });
  }
}

function updatePressureLearnedConcurrency(
  store: StorageAdapter,
  deploymentId: string,
  failureClass: FailureClass,
  now: number,
  learnedConcurrencyTtlSeconds: number,
  options: RecordFailureOptions,
): void {
  if (failureClass !== "rate_limit_concurrency" && failureClass !== "rate_limit_concurrency_ambiguous") return;

  const learned = store.getLearnedLimit(deploymentId, now);
  const baseline = Math.max(
    learned?.maxParallel ?? 0,
    options.maxParallelAtDispatch ?? 0,
    options.inflightAtDispatch ?? 0,
    store.getInflight(deploymentId),
  );
  const newLimit = Math.max(1, baseline > 1 ? Math.floor(baseline / 2) : 1);
  const ttlMs = learnedConcurrencyTtlSeconds > 0
    ? learnedConcurrencyTtlSeconds * 1000
    : LEARNED_CONCURRENCY_TTL_MS;
  store.setLearnedLimit(deploymentId, {
    maxParallel: newLimit,
    reason: failureClass,
    expiresAt: now + ttlMs,
  });
}

function updateGenericLearnedConcurrency(
  store: StorageAdapter,
  deploymentId: string,
  failureClass: FailureClass,
  now: number,
  learnedConcurrencyEnabled: boolean,
  learnedConcurrencyTtlSeconds: number,
): void {
  if (!learnedConcurrencyEnabled) return;

  const learned = store.getLearnedLimit(deploymentId, now);
  const currentLimit = learned?.maxParallel ?? 0;
  if (currentLimit <= 1) return;
  const newLimit = Math.max(1, Math.floor(currentLimit / 2));
  store.setLearnedLimit(deploymentId, {
    maxParallel: newLimit, reason: `learned:${failureClass}`,
    expiresAt: now + learnedConcurrencyTtlSeconds * 1000,
  });
}

function recentFailureClassStreak(recentOutcomes: RecentOutcome[] | undefined, failureClass: FailureClass): number {
  let count = 0;
  for (let i = (recentOutcomes?.length ?? 0) - 1; i >= 0; i--) {
    const outcome = recentOutcomes![i];
    if (outcome.outcome !== "failure" || outcome.failureClass !== failureClass) break;
    count++;
  }
  return count;
}

function keyWindowScope(keyRef: string, group: string, scopeMode: "global" | "per_key"): string {
  return scopeMode === "global" ? `${group}:global` : `${group}:${keyRef}`;
}

function appendRecentOutcome(existing: RecentOutcome[] | undefined, outcome: RecentOutcome): RecentOutcome[] {
  return [...(existing ?? []), outcome].slice(-RECENT_OUTCOME_CAP);
}

function appendBoundedNumber(existing: number[] | undefined, value: number, cap: number): number[] {
  return [...(existing ?? []), value].slice(-cap);
}

function failurePenaltyWeight(failureClass: FailureClass, options: RecordFailureOptions): number {
  let weight = options.semanticSeverity ? semanticSeverityWeight(options.semanticSeverity) : 1;
  if (failureClass === "transport_timeout") weight = Math.max(weight, 3);
  else if (failureClass === "server_5xx" || failureClass === "transport_error") weight = Math.max(weight, 2);
  else if (isInvalidSuccessFailure(failureClass)) weight = Math.max(weight, 1);

  if (
    (options.inflightAtDispatch !== null && options.inflightAtDispatch !== undefined) &&
    (options.maxParallelAtDispatch !== null && options.maxParallelAtDispatch !== undefined) &&
    options.maxParallelAtDispatch > 0 &&
    options.inflightAtDispatch >= options.maxParallelAtDispatch
  ) {
    weight *= 0.25;
  }
  return weight;
}

function semanticSeverityWeight(severity: "low" | "medium" | "high"): number {
  if (severity === "high") return 3;
  if (severity === "medium") return 2;
  return 1;
}

function isInvalidSuccessFailure(failureClass: string): boolean {
  return [
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
  ].includes(failureClass);
}

// ─── Deployment penalty scoring ───────────────────────────────────

export interface HealthSnapshot {
  score: number;
  lastSuccessAt?: number;
  lastFailureAt?: number;
  failureClass?: string;
  updatedAt: number;
  successCount: number;
  failureCount: number;
  consecutiveFailureCount: number;
  latencyEmaMs?: number | null;
  latencySampleCount?: number;
  rollingMetrics?: RollingDeploymentMetrics;
}

export interface PenaltyConfig {
  warmupRequestTarget: number;
  warmupChatPenalty: number;
  warmupToolPenalty: number;
  warmupMultiToolPenalty: number;
  momentumBonusBase: number;
  momentumDecayFactor: number;
  quarantineFailureThreshold: number;
}

export const DEFAULT_PENALTY_CONFIG: PenaltyConfig = {
  warmupRequestTarget: 5,
  warmupChatPenalty: 60.0,
  warmupToolPenalty: 90.0,
  warmupMultiToolPenalty: 120.0,
  momentumBonusBase: 25.0,
  momentumDecayFactor: 0.997,
  quarantineFailureThreshold: 0,
};

export function deploymentPenalty(
  snapshot: HealthSnapshot | undefined,
  now: number,
  isToolRequest = false,
  requestShape?: "chat" | "tool" | "multi_tool",
  config: PenaltyConfig = DEFAULT_PENALTY_CONFIG,
): number {
  if (!snapshot) return 0.0;

  // Apply lazy decay: passively recover toward 100 when idle
  let effectiveScore = decayedScore(snapshot.score, snapshot.updatedAt, now);
  if (
    snapshot.rollingMetrics &&
    snapshot.rollingMetrics.recentOutcomeCount >= 5 &&
    snapshot.rollingMetrics.recentFailureRate <= 0.2
  ) {
    effectiveScore = Math.max(effectiveScore, 85);
  }
  const successComponent = (effectiveScore / 100) ** 2 * 1000;
  let penalty = Math.max(0, 1000 - successComponent);
  if (snapshot.rollingMetrics) {
    penalty += snapshot.rollingMetrics.timeoutRate * 200;
    penalty += snapshot.rollingMetrics.invalidSuccessRate * 250;
  }

  const totalRequests = snapshot.successCount + snapshot.failureCount;
  let warmupPenalty: number;
  if (requestShape === "multi_tool") {
    warmupPenalty = config.warmupMultiToolPenalty;
  } else if (isToolRequest) {
    warmupPenalty = config.warmupToolPenalty;
  } else {
    warmupPenalty = config.warmupChatPenalty;
  }
  const warmupTarget = Math.max(1, config.warmupRequestTarget);
  if (totalRequests < warmupTarget) {
    penalty += ((warmupTarget - totalRequests) / warmupTarget) * warmupPenalty;
  }

  if ((snapshot.lastSuccessAt !== null && snapshot.lastSuccessAt !== undefined)) {
    const ageSeconds = Math.max(0, (now - snapshot.lastSuccessAt) / 1000);
    penalty -= config.momentumBonusBase * (config.momentumDecayFactor ** ageSeconds);
  }

  return Math.max(0, penalty);
}

export function isQuarantined(
  snapshot: HealthSnapshot | undefined,
  config: PenaltyConfig = DEFAULT_PENALTY_CONFIG,
): boolean {
  if (!snapshot) return false;
  return (
    config.quarantineFailureThreshold > 0 &&
    snapshot.consecutiveFailureCount >= config.quarantineFailureThreshold
  );
}

// Convert a HealthScoreRow (from storage) to HealthSnapshot (for scoring).
export function toHealthSnapshot(row: import("./storage-adapter").HealthScoreRow | null): HealthSnapshot | undefined {
  if (!row) return undefined;
  return {
    score: row.score,
    lastSuccessAt: row.lastSuccessAt ?? undefined,
    lastFailureAt: row.lastFailureAt ?? undefined,
    failureClass: row.failureClass ?? undefined,
    updatedAt: row.updatedAt,
    successCount: row.successCount,
    failureCount: row.failureCount,
    consecutiveFailureCount: row.consecutiveFailureCount,
    latencyEmaMs: row.latencyEmaMs,
    latencySampleCount: row.latencySampleCount,
    rollingMetrics: computeRollingMetrics(row.recentOutcomes ?? []),
  };
}

// Self-healing decay for idle deployments: health scores gradually recover
// toward 100 when no requests are processed, allowing transient failures to
// age out. Called by reapExpired() on each maintenance cycle. Skips deployments
// updated within the last second or already at max health (100). Uses the same
// exponential decay formula as decayedScore() in scoring.ts.
export function decayIdleHealthScores(store: StorageAdapter, now = Date.now()): number {
  let changed = 0;
  for (const { deploymentId, score } of store.listHealthScores()) {
    if (now - score.updatedAt < 1000 || score.score >= 100) continue;
    const recovered = decayedScore(score.score, score.updatedAt, now);
    if (recovered === score.score) continue;
    store.setHealthScore(deploymentId, {
      ...score,
      score: recovered,
      updatedAt: now,
    });
    changed++;
  }
  return changed;
}
