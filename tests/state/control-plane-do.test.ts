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
      clientId: "hermes-alice",
      appId: "hermes",
      userHash: "user-hash",
      policyId: "hermes-basic",
      policyVersion: "hermes-basic:v1",
      routeVersion: "route:v1",
      denialReason: "model_not_allowed",
      routeDecision: {
        selectedReason: "highest scoring viable candidate (90)",
        candidates: [{ group: "test-group", viable: true }],
      },
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
    expect(receipt!.clientId).toBe("hermes-alice");
    expect(receipt!.appId).toBe("hermes");
    expect(receipt!.policyVersion).toBe("hermes-basic:v1");
    expect(receipt!.denialReason).toBe("model_not_allowed");
    expect(receipt!.routeDecision).toMatchObject({
      selectedReason: "highest scoring viable candidate (90)",
    });
    expect(receipt!.totalDurationMs).toBe(150);
    expect(receipt!.stream).toBe(false);
  });

  it("stores and queries durable client request events", async () => {
    const stub = getDoStub();
    const requestId = `req_client_${Date.now()}`;
    await stub.storeClientRequest({
      requestId,
      timestamp: Date.now(),
      clientId: "hermes-alice",
      appId: "hermes",
      userHash: "user-hash",
      policyId: "hermes-basic",
      policyVersion: "hermes-basic:v1",
      routeVersion: "route:v1",
      routeDecision: {
        selectedReason: "highest scoring viable candidate (90)",
        candidates: [{ group: "smart-route-worker", viable: true }],
      },
      originalModel: "smart-route",
      canonicalTarget: "smart-route-worker",
      selectedGroup: "smart-route-worker",
      finalOutcome: "success",
      stream: false,
      totalDurationMs: 42,
    });

    const rows = await stub.queryClientRequests({ clientId: "hermes-alice", limit: 10 });
    const row = rows.find((item) => item.requestId === requestId);
    expect(row).toBeDefined();
    expect(row!.appId).toBe("hermes");
    expect(row!.policyId).toBe("hermes-basic");
    expect(row!.policyVersion).toBe("hermes-basic:v1");
    expect(row!.routeDecision).toMatchObject({
      selectedReason: "highest scoring viable candidate (90)",
    });
    expect(row!.totalDurationMs).toBe(42);
  });

  it("durably enforces client RPM and concurrency admission", async () => {
    const stub = getDoStub();
    const first = await stub.admitClientRequest({
      requestId: `req_client_limit_1_${Date.now()}`,
      clientId: "limited-client",
      userHash: "user-hash",
      rpmLimit: 1,
      maxConcurrency: 1,
    });
    expect(first.admitted).toBe(true);

    const second = await stub.admitClientRequest({
      requestId: `req_client_limit_2_${Date.now()}`,
      clientId: "limited-client",
      userHash: "user-hash",
      rpmLimit: 1,
      maxConcurrency: 1,
    });
    expect(second.admitted).toBe(false);
    expect(["client_rpm_exceeded", "client_concurrency_exceeded"]).toContain(second.reason);

    await stub.releaseClientRequest(first.reservationId);
    const concurrencyOnly = await stub.admitClientRequest({
      requestId: `req_client_limit_3_${Date.now()}`,
      clientId: "concurrency-client",
      userHash: "user-hash",
      maxConcurrency: 1,
    });
    expect(concurrencyOnly.admitted).toBe(true);
    const blocked = await stub.admitClientRequest({
      requestId: `req_client_limit_4_${Date.now()}`,
      clientId: "concurrency-client",
      userHash: "user-hash",
      maxConcurrency: 1,
    });
    expect(blocked.admitted).toBe(false);
    expect(blocked.reason).toBe("client_concurrency_exceeded");
    await stub.releaseClientRequest(concurrencyOnly.reservationId);
  });

  it("stores client identity on usage events", async () => {
    const stub = getDoStub();
    const requestId = `req_usage_client_${Date.now()}`;
    await stub.storeUsageEvent({
      requestId,
      attemptIndex: 0,
      timestamp: Date.now(),
      clientId: "hermes-alice",
      appId: "hermes",
      userHash: "user-hash",
      policyId: "hermes-basic",
      policyVersion: "hermes-basic:v1",
      routeVersion: "route:v1",
      canonicalTarget: "smart-route-worker",
      selectedGroup: "smart-route-worker",
      deploymentId: "deploy-1",
      provider: "fixture",
      model: "fixture-model",
      stream: false,
      finalOutcome: "success",
      usageKind: "known",
      promptTokens: 5,
      completionTokens: 7,
      totalTokens: 12,
      usageSource: "test",
    });

    const rows = await stub.queryUsageEvents({ clientId: "hermes-alice", limit: 10 });
    const row = rows.find((item) => item.requestId === requestId);
    expect(row).toBeDefined();
    expect(row!.appId).toBe("hermes");
    expect(row!.policyId).toBe("hermes-basic");
    expect(row!.policyVersion).toBe("hermes-basic:v1");
    expect(row!.totalTokens).toBe(12);
  });

  it("stores failed requests with searchable filters and optional sanitized receipts", async () => {
    const stub = getDoStub();
    const timestamp = Date.UTC(2026, 4, 24, 4, 30, 0);
    const requestId = `req_failed_${Date.now()}`;
    const summary = {
      requestId,
      route: "smart-route-worker",
      canonicalTarget: "smart-route-worker",
      selectedGroup: "nim-primary",
      selectedModel: "nim-primary-key-1",
      failureClass: "server_5xx",
      issueCode: "provider_5xx",
      requestSource: "hermes",
    };

    await stub.storeFailedRequest({
      requestId,
      timestamp,
      originalModel: "glm-5.1",
      route: "smart-route-worker",
      canonicalTarget: "smart-route-worker",
      selectedGroup: "nim-primary",
      selectedModel: "nim-primary-key-1",
      finalOutcome: "exhausted",
      failureClass: "server_5xx",
      issueCode: "provider_5xx",
      requestSource: "hermes",
      attemptsCount: 1,
      summaryJson: JSON.stringify(summary),
      receiptJson: JSON.stringify({ requestId, body: "<redacted>" }),
    });

    const rows = await stub.queryFailedRequests({
      route: "smart-route-worker",
      selectedGroup: "nim-primary",
      selectedModel: "nim-primary-key-1",
      failureClass: "server_5xx",
      issueCode: "provider_5xx",
      requestSource: "hermes",
      since: timestamp - 1,
      until: timestamp + 1,
      limit: 10,
    });
    const row = rows.find((item) => item.requestId === requestId);

    expect(row).toBeDefined();
    expect(row!.route).toBe("smart-route-worker");
    expect(row!.selectedModel).toBe("nim-primary-key-1");
    expect(row!.issueCode).toBe("provider_5xx");
    expect(row).not.toHaveProperty("receipt");

    const detail = await stub.queryFailedRequests({ requestId, includeReceipt: true, limit: 1 });
    expect(detail[0].receipt).toEqual({ requestId, body: "<redacted>" });
  });

  it("durably enforces client token budget from usage events", async () => {
    const stub = getDoStub();
    await stub.storeUsageEvent({
      requestId: `req_budget_usage_${Date.now()}`,
      attemptIndex: 0,
      timestamp: Date.now(),
      clientId: "budget-client",
      userHash: "user-hash",
      canonicalTarget: "smart-route-worker",
      selectedGroup: "smart-route-worker",
      deploymentId: "deploy-1",
      provider: "fixture",
      model: "fixture-model",
      stream: false,
      finalOutcome: "success",
      usageKind: "known",
      promptTokens: 4,
      completionTokens: 6,
      totalTokens: 10,
      usageSource: "test",
    });

    const admission = await stub.admitClientRequest({
      requestId: `req_budget_blocked_${Date.now()}`,
      clientId: "budget-client",
      userHash: "user-hash",
      tokenBudgetPerMinute: 10,
    });
    expect(admission.admitted).toBe(false);
    expect(admission.reason).toBe("client_token_budget_exceeded");
  });

  it("durably rejects a request whose estimated tokens exceed remaining client budget", async () => {
    const stub = getDoStub();
    await stub.storeUsageEvent({
      requestId: `req_budget_partial_${Date.now()}`,
      attemptIndex: 0,
      timestamp: Date.now(),
      clientId: "estimate-budget-client",
      userHash: "user-hash",
      canonicalTarget: "smart-route-worker",
      selectedGroup: "smart-route-worker",
      deploymentId: "deploy-1",
      provider: "fixture",
      model: "fixture-model",
      stream: false,
      finalOutcome: "success",
      usageKind: "known",
      promptTokens: 5,
      completionTokens: 5,
      totalTokens: 10,
      usageSource: "test",
    });

    const admission = await stub.admitClientRequest({
      requestId: `req_budget_estimate_blocked_${Date.now()}`,
      clientId: "estimate-budget-client",
      userHash: "user-hash",
      tokenBudgetPerMinute: 12,
      estimatedTokens: 3,
    });
    expect(admission.admitted).toBe(false);
    expect(admission.reason).toBe("client_token_budget_exceeded");
  });

  it("reserves inflight client token estimates against the minute budget", async () => {
    const stub = getDoStub();
    const clientId = `reserve-budget-client-${Date.now()}`;
    const first = await stub.admitClientRequest({
      requestId: `req_budget_reserve_first_${Date.now()}`,
      clientId,
      userHash: "user-hash",
      tokenBudgetPerMinute: 100,
      estimatedTokens: 80,
    });
    expect(first.admitted).toBe(true);

    const second = await stub.admitClientRequest({
      requestId: `req_budget_reserve_second_${Date.now()}`,
      clientId,
      userHash: "user-hash",
      tokenBudgetPerMinute: 100,
      estimatedTokens: 30,
    });
    expect(second.admitted).toBe(false);
    expect(second.reason).toBe("client_token_budget_exceeded");

    await stub.releaseClientRequest(first.reservationId);
  });

  it("fails closed when a token-budgeted admission omits the token estimate", async () => {
    const stub = getDoStub();
    const admission = await stub.admitClientRequest({
      requestId: `req_budget_no_estimate_${Date.now()}`,
      clientId: `estimate-required-client-${Date.now()}`,
      userHash: "user-hash",
      tokenBudgetPerMinute: 100,
    });

    expect(admission.admitted).toBe(false);
    expect(admission.reason).toBe("client_token_estimate_required");
  });

  it("computes client usage rollups", async () => {
    const stub = getDoStub();
    const hour = Math.floor(Date.now() / 3600000) * 3600000;
    const requestId = `req_client_rollup_${Date.now()}`;
    await stub.storeUsageEvent({
      requestId,
      attemptIndex: 0,
      timestamp: hour + 1000,
      clientId: "hermes-alice",
      appId: "hermes",
      policyId: "hermes-basic",
      canonicalTarget: "smart-route-worker",
      selectedGroup: "smart-route-worker",
      deploymentId: "deploy-1",
      provider: "fixture",
      model: "fixture-model",
      stream: false,
      finalOutcome: "success",
      usageKind: "known",
      promptTokens: 3,
      completionTokens: 4,
      totalTokens: 7,
      usageSource: "test",
    });

    await stub.computeHourlyRollups(hour);
    const rollups = await stub.queryClientRollups({
      clientId: "hermes-alice",
      appId: "hermes",
      since: hour,
      until: hour,
    });

    const row = rollups.find((item) => item.clientId === "hermes-alice");
    expect(row).toBeDefined();
    expect(row!.appId).toBe("hermes");
    expect(row!.requests).toBe(1);
    expect(row!.totalTokens).toBe(7);
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
