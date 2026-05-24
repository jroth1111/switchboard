import { describe, it, expect } from "vitest";
import { buildHealthReport, verifyHealthAuth, buildFailureSummary } from "../../src/probes/health-endpoint";
import type { RouteReceipt } from "../../src/observability/receipt";

describe("Health endpoint auth", () => {
  it("accepts valid bearer token", () => {
    const req = new Request("https://example.com/nim/health", {
      headers: { Authorization: "Bearer test-token-123" },
    });
    expect(verifyHealthAuth(req, "test-token-123")).toBe(true);
  });

  it("rejects wrong token", () => {
    const req = new Request("https://example.com/nim/health", {
      headers: { Authorization: "Bearer wrong-token" },
    });
    expect(verifyHealthAuth(req, "test-token-123")).toBe(false);
  });

  it("rejects missing auth header", () => {
    const req = new Request("https://example.com/nim/health");
    expect(verifyHealthAuth(req, "test-token-123")).toBe(false);
  });

  it("rejects malformed auth header", () => {
    const req = new Request("https://example.com/nim/health", {
      headers: { Authorization: "Basic abc123" },
    });
    expect(verifyHealthAuth(req, "test-token-123")).toBe(false);
  });

  it("returns false when no token configured", () => {
    const req = new Request("https://example.com/nim/health");
    expect(verifyHealthAuth(req, "")).toBe(false);
  });
});

describe("buildFailureSummary", () => {
  it("builds summary from receipt", () => {
    const receipt: RouteReceipt = {
      requestId: "req-123",
      timestamp: Date.now(),
      originalModel: "glm-5.1",
      canonicalTarget: "smart-route-worker",
      selectedGroup: "nim-primary",
      fallbackGroups: ["nim-deepseek-v4-pro"],
      attempts: [
        { group: "nim-primary", deploymentId: "nim-primary-key-1", failureClass: "server_5xx", action: "retry_fallback", durationMs: 500 },
        { group: "nim-deepseek-v4-pro", deploymentId: "nim-deepseek-v4-pro-key-1", action: "accept", durationMs: 300 },
      ],
      finalOutcome: "success",
      stream: false,
    };

    const summary = buildFailureSummary(receipt);
    expect(summary.requestId).toBe("req-123");
    expect(summary.outcome).toBe("success");
    expect(summary.attempts).toHaveLength(2);
    expect(summary.attempts[0].failureClass).toBe("server_5xx");
  });

  it("strips failure messages from summary", () => {
    const receipt: RouteReceipt = {
      requestId: "req-456",
      timestamp: Date.now(),
      originalModel: "glm-5.1",
      canonicalTarget: "smart-route-worker",
      selectedGroup: "nim-primary",
      fallbackGroups: [],
      attempts: [
        { group: "nim-primary", failureClass: "exhausted", failureMessage: "secret internal error", action: "exhausted", durationMs: 1000 },
      ],
      finalOutcome: "exhausted",
      stream: false,
    };

    const summary = buildFailureSummary(receipt);
    // failureMessage should not be in the summary (it's omitted from the mapping)
    expect(summary.attempts[0]).not.toHaveProperty("failureMessage");
    expect(summary.attempts[0].failureClass).toBe("exhausted");
  });
});

describe("buildHealthReport", () => {
  it("reports degraded when some groups have no deployments", async () => {
    const mockStateDo = {
      getHealth: async () => ({
        circuits: {},
        healthScores: {},
        cooldowns: {},
      }),
    };

    const report = await buildHealthReport(mockStateDo as any);
    // Some visible groups like nim-secondary have no deployments, so status is degraded
    expect(report.status).toBe("degraded");
    expect(report.routeGroups).toBeDefined();
    expect(report.timestamp).toBeGreaterThan(0);
  });

  it("reports unhealthy when all groups have open circuits", async () => {
    const { MANIFEST } = await import("../../src/config/manifest");
    const circuits: Record<string, unknown> = {};
    // Mark all deployments of visible groups as circuit-open
    for (const [name, rg] of Object.entries(MANIFEST.routeGroups)) {
      if (rg.hidden) continue;
      const deployments = MANIFEST.deploymentsByGroup[name] ?? [];
      for (const d of deployments) {
        circuits[d.id] = { state: "open", failureCount: 5, successCount: 0, updatedAt: Date.now() };
      }
    }

    const mockStateDo = {
      getHealth: async () => ({ circuits, healthScores: {}, cooldowns: {} }),
    };

    const report = await buildHealthReport(mockStateDo as any);
    expect(report.status).toBe("unhealthy");
  });

  it("includes planner settings in health output", async () => {
    const mockStateDo = {
      getHealth: async () => ({ circuits: {}, healthScores: {}, cooldowns: {} }),
    };

    const report = await buildHealthReport(mockStateDo as any);
    expect(report.plannerSettings).toBeDefined();
    expect(typeof report.plannerSettings.healthFallbackMargin).toBe("number");
    expect(typeof report.plannerSettings.recentDispatchBonus).toBe("number");
  });

  it("reports available/blocked deployment counts", async () => {
    const mockStateDo = {
      getHealth: async () => ({ circuits: {}, healthScores: {}, cooldowns: {} }),
    };

    const report = await buildHealthReport(mockStateDo as any);
    for (const [name, group] of Object.entries(report.routeGroups)) {
      expect(group.availableDeployments).toBeGreaterThanOrEqual(0);
      expect(group.blockedDeployments).toBeGreaterThanOrEqual(0);
      expect(group.availableDeployments + group.blockedDeployments).toBe(group.deployments);
    }
  });

  it("omits avgHealthScore when all deployments are blocked", async () => {
    const { MANIFEST } = await import("../../src/config/manifest");
    const groupName = "nim-primary";
    const deployments = MANIFEST.deploymentsByGroup[groupName] ?? [];
    const circuits: Record<string, unknown> = {};
    const healthScores: Record<string, { score: number }> = {};
    for (const d of deployments) {
      circuits[d.id] = { state: "open", failureCount: 5, successCount: 0 };
      healthScores[d.id] = { score: 95 };
    }

    const report = await buildHealthReport({
      getHealth: async () => ({ circuits, healthScores, cooldowns: {} }),
    } as any);

    expect(report.routeGroups[groupName].available).toBe(false);
    expect(report.routeGroups[groupName].avgHealthScore).toBeUndefined();
  });

  it("reports half_open circuitState when deployments are recovering", async () => {
    const { MANIFEST } = await import("../../src/config/manifest");
    const groupName = "nim-primary";
    const deployment = MANIFEST.deploymentsByGroup[groupName]?.[0];
    expect(deployment).toBeDefined();

    const report = await buildHealthReport({
      getHealth: async () => ({
        circuits: { [deployment!.id]: { state: "half_open", failureCount: 1, successCount: 0 } },
        healthScores: {},
        cooldowns: {},
      }),
    } as any);

    expect(report.routeGroups[groupName].circuitState).toBe("half_open");
    expect(report.routeGroups[groupName].available).toBe(true);
  });
});
