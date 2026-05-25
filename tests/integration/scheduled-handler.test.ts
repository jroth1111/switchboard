import { describe, it, expect, vi } from "vitest";
import { env } from "cloudflare:test";
import worker from "../../src/index";
import type { ControlPlaneStateDO } from "../../src/state/control-plane-state";

const CONTROL_PLANE_STATE_NAME = "control-plane";

function getDoStub(): ControlPlaneStateDO {
  const id = env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME);
  return env.CONTROL_PLANE_STATE.get(id) as unknown as ControlPlaneStateDO;
}

describe("Scheduled handler integration", () => {
  it("DO methods used by scheduled handler work with real SQLite", async () => {
    const stub = getDoStub();

    // recordSuccess → health score should appear
    await stub.recordSuccess("sched-deploy-1", 3);
    const health = await stub.getHealth();
    const scores = health.healthScores as Record<string, unknown>;
    expect(scores["sched-deploy-1"]).toBeDefined();

    // recordFailure → health should decay and cooldown should apply
    await stub.recordFailure("sched-deploy-1", "server_5xx", 30, 5, 300);
    const healthAfter = await stub.getHealth();
    const scoresAfter = healthAfter.healthScores as Record<string, unknown>;
    const entry = scoresAfter["sched-deploy-1"] as Record<string, unknown>;
    expect((entry.score as number)).toBeLessThan(100);

    // reapExpired should not throw
    const reaped = await stub.reapExpired();
    expect(typeof reaped).toBe("number");
  });

  it("records canary results from scheduled handler", async () => {
    const stub = getDoStub();

    await stub.storeCanaryResult({
      deploymentId: "sched-canary-1",
      group: "group-a",
      success: true,
      latencyMs: 120,
      statusCode: 200,
    });

    const results = await stub.getCanaryResults(10);
    const found = results.find(
      (r) => (r as Record<string, unknown>).deploymentId === "sched-canary-1",
    );
    expect(found).toBeDefined();
    expect((found as Record<string, unknown>).success).toBe(true);
  });

  it("canary results prune to last 100 entries", async () => {
    const stub = getDoStub();
    const prefix = `prune-${Date.now()}-deploy`;

    // Insert 105 results — oldest 5 should be pruned, 100 kept
    for (let i = 0; i < 105; i++) {
      await stub.storeCanaryResult({
        deploymentId: `${prefix}-${i}`,
        group: "prune-group",
        success: i % 2 === 0,
        latencyMs: i * 10,
      });
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const results = await stub.getCanaryResults(200);
    const pruneResults = results.filter(
      (r) => ((r as Record<string, unknown>).deploymentId as string).startsWith(prefix),
    );
    expect(pruneResults.length).toBe(100);
    const deploymentIds = new Set(pruneResults.map(
      (r) => (r as Record<string, unknown>).deploymentId as string,
    ));
    expect(deploymentIds.has(`${prefix}-0`)).toBe(false);
    expect(deploymentIds.has(`${prefix}-4`)).toBe(false);
    expect(deploymentIds.has(`${prefix}-5`)).toBe(true);
    expect(deploymentIds.has(`${prefix}-104`)).toBe(true);
  });

  it("hourly cron computes usage rollups", async () => {
    const stub = getDoStub();
    const hour = Math.floor(Date.now() / 3600000) * 3600000;
    const requestId = `sched-usage-${Date.now()}`;

    await stub.storeUsageEvent({
      requestId,
      attemptIndex: 0,
      timestamp: hour + 1000,
      clientId: "sched-client",
      appId: "sched-app",
      policyId: "sched-policy",
      canonicalTarget: "sched-target",
      selectedGroup: "sched-usage-group",
      deploymentId: "sched-usage-deploy",
      provider: "fixture",
      model: "fixture-model",
      stream: false,
      finalOutcome: "success",
      usageKind: "known",
      promptTokens: 11,
      completionTokens: 7,
      totalTokens: 18,
      usageSource: "test",
    });

    await worker.scheduled(
      { cron: "0 * * * *" } as ScheduledController,
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    );

    const rollups = await stub.queryRollups({
      group: "sched-usage-group",
      deploymentId: "sched-usage-deploy",
      since: hour,
      until: hour,
    });
    expect(rollups).toHaveLength(1);
    expect((rollups[0] as Record<string, unknown>).requests).toBe(1);
    expect((rollups[0] as Record<string, unknown>).knownRequests).toBe(1);
    expect((rollups[0] as Record<string, unknown>).totalTokens).toBe(18);
  });
});
