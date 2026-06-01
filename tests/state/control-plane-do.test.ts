import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import type { ControlPlaneStateDO } from "../../src/state/control-plane-state";

function getDoStub(name = "test-do-state"): ControlPlaneStateDO {
  const id = env.CONTROL_PLANE_STATE.idFromName(name);
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

  it("stores credential-scoped cooldowns separately from deployments", async () => {
    const stub = getDoStub(`cred-cooldown-${Date.now()}`);
    await stub.setCredentialCooldown("NIM_KEY_1", "rate_limit_overload", Date.now() + 60_000);
    const active = await stub.getCredentialCooldown("NIM_KEY_1");
    expect(active).not.toBeNull();
    expect(active!.reason).toBe("rate_limit_overload");
    await stub.clearCredentialCooldown("NIM_KEY_1");
    const cleared = await stub.getCredentialCooldown("NIM_KEY_1");
    expect(cleared).toBeNull();
  });

  it("persists sequential_exhaust credential pool order across calls", async () => {
    const stub = getDoStub(`cred-order-${Date.now()}`);
    const deploymentId = "nim-primary-key-1";
    await stub.setCredentialPoolOrder(deploymentId, ["NIM_KEY_2", "NIM_KEY_1"]);
    const order = await stub.getCredentialPoolOrder(deploymentId);
    expect(order).toEqual(["NIM_KEY_2", "NIM_KEY_1"]);
    await stub.setCredentialPoolOrder(deploymentId, ["NIM_KEY_1", "NIM_KEY_2"]);
    expect(await stub.getCredentialPoolOrder(deploymentId)).toEqual(["NIM_KEY_1", "NIM_KEY_2"]);
  });

  it("credential cooldown persists on the same DO across stub calls", async () => {
    const stubName = `cred-persist-${Date.now()}`;
    const until = Date.now() + 120_000;
    const stub = getDoStub(stubName);
    await stub.setCredentialCooldown("NIM_KEY_1", "rate_limit_overload", until);

    const reloaded = getDoStub(stubName);
    const active = await reloaded.getCredentialCooldown("NIM_KEY_1");
    expect(active?.reason).toBe("rate_limit_overload");
    expect(await reloaded.getCredentialCooldown("NIM_KEY_1", until + 1)).toBeNull();
  });

  it("partitions credential and deployment cooldowns in getHealth", async () => {
    const stub = getDoStub(`health-partition-${Date.now()}`);
    const deploymentId = "deploy-health-partition";
    const until = Date.now() + 60_000;
    await stub.setCredentialCooldown("NIM_KEY_1", "rate_limit_overload", until);
    await stub.setCredentialPoolOrder(deploymentId, ["NIM_KEY_1"]);
    await stub.recordFailure(deploymentId, "server_5xx", 60, 5, 300);

    const health = await stub.getHealth();
    const credentialCooldowns = health.credentialCooldowns as Record<string, unknown>;
    const deploymentCooldowns = health.deploymentCooldowns as Record<string, unknown>;
    const flat = health.cooldowns as Record<string, unknown>;

    expect(Object.keys(credentialCooldowns).some((scope) => scope.startsWith("cred:"))).toBe(true);
    expect(Object.keys(credentialCooldowns).some((scope) => scope.startsWith("cred-order:"))).toBe(true);
    expect(deploymentCooldowns[deploymentId]).toBeDefined();
    expect(flat[deploymentId]).toBeDefined();
  });

  it("clears deployment cooldown and cred-order scope together", async () => {
    const stub = getDoStub(`cred-clear-${Date.now()}`);
    const deploymentId = "deploy-cred-clear";
    await stub.setCredentialPoolOrder(deploymentId, ["NIM_KEY_1"]);
    const store = await stub.getCredentialPoolOrder(deploymentId);
    expect(store).toEqual(["NIM_KEY_1"]);
    await stub.clearCooldowns(deploymentId);
    expect(await stub.getCredentialPoolOrder(deploymentId)).toBeNull();
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

  it("includes route dispatch memory in getHealth snapshots", async () => {
    const stub = getDoStub();
    const canonicalTarget = `dispatch-target-${Date.now()}`;

    await stub.recordRouteDispatch(canonicalTarget, "chat", "nim-primary");

    const health = await stub.getHealth();
    const routeDispatchMemory = health.routeDispatchMemory as Record<string, Record<string, Record<string, unknown>>>;
    expect(routeDispatchMemory[canonicalTarget]?.chat).toMatchObject({
      group: "nim-primary",
    });
    expect(typeof routeDispatchMemory[canonicalTarget]?.chat?.dispatchedAt).toBe("number");
  });

  it("stores and retrieves a receipt with totalDurationMs", async () => {
    const stub = getDoStub();
    const requestId = `req_receipt_${Date.now()}`;
    await stub.storeReceipt({
      requestId,
      timestamp: Date.now(),
      originalModel: "test-model",
      clientId: "demo-client-alpha",
      appId: "demo-app",
      userHash: "user-hash",
      policyId: "default-policy",
      policyVersion: "default-policy:v1",
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
    expect(receipt!.clientId).toBe("demo-client-alpha");
    expect(receipt!.appId).toBe("demo-app");
    expect(receipt!.policyVersion).toBe("default-policy:v1");
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
      clientId: "demo-client-alpha",
      appId: "demo-app",
      userHash: "user-hash",
      policyId: "default-policy",
      policyVersion: "default-policy:v1",
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

    const rows = await stub.queryClientRequests({ clientId: "demo-client-alpha", limit: 10 });
    const row = rows.find((item) => item.requestId === requestId);
    expect(row).toBeDefined();
    expect(row!.appId).toBe("demo-app");
    expect(row!.policyId).toBe("default-policy");
    expect(row!.policyVersion).toBe("default-policy:v1");
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
      clientId: "demo-client-alpha",
      appId: "demo-app",
      userHash: "user-hash",
      policyId: "default-policy",
      policyVersion: "default-policy:v1",
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

    const rows = await stub.queryUsageEvents({ clientId: "demo-client-alpha", limit: 10 });
    const row = rows.find((item) => item.requestId === requestId);
    expect(row).toBeDefined();
    expect(row!.appId).toBe("demo-app");
    expect(row!.policyId).toBe("default-policy");
    expect(row!.policyVersion).toBe("default-policy:v1");
    expect(row!.totalTokens).toBe(12);
  });

  it("clamps negative client and usage query limits", async () => {
    const stub = getDoStub();
    const suffix = Date.now();
    const clientId = `limit-client-${suffix}`;
    for (let i = 0; i < 2; i++) {
      await stub.storeClientRequest({
        requestId: `req_limit_client_${suffix}_${i}`,
        timestamp: Date.now() + i,
        clientId,
        originalModel: "smart-route",
        canonicalTarget: "smart-route-worker",
        selectedGroup: "smart-route-worker",
        finalOutcome: "success",
        stream: false,
      });
      await stub.storeUsageEvent({
        requestId: `req_limit_usage_${suffix}_${i}`,
        attemptIndex: 0,
        timestamp: Date.now() + i,
        clientId,
        canonicalTarget: "smart-route-worker",
        selectedGroup: "smart-route-worker",
        deploymentId: "deploy-1",
        provider: "fixture",
        model: "fixture-model",
        stream: false,
        finalOutcome: "success",
        usageKind: "known",
        promptTokens: 1,
        completionTokens: 1,
        totalTokens: 2,
        usageSource: "test",
      });
    }

    const clientRows = await stub.queryClientRequests({ clientId, limit: -1 });
    const usageRows = await stub.queryUsageEvents({ clientId, limit: -1 });

    expect(clientRows).toHaveLength(1);
    expect(usageRows).toHaveLength(1);
  });

  it("stores failed requests with searchable filters and optional sanitized receipts", async () => {
    const stub = getDoStub(`failed-req-${Date.now()}`);
    const timestamp = Date.now();
    const requestId = `req_failed_${Date.now()}`;
    const summary = {
      requestId,
      route: "smart-route-worker",
      canonicalTarget: "smart-route-worker",
      selectedGroup: "nim-primary",
      selectedModel: "nim-primary-key-1",
      failureClass: "server_5xx",
      issueCode: "provider_5xx",
      requestSource: "demo-app",
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
      requestSource: "demo-app",
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
      requestSource: "demo-app",
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

  it("durably enforces team token budget across members sharing team_id", async () => {
    const stub = getDoStub();
    const teamId = `team-budget-${Date.now()}`;
    await stub.storeUsageEvent({
      requestId: `req_team_budget_usage_${Date.now()}`,
      attemptIndex: 0,
      timestamp: Date.now(),
      clientId: "member-a",
      teamId,
      canonicalTarget: "smart-route-worker",
      selectedGroup: "smart-route-worker",
      deploymentId: "deploy-1",
      provider: "fixture",
      model: "fixture-model",
      stream: false,
      finalOutcome: "success",
      usageKind: "known",
      promptTokens: 6,
      completionTokens: 4,
      totalTokens: 10,
      usageSource: "test",
    });

    const admission = await stub.admitClientRequest({
      requestId: `req_team_budget_blocked_${Date.now()}`,
      clientId: "member-b",
      teamId,
      teamTokenBudgetPerMinute: 10,
      estimatedTokens: 1,
    });
    expect(admission.admitted).toBe(false);
    expect(admission.reason).toBe("team_token_budget_exceeded");
  });

  it("computes client usage rollups", async () => {
    const stub = getDoStub();
    const hour = Math.floor(Date.now() / 3600000) * 3600000;
    const requestId = `req_client_rollup_${Date.now()}`;
    await stub.storeUsageEvent({
      requestId,
      attemptIndex: 0,
      timestamp: hour + 1000,
      clientId: "demo-client-alpha",
      appId: "demo-app",
      policyId: "default-policy",
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
      clientId: "demo-client-alpha",
      appId: "demo-app",
      since: hour,
      until: hour,
    });

    const row = rollups.find((item) => item.clientId === "demo-client-alpha");
    expect(row).toBeDefined();
    expect(row!.appId).toBe("demo-app");
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

  it("does not reap active admitted reservations after the admit TTL", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-05-24T00:00:00Z"));
      const stub = getDoStub("test-do-active-reservation");
      const deploymentId = "deploy-active-reservation";
      const result = await stub.admit({
        requestId: "req_active_reservation",
        candidates: [{
          deploymentId,
          keyRef: "key-active",
          rpm: 100,
          maxParallel: 1,
          group: "test-group",
        }],
      });
      expect(result.admitted).toBe(true);

      vi.advanceTimersByTime(31_000);
      const reaped = await stub.reapExpired();
      const second = await stub.admit({
        requestId: "req_active_reservation_second",
        candidates: [{
          deploymentId,
          keyRef: "key-active",
          rpm: 100,
          maxParallel: 1,
          group: "test-group",
        }],
      });

      expect(reaped).toBe(0);
      expect(second.admitted).toBe(false);
      expect(second.rejected?.[0]?.reason).toBe("inflight_exhausted");
      await stub.release(result.reservationId!);
    } finally {
      vi.useRealTimers();
    }
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
