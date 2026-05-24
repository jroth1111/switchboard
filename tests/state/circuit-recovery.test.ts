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

describe("Circuit breaker recovery", () => {
  it("opens circuit after threshold failures", () => {
    const store = new InMemoryStorageAdapter();
    const c = candidate("deploy-1");

    for (let i = 0; i < 5; i++) {
      const r = admit(store, { requestId: `req-${i}`, candidates: [c] });
      if (r.admitted) release(store, r.reservationId!);
      recordFailure(store, "deploy-1", "server_5xx", 0, 5, 300);
    }

    const circuit = store.getCircuit("deploy-1");
    expect(circuit?.state).toBe("open");
    expect(circuit?.failureCount).toBe(5);
    expect(circuit?.halfOpenAfter).toBeGreaterThan(0);
  });

  it("rejects admission when circuit is open", () => {
    const store = new InMemoryStorageAdapter();
    const c = candidate("deploy-1");

    // Trip the circuit
    for (let i = 0; i < 5; i++) {
      recordFailure(store, "deploy-1", "server_5xx", 0, 5, 300);
    }

    const r = admit(store, { requestId: "req-test", candidates: [c] });
    expect(r.admitted).toBe(false);
    expect(r.rejected?.[0]?.reason).toBe("circuit_open");
  });

  it("allows admission when halfOpenAfter has passed", () => {
    const store = new InMemoryStorageAdapter();
    const c = candidate("deploy-1");

    // Trip the circuit with short half-open duration
    for (let i = 0; i < 5; i++) {
      recordFailure(store, "deploy-1", "server_5xx", 0, 5, 0.001);
    }

    // Expire halfOpenAfter
    const circuit = store.getCircuit("deploy-1")!;
    store.setCircuit("deploy-1", {
      ...circuit,
      halfOpenAfter: Date.now() - 1000,
      state: "open",
    });

    // Should be admitted (half-open allowed)
    const r = admit(store, { requestId: "req-test", candidates: [c] });
    expect(r.admitted).toBe(true);
  });

  it("does not decay failureCount on partial half_open successes", () => {
    const store = new InMemoryStorageAdapter();

    for (let i = 0; i < 5; i++) {
      recordFailure(store, "deploy-1", "server_5xx", 0, 5, 300);
    }

    const circuit = store.getCircuit("deploy-1")!;
    store.setCircuit("deploy-1", {
      ...circuit,
      state: "half_open",
      halfOpenAfter: Date.now() - 1000,
      successCount: 0,
    });

    recordSuccess(store, "deploy-1");
    const afterOne = store.getCircuit("deploy-1")!;
    expect(afterOne.state).toBe("half_open");
    expect(afterOne.successCount).toBe(1);
    expect(afterOne.failureCount).toBe(circuit.failureCount);
  });

  it("closes circuit after 3 successes in half_open", () => {
    const store = new InMemoryStorageAdapter();
    const c = candidate("deploy-1");

    // Trip the circuit
    for (let i = 0; i < 5; i++) {
      recordFailure(store, "deploy-1", "server_5xx", 0, 5, 300);
    }

    // Manually set to half_open
    const circuit = store.getCircuit("deploy-1")!;
    store.setCircuit("deploy-1", {
      ...circuit,
      state: "half_open",
      halfOpenAfter: Date.now() - 1000,
    });

    // 3 successes should close the circuit
    recordSuccess(store, "deploy-1");
    let c2 = store.getCircuit("deploy-1")!;
    expect(c2.state).toBe("half_open");
    expect(c2.successCount).toBe(1);
    expect(c2.failureCount).toBe(circuit.failureCount);

    recordSuccess(store, "deploy-1");
    c2 = store.getCircuit("deploy-1")!;
    expect(c2.state).toBe("half_open");
    expect(c2.successCount).toBe(2);

    recordSuccess(store, "deploy-1");
    c2 = store.getCircuit("deploy-1")!;
    expect(c2.state).toBe("closed");
    expect(c2.failureCount).toBe(0);
    expect(c2.successCount).toBe(3);
  });

  it("respects configurable circuitSuccessThreshold", () => {
    const store = new InMemoryStorageAdapter();
    const c = candidate("deploy-1");

    // Trip the circuit
    for (let i = 0; i < 5; i++) {
      recordFailure(store, "deploy-1", "server_5xx", 0, 5, 300);
    }

    // Set to half_open
    const circuit = store.getCircuit("deploy-1")!;
    store.setCircuit("deploy-1", { ...circuit, state: "half_open" });

    // With threshold of 5, 3 successes should NOT close
    recordSuccess(store, "deploy-1", 5);
    recordSuccess(store, "deploy-1", 5);
    recordSuccess(store, "deploy-1", 5);
    expect(store.getCircuit("deploy-1")?.state).toBe("half_open");

    // 4th and 5th should close it
    recordSuccess(store, "deploy-1", 5);
    expect(store.getCircuit("deploy-1")?.state).toBe("half_open");

    recordSuccess(store, "deploy-1", 5);
    expect(store.getCircuit("deploy-1")?.state).toBe("closed");
  });

  it("re-opens circuit on failure in half_open state", () => {
    const store = new InMemoryStorageAdapter();
    const c = candidate("deploy-1");

    // Trip the circuit
    for (let i = 0; i < 5; i++) {
      recordFailure(store, "deploy-1", "server_5xx", 0, 5, 300);
    }

    // Manually set to half_open
    const circuit = store.getCircuit("deploy-1")!;
    store.setCircuit("deploy-1", {
      ...circuit,
      state: "half_open",
      halfOpenAfter: Date.now() - 1000,
    });

    // One success
    recordSuccess(store, "deploy-1");
    expect(store.getCircuit("deploy-1")?.state).toBe("half_open");

    // Failure in half_open re-opens
    recordFailure(store, "deploy-1", "server_5xx", 0, 5, 300);
    const c2 = store.getCircuit("deploy-1")!;
    expect(c2.state).toBe("open");
    expect(c2.halfOpenAfter).toBeGreaterThan(Date.now());
  });

  it("health score recovers after successes", () => {
    const store = new InMemoryStorageAdapter();

    // Drive score down with failures
    for (let i = 0; i < 5; i++) {
      recordFailure(store, "deploy-1", "server_5xx", 0, 5, 300);
    }
    const afterFailures = store.getHealthScore("deploy-1")!.score;
    expect(afterFailures).toBeLessThan(100);

    // Drive score back up with successes
    for (let i = 0; i < 10; i++) {
      recordSuccess(store, "deploy-1");
    }
    const afterSuccesses = store.getHealthScore("deploy-1")!.score;
    expect(afterSuccesses).toBeGreaterThan(afterFailures);
    expect(afterSuccesses).toBeGreaterThan(90);
  });

  it("learned concurrency expires after TTL", () => {
    const store = new InMemoryStorageAdapter();
    const c = candidate("deploy-1", "key-1", 35, 4, "test");

    admit(store, { requestId: "req-1", candidates: [c] });
    recordFailure(store, "deploy-1", "rate_limit_concurrency", 0, 5, 300);

    // Learned limit is in effect
    const limit = store.getLearnedLimit("deploy-1", Date.now())!;
    expect(limit.maxParallel).toBeLessThan(4);
    expect(limit.expiresAt).toBeGreaterThan(Date.now());

    // Expire the learned limit
    store.setLearnedLimit("deploy-1", { ...limit, expiresAt: Date.now() - 1000 });

    // Should use original maxParallel now
    const r = admit(store, { requestId: "req-2", candidates: [c] });
    expect(r.admitted).toBe(true);
  });
});
