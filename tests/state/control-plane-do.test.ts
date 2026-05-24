import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { ControlPlaneStateDO } from "../../src/state/control-plane-state";

function getDoStub(): ControlPlaneStateDO {
  const id = env.CONTROL_PLANE_STATE.idFromName("test-do-state");
  return env.CONTROL_PLANE_STATE.get(id) as unknown as ControlPlaneStateDO;
}

describe("ControlPlaneStateDO with real SQLite", () => {
  it("admits and releases a reservation", async () => {
    const stub = getDoStub();
    const result = await stub.admit({
      requestId: "req_test_1",
      candidates: [{
        deploymentId: "deploy-test-1",
        keyRef: "key-1",
        rpm: 100,
        maxParallel: 2,
        group: "test-group",
      }],
    });

    expect(result.admitted).toBe(true);
    expect(result.deploymentId).toBe("deploy-test-1");
    expect(result.reservationId).toBeDefined();

    await stub.release(result.reservationId!);
  });

  it("records success and health score appears in getHealth", async () => {
    const stub = getDoStub();
    await stub.recordSuccess("deploy-health-test", 3);

    const health = await stub.getHealth();
    const scores = health.healthScores as Record<string, unknown>;
    expect(scores["deploy-health-test"]).toBeDefined();
    const entry = scores["deploy-health-test"] as Record<string, unknown>;
    expect(entry.score).toBeGreaterThan(0);
  });

  it("records failures and circuit opens", async () => {
    const stub = getDoStub();
    const depId = "deploy-circuit-test";
    for (let i = 0; i < 5; i++) {
      await stub.recordFailure(depId, "server_5xx", 0, 5, 300);
    }

    const health = await stub.getHealth();
    const circuits = health.circuits as Record<string, unknown>;
    expect(circuits[depId]).toBeDefined();
    const circuit = circuits[depId] as Record<string, unknown>;
    expect(circuit.state).toBe("open");
  });

  it("stores and retrieves a receipt with totalDurationMs", async () => {
    const stub = getDoStub();
    const requestId = `req_receipt_${Date.now()}`;
    await stub.storeReceipt({
      requestId,
      timestamp: Date.now(),
      originalModel: "test-model",
      canonicalTarget: "test-model",
      selectedGroup: "test-group",
      fallbackGroups: ["fallback-1"],
      attempts: [{ action: "accept", deploymentId: "deploy-1", durationMs: 100 }],
      finalOutcome: "success",
      stream: false,
      totalDurationMs: 150,
    });

    const receipt = await stub.getReceipt(requestId);
    expect(receipt).not.toBeNull();
    expect(receipt!.requestId).toBe(requestId);
    expect(receipt!.totalDurationMs).toBe(150);
    expect(receipt!.stream).toBe(false);
  });

  it("reapExpired returns 0 for fresh reservations", async () => {
    const stub = getDoStub();
    const result = await stub.admit({
      requestId: `req_reap_${Date.now()}`,
      candidates: [{
        deploymentId: "deploy-reap-test",
        keyRef: "key-1",
        rpm: 100,
        maxParallel: 2,
        group: "test-group",
      }],
    });
    expect(result.admitted).toBe(true);

    const reaped = await stub.reapExpired();
    // Fresh reservation should not be reaped (expires_at is in the future)
    expect(reaped).toBe(0);
  });

  it("stores and retrieves canary results", async () => {
    const stub = getDoStub();
    await stub.storeCanaryResult({
      deploymentId: "deploy-canary-1",
      group: "group-1",
      success: true,
      latencyMs: 42,
      statusCode: 200,
    });
    await stub.storeCanaryResult({
      deploymentId: "deploy-canary-2",
      group: "group-2",
      success: false,
      failureClass: "server_5xx",
      latencyMs: 5000,
      statusCode: 500,
    });

    const results = await stub.getCanaryResults(10);
    expect(results.length).toBeGreaterThanOrEqual(2);

    const latest = results[0] as Record<string, unknown>;
    expect(latest.success).toBe(false);
    expect(latest.failureClass).toBe("server_5xx");
    expect(latest.latencyMs).toBe(5000);
  });
});
