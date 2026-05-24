import { describe, it, expect } from "vitest";
import {
  admit,
  release,
  recordSuccess,
  recordFailure,
} from "../../src/state/admission-engine";
import { InMemoryStorageAdapter } from "../../src/state/storage-adapter";

function candidate(
  deploymentId: string,
  keyRef = "key-1",
  rpm = 35,
  maxParallel = 2,
  group = "test",
) {
  return { deploymentId, keyRef, rpm, maxParallel, group };
}

// ─── Admission ──────────────────────────────────────────────────────

describe("State engine admission", () => {
  it("admits a request with available capacity", () => {
    const store = new InMemoryStorageAdapter();
    const result = admit(store, { requestId: "req-1", candidates: [candidate("nim-1")] });

    expect(result.admitted).toBe(true);
    expect(result.deploymentId).toBe("nim-1");
    expect(result.keyRef).toBe("key-1");
    expect(result.reservationId).toBeDefined();
    expect(result.inflightAtDispatch).toBe(1);
    expect(result.effectiveMaxParallel).toBe(2);
  });

  it("rejects when inflight is exhausted", () => {
    const store = new InMemoryStorageAdapter();
    const c = candidate("nim-1", "key-1", 35, 1);

    const r1 = admit(store, { requestId: "req-1", candidates: [c] });
    expect(r1.admitted).toBe(true);

    const r2 = admit(store, { requestId: "req-2", candidates: [c] });
    expect(r2.admitted).toBe(false);
    expect(r2.rejected?.[0]?.reason).toBe("inflight_exhausted");
  });

  it("rejects when key RPM is exhausted", () => {
    const store = new InMemoryStorageAdapter();
    const c = candidate("nim-1", "key-1", 2, 10);

    admit(store, { requestId: "req-1", candidates: [c] });
    admit(store, { requestId: "req-2", candidates: [c] });

    const r3 = admit(store, { requestId: "req-3", candidates: [c] });
    expect(r3.admitted).toBe(false);
    expect(r3.rejected?.[0]?.reason).toBe("key_rpm_exhausted");
  });

  it("scopes per-key RPM by group lane", () => {
    const store = new InMemoryStorageAdapter();
    const hotLane = candidate("nim-tools", "shared-key", 1, 10, "tool-lane");
    const coolLane = candidate("nim-chat", "shared-key", 1, 10, "chat-lane");

    admit(store, { requestId: "req-hot", candidates: [hotLane], scopeMode: "per_key" });
    const result = admit(store, { requestId: "req-cool", candidates: [coolLane], scopeMode: "per_key" });

    expect(result.admitted).toBe(true);
    expect(result.deploymentId).toBe("nim-chat");
  });

  it("gives each key its own RPM bucket under per_key mode (multi-key group)", () => {
    const store = new InMemoryStorageAdapter();
    const k1 = candidate("nim-1", "NIM_KEY_1", 2, 10, "nim-primary");
    const k2 = candidate("nim-2", "NIM_KEY_2", 2, 10, "nim-primary");

    // Each key should sustain rpm=2 independently → 4 admissions before exhaustion
    for (let i = 0; i < 2; i++) {
      const r = admit(store, { requestId: `r-k1-${i}`, candidates: [k1], scopeMode: "per_key" });
      expect(r.admitted).toBe(true);
    }
    for (let i = 0; i < 2; i++) {
      const r = admit(store, { requestId: `r-k2-${i}`, candidates: [k2], scopeMode: "per_key" });
      expect(r.admitted).toBe(true);
    }

    const blockedK1 = admit(store, { requestId: "r-k1-blocked", candidates: [k1], scopeMode: "per_key" });
    expect(blockedK1.admitted).toBe(false);
    expect(blockedK1.rejected?.[0]?.reason).toBe("key_rpm_exhausted");
  });

  it("collapses all keys onto one bucket under global mode", () => {
    const store = new InMemoryStorageAdapter();
    const k1 = candidate("nim-1", "NIM_KEY_1", 2, 10, "nim-primary");
    const k2 = candidate("nim-2", "NIM_KEY_2", 2, 10, "nim-primary");

    // Only 2 admissions total — both keys share `nim-primary:global`
    admit(store, { requestId: "r-1", candidates: [k1], scopeMode: "global" });
    admit(store, { requestId: "r-2", candidates: [k2], scopeMode: "global" });

    const blocked = admit(store, { requestId: "r-3", candidates: [k1, k2], scopeMode: "global" });
    expect(blocked.admitted).toBe(false);
    expect(blocked.rejected?.every((r) => r.reason === "key_rpm_exhausted")).toBe(true);
  });

  it("selects next candidate when first is rejected", () => {
    const store = new InMemoryStorageAdapter();

    // Fill first
    admit(store, { requestId: "req-1", candidates: [candidate("nim-1", "key-1", 35, 1)] });

    const result = admit(store, { requestId: "req-2", candidates: [
      candidate("nim-1", "key-1", 35, 1),
      candidate("nim-2", "key-2", 35, 2),
    ]});
    expect(result.admitted).toBe(true);
    expect(result.deploymentId).toBe("nim-2");
  });

  it("rejects all when no candidates available", () => {
    const store = new InMemoryStorageAdapter();
    const result = admit(store, { requestId: "req-1", candidates: [
      candidate("nim-1", "key-1", 0, 0),
    ]});
    expect(result.admitted).toBe(false);
    expect(result.rejected).toHaveLength(1);
  });
});

// ─── Release ────────────────────────────────────────────────────────

describe("State engine release", () => {
  it("decrements inflight on release", () => {
    const store = new InMemoryStorageAdapter();
    const c = candidate("nim-1", "key-1", 35, 1);

    const r1 = admit(store, { requestId: "req-1", candidates: [c] });
    expect(r1.admitted).toBe(true);

    release(store, r1.reservationId!);

    // Should be admissible again
    const r2 = admit(store, { requestId: "req-2", candidates: [c] });
    expect(r2.admitted).toBe(true);
  });

  it("handles unknown reservation gracefully", () => {
    const store = new InMemoryStorageAdapter();
    expect(() => release(store, "nonexistent")).not.toThrow();
  });
});

// ─── Health recording ───────────────────────────────────────────────

describe("State engine health recording", () => {
  it("boosts health on success", () => {
    const store = new InMemoryStorageAdapter();
    recordSuccess(store, "deploy-1");

    const score = store.getHealthScore("deploy-1");
    expect(score).toBeDefined();
    expect(score!.score).toBeGreaterThan(0);
    expect(score!.score).toBeLessThanOrEqual(100);
  });

  it("decays health on failure", () => {
    const store = new InMemoryStorageAdapter();
    recordSuccess(store, "deploy-1");
    recordSuccess(store, "deploy-1");
    recordFailure(store, "deploy-1", "server_5xx", 10, 5, 300);

    const score = store.getHealthScore("deploy-1");
    expect(score!.score).toBeLessThan(100);
  });

  it("applies cooldown on failure", () => {
    const store = new InMemoryStorageAdapter();
    recordFailure(store, "deploy-1", "rate_limit_overload", 30, 5, 300);

    const result = admit(store, { requestId: "req-1", candidates: [candidate("deploy-1")] });
    expect(result.admitted).toBe(false);
    expect(result.rejected?.[0]?.reason).toBe("cooldown");
  });

  it("does not apply cooldown when cooldownSeconds is 0", () => {
    const store = new InMemoryStorageAdapter();
    recordFailure(store, "deploy-1", "semantic_failure", 0, 5, 300);

    expect(store.getCooldown("deploy-1", Date.now())).toBe(false);
  });

  it("opens circuit after threshold failures", () => {
    const store = new InMemoryStorageAdapter();
    const threshold = 3;

    for (let i = 0; i < threshold; i++) {
      recordFailure(store, "deploy-1", "server_5xx", 0, threshold, 300);
    }

    const circuit = store.getCircuit("deploy-1");
    expect(circuit?.state).toBe("open");
    expect(circuit?.halfOpenAfter).toBeGreaterThan(Date.now());
  });

  it("does not open circuit below threshold", () => {
    const store = new InMemoryStorageAdapter();
    recordFailure(store, "deploy-1", "server_5xx", 0, 5, 300);

    const circuit = store.getCircuit("deploy-1");
    expect(circuit?.state).toBe("closed");
  });

  it("closes circuit on enough successes after half-open", () => {
    const store = new InMemoryStorageAdapter();

    // Open the circuit
    for (let i = 0; i < 3; i++) {
      recordFailure(store, "deploy-1", "server_5xx", 0, 3, 0);
    }
    expect(store.getCircuit("deploy-1")?.state).toBe("open");

    // Set to half_open manually (simulating half_open_after passing)
    const circuit = store.getCircuit("deploy-1")!;
    store.setCircuit("deploy-1", { ...circuit, state: "half_open" });

    // 3 successes should close it
    for (let i = 0; i < 3; i++) {
      recordSuccess(store, "deploy-1");
    }
    expect(store.getCircuit("deploy-1")?.state).toBe("closed");
    expect(store.getCircuit("deploy-1")?.failureCount).toBe(0);
  });

  it("learns lower concurrency on rate_limit_concurrency", () => {
    const store = new InMemoryStorageAdapter();

    admit(store, { requestId: "req-1", candidates: [candidate("deploy-1")] });
    recordFailure(store, "deploy-1", "rate_limit_concurrency", 0, 5, 300);

    const limit = store.getLearnedLimit("deploy-1", Date.now());
    expect(limit).toBeDefined();
    expect(limit!.maxParallel).toBeLessThan(2);
    expect(limit!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("learns lower concurrency on rate_limit_concurrency_ambiguous", () => {
    const store = new InMemoryStorageAdapter();

    admit(store, { requestId: "req-1", candidates: [candidate("deploy-1")] });
    recordFailure(store, "deploy-1", "rate_limit_concurrency_ambiguous", 0, 5, 300);

    const limit = store.getLearnedLimit("deploy-1", Date.now());
    expect(limit).toBeDefined();
    expect(limit!.maxParallel).toBeLessThan(2);
  });
});

// ─── Cooldown clearing ──────────────────────────────────────────────

describe("State engine cooldown clearing", () => {
  it("clears specific deployment cooldowns", () => {
    const store = new InMemoryStorageAdapter();
    recordFailure(store, "deploy-1", "server_5xx", 60, 5, 300);
    recordFailure(store, "deploy-2", "server_5xx", 60, 5, 300);

    store.clearCooldowns("deploy-1");

    const r1 = admit(store, { requestId: "req-1", candidates: [candidate("deploy-1")] });
    expect(r1.admitted).toBe(true);

    const r2 = admit(store, { requestId: "req-2", candidates: [candidate("deploy-2")] });
    expect(r2.admitted).toBe(false);
  });

  it("clears all cooldowns", () => {
    const store = new InMemoryStorageAdapter();
    recordFailure(store, "deploy-1", "server_5xx", 60, 5, 300);
    recordFailure(store, "deploy-2", "server_5xx", 60, 5, 300);

    store.clearCooldowns();

    const r1 = admit(store, { requestId: "req-1", candidates: [candidate("deploy-1")] });
    expect(r1.admitted).toBe(true);
  });
});

// ─── End-to-end scenario ───────────────────────────────────────────

describe("State engine end-to-end scenario", () => {
  it("handles full admission -> failure -> cooldown -> fallback -> success flow", () => {
    const store = new InMemoryStorageAdapter();
    const c1 = candidate("deploy-1", "key-1", 35, 2);
    const c2 = candidate("deploy-2", "key-2", 35, 2);

    // First attempt on deploy-1
    const r1 = admit(store, { requestId: "req-1", candidates: [c1, c2] });
    expect(r1.admitted).toBe(true);
    expect(r1.deploymentId).toBe("deploy-1");

    // deploy-1 fails with rate limit
    release(store, r1.reservationId!);
    recordFailure(store, "deploy-1", "rate_limit_overload", 30, 5, 300);

    // Second request should skip deploy-1 (cooldown) and go to deploy-2
    const r2 = admit(store, { requestId: "req-2", candidates: [c1, c2] });
    expect(r2.admitted).toBe(true);
    expect(r2.deploymentId).toBe("deploy-2");

    // deploy-2 succeeds
    release(store, r2.reservationId!);
    recordSuccess(store, "deploy-2");

    // deploy-2 health should be high
    expect(store.getHealthScore("deploy-2")!.score).toBeGreaterThan(0);
  });

  it("handles key rotation across same deployment", () => {
    const store = new InMemoryStorageAdapter();

    const c1 = candidate("deploy-1", "key-1", 1, 10);
    const c2 = candidate("deploy-1", "key-2", 1, 10);

    // Use key-1
    const r1 = admit(store, { requestId: "req-1", candidates: [c1, c2] });
    expect(r1.admitted).toBe(true);
    expect(r1.keyRef).toBe("key-1");

    // key-1 exhausted, should use key-2
    const r2 = admit(store, { requestId: "req-2", candidates: [c1, c2] });
    expect(r2.admitted).toBe(true);
    expect(r2.keyRef).toBe("key-2");

    // Both keys exhausted
    const r3 = admit(store, { requestId: "req-3", candidates: [c1, c2] });
    expect(r3.admitted).toBe(false);
    expect(r3.rejected?.every((r) => r.reason === "key_rpm_exhausted")).toBe(true);
  });

  it("reaps stale inflight entries", () => {
    const store = new InMemoryStorageAdapter();
    // Manually inject a stale inflight entry
    store.setInflight("deploy-1", 5, Date.now() - 300000); // 5min old
    store.setInflight("deploy-2", 1, Date.now()); // fresh

    // Reap with 60s threshold
    const result = admit(store, {
      requestId: "req-1",
      candidates: [candidate("deploy-1")],
      staleInflightSeconds: 60,
    });
    expect(result.admitted).toBe(true); // was stale, should be reaped
    expect(store.getInflight("deploy-2")).toBeGreaterThan(0); // fresh one should remain
  });

  it("limits half-open to exactly 1 probe request", () => {
    const store = new InMemoryStorageAdapter();
    // Set circuit to half_open
    store.setCircuit("deploy-1", { state: "half_open", failureCount: 3, successCount: 0, updatedAt: Date.now() });
    // Even with maxParallel=4, half-open should only allow 1 concurrent request
    const c = candidate("deploy-1", "key-1", 100, 4);
    admit(store, { requestId: "req-1", candidates: [c], halfOpenPenalty: 2 });
    // Second should fail since effective max is 1
    const r2 = admit(store, { requestId: "req-2", candidates: [c], halfOpenPenalty: 2 });
    expect(r2.admitted).toBe(false);
    expect(r2.rejected?.[0]?.reason).toBe("inflight_exhausted");
  });

  it("enforces group-level RPM limit", () => {
    const store = new InMemoryStorageAdapter();
    const c1 = candidate("deploy-1", "test:key-1", 100, 10);
    const c2 = candidate("deploy-2", "test:key-2", 100, 10);

    // Use both keys to rack up 2 group requests
    admit(store, { requestId: "req-1", candidates: [c1] });
    admit(store, { requestId: "req-2", candidates: [c2] });

    // Third request should hit group RPM limit of 2
    const r3 = admit(store, { requestId: "req-3", candidates: [c1], rpmLimit: 2 });
    expect(r3.admitted).toBe(false);
    expect(r3.rejected?.[0]?.reason).toBe("group_rpm_exhausted");
  });
});

// DO tests with real SQLite are in control-plane-do.test.ts
// (split to avoid cloudflare:test import blocking in-memory tests)
