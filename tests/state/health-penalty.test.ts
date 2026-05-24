import { describe, it, expect } from "vitest";
import {
  admit,
  recordSuccess,
  recordFailure,
  deploymentPenalty,
  isQuarantined,
  toHealthSnapshot,
  DEFAULT_PENALTY_CONFIG,
  computeRollingMetrics,
  decayIdleHealthScores,
  type PenaltyConfig,
  type HealthSnapshot,
} from "../../src/state/admission-engine";
import { InMemoryStorageAdapter } from "../../src/state/storage-adapter";

describe("Deployment penalty: warmup", () => {
  it("penalizes deployments with few requests", () => {
    const store = new InMemoryStorageAdapter();
    // New deployment: 0 successes, 0 failures
    store.setHealthScore("deploy-new", {
      score: 100,
      successCount: 0,
      failureCount: 0,
      consecutiveFailureCount: 0,
      updatedAt: Date.now(),
      latencySampleCount: 0,
    });

    const penalty = deploymentPenalty(
      toHealthSnapshot(store.getHealthScore("deploy-new")),
      Date.now(),
      false,
    );
    // Should have warmup penalty added
    expect(penalty).toBeGreaterThan(0);
    // Default warmup penalty for chat = 60.0 * (5/5) = 60
    expect(penalty).toBeGreaterThanOrEqual(55);
  });

  it("reduces warmup penalty as requests accumulate", () => {
    const now = Date.now();
    const store = new InMemoryStorageAdapter();
    store.setHealthScore("deploy-warm", {
      score: 100,
      successCount: 3,
      failureCount: 0,
      consecutiveFailureCount: 0,
      updatedAt: now,
      latencySampleCount: 0,
    });

    const penalty3 = deploymentPenalty(
      toHealthSnapshot(store.getHealthScore("deploy-warm")),
      now,
      false,
    );

    store.setHealthScore("deploy-warm", {
      score: 100,
      successCount: 5,
      failureCount: 0,
      consecutiveFailureCount: 0,
      updatedAt: now,
      latencySampleCount: 0,
    });

    const penalty5 = deploymentPenalty(
      toHealthSnapshot(store.getHealthScore("deploy-warm")),
      now,
      false,
    );

    // Warmed-up deployment should have lower penalty
    expect(penalty5).toBeLessThanOrEqual(penalty3);
    // At warmup target (5), no warmup penalty
    expect(penalty5).toBeLessThanOrEqual(5);
  });

  it("applies higher penalty for tool requests", () => {
    const now = Date.now();
    const snap: HealthSnapshot = {
      score: 100, successCount: 0, failureCount: 0,
      consecutiveFailureCount: 0, updatedAt: now,
    };

    const chatPenalty = deploymentPenalty(snap, now, false, "chat");
    const toolPenalty = deploymentPenalty(snap, now, true, "tool");
    const multiToolPenalty = deploymentPenalty(snap, now, false, "multi_tool");

    expect(toolPenalty).toBeGreaterThan(chatPenalty);
    expect(multiToolPenalty).toBeGreaterThan(toolPenalty);
  });
});

describe("Deployment penalty: momentum", () => {
  it("gives bonus for recent successes", () => {
    const now = Date.now();
    const recentSnap: HealthSnapshot = {
      score: 50, successCount: 10, failureCount: 2,
      consecutiveFailureCount: 0, lastSuccessAt: now - 1000, updatedAt: now,
    };
    const oldSnap: HealthSnapshot = {
      score: 50, successCount: 10, failureCount: 2,
      consecutiveFailureCount: 0, lastSuccessAt: now - 600000, updatedAt: now,
    };

    const recentPenalty = deploymentPenalty(recentSnap, now);
    const oldPenalty = deploymentPenalty(oldSnap, now);

    // Recent success should have lower penalty (momentum bonus)
    expect(recentPenalty).toBeLessThan(oldPenalty);
  });

  it("momentum decays over time", () => {
    const now = Date.now();
    const penalty1s = deploymentPenalty({
      score: 50, successCount: 10, failureCount: 2,
      consecutiveFailureCount: 0, lastSuccessAt: now - 1000, updatedAt: now,
    }, now);
    const penalty60s = deploymentPenalty({
      score: 50, successCount: 10, failureCount: 2,
      consecutiveFailureCount: 0, lastSuccessAt: now - 60000, updatedAt: now,
    }, now);
    const penalty300s = deploymentPenalty({
      score: 50, successCount: 10, failureCount: 2,
      consecutiveFailureCount: 0, lastSuccessAt: now - 300000, updatedAt: now,
    }, now);

    // Momentum decays: more recent = lower penalty
    expect(penalty1s).toBeLessThan(penalty60s);
    expect(penalty60s).toBeLessThan(penalty300s);
  });

  it("no momentum bonus without any success", () => {
    const now = Date.now();
    const snap: HealthSnapshot = {
      score: 50, successCount: 5, failureCount: 5,
      consecutiveFailureCount: 5, updatedAt: now,
      // no lastSuccessAt
    };

    const penaltyWithSuccess = deploymentPenalty({
      ...snap, lastSuccessAt: now,
    }, now);
    const penaltyNoSuccess = deploymentPenalty(snap, now);

    expect(penaltyNoSuccess).toBeGreaterThan(penaltyWithSuccess);
  });
});

describe("Quarantine tracking", () => {
  it("tracks consecutive failures", () => {
    const store = new InMemoryStorageAdapter();
    recordFailure(store, "deploy-1", "server_5xx", 0, 10, 300);
    recordFailure(store, "deploy-1", "server_5xx", 0, 10, 300);
    recordFailure(store, "deploy-1", "server_5xx", 0, 10, 300);

    const snap = store.getHealthScore("deploy-1");
    expect(snap?.consecutiveFailureCount).toBe(3);
  });

  it("resets consecutive failures on success", () => {
    const store = new InMemoryStorageAdapter();
    recordFailure(store, "deploy-1", "server_5xx", 0, 10, 300);
    recordFailure(store, "deploy-1", "server_5xx", 0, 10, 300);
    recordSuccess(store, "deploy-1");

    const snap = store.getHealthScore("deploy-1");
    expect(snap?.consecutiveFailureCount).toBe(0);
    expect(snap?.successCount).toBe(1);
    expect(snap?.failureCount).toBe(2);
  });

  it("blocks quarantined deployments from admission", () => {
    const store = new InMemoryStorageAdapter();

    // 3 consecutive failures -> quarantine
    for (let i = 0; i < 3; i++) {
      recordFailure(store, "deploy-1", "server_5xx", 0, 10, 300);
    }

    const result = admit(store, {
      requestId: "req-q",
      candidates: [
        { deploymentId: "deploy-1", keyRef: "key-1", rpm: 100, maxParallel: 5, group: "g" },
      ],
      quarantineFailureThreshold: 3,
    });

    expect(result.admitted).toBe(false);
    expect(result.rejected?.[0]?.reason).toBe("quarantine");
  });

  it("allows admission after quarantine clears from success", () => {
    const store = new InMemoryStorageAdapter();

    for (let i = 0; i < 3; i++) {
      recordFailure(store, "deploy-1", "server_5xx", 0, 10, 300);
    }

    recordSuccess(store, "deploy-1"); // resets consecutive count

    const result = admit(store, {
      requestId: "req-q2",
      candidates: [
        { deploymentId: "deploy-1", keyRef: "key-1", rpm: 100, maxParallel: 5, group: "g" },
      ],
      quarantineFailureThreshold: 3,
    });

    expect(result.admitted).toBe(true);
  });

  it("isQuarantined returns false when threshold is 0", () => {
    const snap: HealthSnapshot = {
      score: 50, successCount: 0, failureCount: 10,
      consecutiveFailureCount: 10, updatedAt: Date.now(),
    };
    expect(isQuarantined(snap)).toBe(false);
  });
});

describe("Rolling deployment metrics and weighted penalties", () => {
  it("captures bounded recent outcomes, timeout rate, invalid success rate, and p95 latency", () => {
    const store = new InMemoryStorageAdapter();
    recordSuccess(store, "deploy-roll", 3, 100, undefined, false, 300, { firstByteLatencyMs: 30 });
    recordSuccess(store, "deploy-roll", 3, 200, undefined, false, 300, { firstByteLatencyMs: 50 });
    recordFailure(store, "deploy-roll", "transport_timeout", 0, 10, 300);
    recordFailure(store, "deploy-roll", "success_shaped_failure", 0, 10, 300);

    const row = store.getHealthScore("deploy-roll")!;
    const metrics = computeRollingMetrics(row.recentOutcomes ?? []);

    expect(row.recentOutcomes).toHaveLength(4);
    expect(metrics.timeoutRate).toBe(0.25);
    expect(metrics.invalidSuccessRate).toBe(0.25);
    expect(metrics.p95FirstByteLatencyMs).toBe(50);
    expect(metrics.p95TotalLatencyMs).toBe(200);
  });

  it("caps recent outcome history at 50 entries", () => {
    const store = new InMemoryStorageAdapter();
    for (let i = 0; i < 60; i++) {
      recordSuccess(store, "deploy-cap", 3, i + 1);
    }

    expect(store.getHealthScore("deploy-cap")!.recentOutcomes).toHaveLength(50);
  });

  it("weights transport timeouts heavier than server failures and generic failures", () => {
    const generic = new InMemoryStorageAdapter();
    const server = new InMemoryStorageAdapter();
    const timeout = new InMemoryStorageAdapter();

    recordFailure(generic, "d", "unknown_failure", 0, 10, 300);
    recordFailure(server, "d", "server_5xx", 0, 10, 300);
    recordFailure(timeout, "d", "transport_timeout", 0, 10, 300);

    expect(server.getHealthScore("d")!.score).toBeLessThan(generic.getHealthScore("d")!.score);
    expect(timeout.getHealthScore("d")!.score).toBeLessThan(server.getHealthScore("d")!.score);
  });

  it("discounts failure penalty when dispatch happened at the concurrency ceiling", () => {
    const normal = new InMemoryStorageAdapter();
    const saturated = new InMemoryStorageAdapter();

    recordFailure(normal, "d", "transport_timeout", 0, 10, 300);
    recordFailure(saturated, "d", "transport_timeout", 0, 10, 300, undefined, false, 300, {
      inflightAtDispatch: 4,
      maxParallelAtDispatch: 4,
    });

    expect(saturated.getHealthScore("d")!.score).toBeGreaterThan(normal.getHealthScore("d")!.score);
  });

  it("feeds semantic severity into health decay", () => {
    const low = new InMemoryStorageAdapter();
    const high = new InMemoryStorageAdapter();

    recordFailure(low, "d", "semantic_failure", 0, 10, 300, undefined, false, 300, { semanticSeverity: "low" });
    recordFailure(high, "d", "semantic_failure", 0, 10, 300, undefined, false, 300, { semanticSeverity: "high" });

    expect(high.getHealthScore("d")!.score).toBeLessThan(low.getHealthScore("d")!.score);
  });

  it("dampens repeat failures of the same class within the burst dedup window", () => {
    const single = new InMemoryStorageAdapter();
    const burst = new InMemoryStorageAdapter();

    recordFailure(single, "d", "transport_timeout", 0, 10, 300);

    // Two failures of the same class arriving in the same burst should
    // not over-decay: the second is treated as ~10% penalty.
    recordFailure(burst, "d", "transport_timeout", 0, 10, 300);
    recordFailure(burst, "d", "transport_timeout", 0, 10, 300);

    const singleScore = single.getHealthScore("d")!.score;
    const burstScore = burst.getHealthScore("d")!.score;
    // Without dedup, burst would be ≈ singleScore * 0.7^3 (much lower).
    // With dedup, burst is ≈ singleScore * 0.7^(3*0.1+1) ≈ similar to single.
    expect(burstScore).toBeGreaterThan(singleScore * 0.85);
  });

  it("does not dampen failures of a different class", () => {
    const store = new InMemoryStorageAdapter();
    recordFailure(store, "d", "transport_timeout", 0, 10, 300);
    const afterFirst = store.getHealthScore("d")!.score;
    recordFailure(store, "d", "server_5xx", 0, 10, 300);
    const afterSecond = store.getHealthScore("d")!.score;
    // Different class → full penalty applies
    expect(afterSecond).toBeLessThan(afterFirst * 0.6);
  });

  it("suppresses transport-class cooldowns until consecutiveFailureCount reaches threshold", () => {
    const store = new InMemoryStorageAdapter();
    const now = Date.now();
    // First transport_timeout: cooldown should NOT be set because threshold is 2
    recordFailure(store, "d", "transport_timeout", 30, 10, 300, undefined, false, 300, {
      transportCooldownThreshold: 2,
    });
    expect(store.getCooldown("d", now)).toBe(false);

    // Second transport_timeout: now consecutiveFailureCount=2, cooldown should be set
    recordFailure(store, "d", "transport_timeout", 30, 10, 300, undefined, false, 300, {
      transportCooldownThreshold: 2,
    });
    expect(store.getCooldown("d", now)).toBe(true);
  });

  it("does not suppress non-transport cooldowns even below threshold", () => {
    const store = new InMemoryStorageAdapter();
    const now = Date.now();
    // semantic_failure is not a transport class — threshold should not apply
    recordFailure(store, "d", "semantic_failure", 30, 10, 300, undefined, false, 300, {
      transportCooldownThreshold: 5,
    });
    expect(store.getCooldown("d", now)).toBe(true);
  });

  it("does not suppress transport cooldowns when threshold is unset or zero", () => {
    const store = new InMemoryStorageAdapter();
    const now = Date.now();
    recordFailure(store, "d", "transport_timeout", 30, 10, 300);
    expect(store.getCooldown("d", now)).toBe(true);
  });

  it("passively recovers idle failure score toward neutral", () => {
    const store = new InMemoryStorageAdapter();
    const now = Date.now();
    store.setHealthScore("deploy-idle", {
      score: 40,
      successCount: 0,
      failureCount: 3,
      consecutiveFailureCount: 3,
      updatedAt: now - 900_000,
      latencySampleCount: 0,
      recentOutcomes: [],
    });

    const changed = decayIdleHealthScores(store, now);

    expect(changed).toBe(1);
    expect(store.getHealthScore("deploy-idle")!.score).toBeGreaterThan(40);
  });

  it("lets recent healthy outcomes reduce penalty despite poor historical score", () => {
    const now = Date.now();
    const penalty = deploymentPenalty({
      score: 25,
      successCount: 10,
      failureCount: 10,
      consecutiveFailureCount: 0,
      updatedAt: now,
      rollingMetrics: {
        recentOutcomeCount: 5,
        recentFailureRate: 0,
        timeoutRate: 0,
        invalidSuccessRate: 0,
        p95FirstByteLatencyMs: 50,
        p95TotalLatencyMs: 100,
      },
    }, now);

    expect(penalty).toBeLessThan(300);
  });
});

describe("Admission computes penalty from health", () => {
  it("penalty can be computed from health score after admission", () => {
    const store = new InMemoryStorageAdapter();
    const result = admit(store, {
      requestId: "req-pen",
      candidates: [
        { deploymentId: "deploy-1", keyRef: "key-1", rpm: 100, maxParallel: 5, group: "g" },
      ],
    });
    expect(result.admitted).toBe(true);

    const penalty = deploymentPenalty(
      toHealthSnapshot(store.getHealthScore(result.deploymentId!)),
      Date.now(),
    );
    expect(penalty).toBeDefined();
    expect(typeof penalty).toBe("number");
  });
});
