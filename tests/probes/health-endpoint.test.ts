import { describe, it, expect, vi } from "vitest";
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

  it("keeps legacy health JSON fields while exposing additive diagnostics", async () => {
    const mockStateDo = {
      getHealth: async () => ({ circuits: {}, healthScores: {}, cooldowns: {} }),
    };

    const report = await buildHealthReport(mockStateDo as any);
    const json = JSON.parse(JSON.stringify(report)) as Record<string, unknown>;

    expect(json).toEqual(expect.objectContaining({
      status: expect.any(String),
      timestamp: expect.any(Number),
      routeGroups: expect.any(Object),
      recentOutcomes: expect.objectContaining({
        total: expect.any(Number),
        success: expect.any(Number),
        exhausted: expect.any(Number),
        clientError: expect.any(Number),
      }),
      circuitBreakers: expect.any(Object),
      cooldowns: expect.any(Object),
    }));
    expect(json).toEqual(expect.objectContaining({
      requestShapes: expect.any(Object),
      aliasVisibility: expect.any(Object),
      deploymentDiagnostics: expect.any(Object),
      workerPressure: expect.any(Object),
      plannerSettings: expect.any(Object),
    }));
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

  it("exposes alias visibility and request-shape dispatchability for operator aliases", async () => {
    const mockStateDo = {
      getHealth: async () => ({ circuits: {}, healthScores: {}, cooldowns: {}, inflight: {}, learnedLimits: {} }),
    };

    const report = await buildHealthReport(mockStateDo);

    expect(report.requestShapes.strict_tool.operation).toBe("strict_tool");
    expect(report.requestShapes.typed_content.hasTypedContent).toBe(false);
    expect(report.requestShapes.multimodal.hasTypedContent).toBe(true);
    expect(report.aliasVisibility.worker.canonicalTarget).toBe("smart-route-worker");
    expect(report.aliasVisibility.worker.requestShapes.chat.dispatchable).toBe(true);
    expect(report.aliasVisibility["glm-5.1"].requestShapes.chat.dispatchable).toBe(true);
    expect(report.aliasVisibility["proxy-worker-smart-router"].requestShapes.strict_tool.dispatchable).toBe(true);
    expect(report.aliasVisibility["proxy-worker-smart-router"].requestShapes.strict_tool.dispatchableCandidates.some(
      (candidate) => candidate.group === "nim-tool-primary",
    )).toBe(true);
    expect(report.aliasVisibility["gpt-5.5"].requestShapes.responses.dispatchable).toBe(true);
    expect(report.aliasVisibility["claude-opus-4-7"].requestShapes.chat.dispatchable).toBe(true);
    expect(report.aliasVisibility["nim-primary"].requestShapes.chat.dispatchable).toBe(true);
  });

  it("exposes recent route-dispatch metadata for the matching alias request shape", async () => {
    const now = Date.UTC(2026, 4, 24, 9, 0, 0);
    const dispatchedAt = now - 1_000;
    const getRecentRouteDispatch = vi.fn(async () => {
      throw new Error("health report should use snapshot dispatch memory");
    });
    const mockStateDo = {
      getHealth: async () => ({
        circuits: {},
        healthScores: {},
        cooldowns: {},
        inflight: {},
        learnedLimits: {},
        routeDispatchMemory: {
          "smart-route-worker": {
            chat: { group: "nim-primary", dispatchedAt },
          },
        },
      }),
      getRecentRouteDispatch,
    };

    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const report = await buildHealthReport(mockStateDo);
      const chat = report.aliasVisibility.worker.requestShapes.chat;

      expect(chat.recentDispatch).toEqual({
        alias: "worker",
        canonicalTarget: "smart-route-worker",
        requestShape: "chat",
        requestClass: "chat",
        group: "nim-primary",
        dispatchedAt,
      });
      expect(getRecentRouteDispatch).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("omits recent route-dispatch metadata when dispatch memory is missing", async () => {
    const mockStateDo = {
      getHealth: async () => ({ circuits: {}, healthScores: {}, cooldowns: {}, inflight: {}, learnedLimits: {} }),
      getRecentRouteDispatch: vi.fn(async () => null),
    };

    const report = await buildHealthReport(mockStateDo);
    const chat = report.aliasVisibility.worker.requestShapes.chat;

    expect(chat.dispatchable).toBe(true);
    expect(chat).not.toHaveProperty("recentDispatch");
  });

  it("reports a healthy deployment as non-dispatchable for an unsupported request shape", async () => {
    const mockStateDo = {
      getHealth: async () => ({
        circuits: {},
        healthScores: {
          "nim-primary-key-1": {
            score: 100,
            updatedAt: Date.now(),
            successCount: 3,
            failureCount: 0,
            consecutiveFailureCount: 0,
            latencySampleCount: 1,
          },
        },
        cooldowns: {},
        inflight: {},
        learnedLimits: {},
      }),
    };

    const report = await buildHealthReport(mockStateDo);
    const strictTool = report.aliasVisibility["nim-primary"].requestShapes.strict_tool;

    expect(report.routeGroups["nim-primary"].available).toBe(true);
    expect(report.deploymentDiagnostics["nim-primary-key-1"].pressure.category).toBe("healthy");
    expect(strictTool.dispatchable).toBe(false);
    expect(strictTool.rejectedCandidates.some((candidate) => candidate.reason === "non_native_strict_tools")).toBe(true);
  });

  it("applies live admission windows when reporting dispatchability", async () => {
    const { MANIFEST } = await import("../../src/config/manifest");
    const now = Date.UTC(2026, 4, 24, 5, 30, 0);
    const keyWindows = Object.fromEntries(MANIFEST.deployments.map((deployment) => [
      `${deployment.group}:${deployment.keyRef}`,
      { windowStart: now, count: deployment.rpm },
    ]));
    const mockStateDo = {
      getHealth: async () => ({
        circuits: {},
        healthScores: {},
        cooldowns: {},
        inflight: {},
        learnedLimits: {},
        keyWindows,
        groupWindows: {},
        tokenWindows: {},
      }),
    };

    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const report = await buildHealthReport(mockStateDo);
      const chat = report.aliasVisibility["nim-primary"].requestShapes.chat;
      expect(chat.dispatchable).toBe(false);
      expect(chat.rejectedCandidates.some((candidate) => candidate.reason === "key_rpm_exhausted")).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("includes per-deployment diagnostics from health state and recent outcomes", async () => {
    const now = Date.UTC(2026, 4, 24, 6, 0, 0);
    const deploymentId = "nim-primary-key-1";
    const receipt: RouteReceipt = {
      requestId: "req-diagnostic",
      timestamp: now - 1_000,
      originalModel: "glm-5.1",
      canonicalTarget: "smart-route-worker",
      selectedGroup: "nim-primary",
      fallbackGroups: [],
      attempts: [{
        group: "nim-primary",
        deploymentId,
        failureClass: "rate_limit_quota_window",
        action: "retry_fallback",
        durationMs: 1234,
        firstByteLatencyMs: 456,
      }],
      finalOutcome: "exhausted",
      stream: false,
    };
    const mockStateDo = {
      getHealth: async () => ({
        circuits: { [deploymentId]: { state: "suspect", failureCount: 2, successCount: 1, updatedAt: now - 2_000 } },
        healthScores: {
          [deploymentId]: {
            score: 73,
            lastSuccessAt: now - 30_000,
            lastFailureAt: now - 5_000,
            failureClass: "rate_limit_quota_window",
            updatedAt: now - 5_000,
            successCount: 7,
            failureCount: 2,
            consecutiveFailureCount: 1,
            latencyEmaMs: 900,
            latencySampleCount: 6,
            rollingMetrics: {
              recentOutcomeCount: 8,
              recentFailureRate: 0.25,
              timeoutRate: 0.125,
              invalidSuccessRate: 0,
              p95FirstByteLatencyMs: 456,
              p95TotalLatencyMs: 1234,
            },
          },
        },
        cooldowns: { [deploymentId]: { reason: "rate_limit_quota_window", until: now + 60_000 } },
        inflight: { [deploymentId]: { count: 1, updatedAt: now - 100 } },
        learnedLimits: { [deploymentId]: { maxParallel: 1, reason: "rate_limit_concurrency", expiresAt: now + 30_000 } },
      }),
      getRecentReceipts: async () => [receipt],
    };

    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const report = await buildHealthReport(mockStateDo);
      const diagnostic = report.deploymentDiagnostics[deploymentId];

      expect(diagnostic.healthScore).toBe(73);
      expect(diagnostic.circuit?.state).toBe("suspect");
      expect(diagnostic.cooldown).toMatchObject({ reason: "rate_limit_quota_window", active: true });
      expect(diagnostic.inflight.count).toBe(1);
      expect(diagnostic.learnedConcurrencyLimit).toMatchObject({ maxParallel: 1, active: true });
      expect(diagnostic.health?.rollingMetrics?.p95TotalLatencyMs).toBe(1234);
      expect(diagnostic.recentOutcome).toMatchObject({
        requestId: "req-diagnostic",
        finalOutcome: "exhausted",
        failureClass: "rate_limit_quota_window",
      });
      expect(diagnostic.pressure.category).toBe("cooldown");
    } finally {
      vi.useRealTimers();
    }
  });

  it("summarizes worker pressure categories from current state and recent outcomes", async () => {
    const now = Date.UTC(2026, 4, 24, 7, 0, 0);
    const healthyId = "nim-primary-key-8";
    const quotaId = "nim-primary-key-1";
    const concurrencyId = "nim-primary-key-2";
    const timeoutId = "nim-primary-key-3";
    const malformedId = "nim-primary-key-4";
    const cooldownId = "nim-primary-key-5";
    const circuitId = "nim-primary-key-6";
    const score = (failureClass: string, rollingMetrics = {}) => ({
      score: 60,
      failureClass,
      updatedAt: now - 1_000,
      successCount: 3,
      failureCount: 2,
      consecutiveFailureCount: 1,
      latencySampleCount: 5,
      rollingMetrics,
    });
    const mockStateDo = {
      getHealth: async () => ({
        circuits: {
          [circuitId]: { state: "open", failureCount: 5, successCount: 0, halfOpenAfter: now + 60_000, updatedAt: now - 1_000 },
        },
        healthScores: {
          [quotaId]: score("rate_limit_quota_window"),
          [timeoutId]: score("transport_timeout", { recentOutcomeCount: 5, recentFailureRate: 0.4, timeoutRate: 0.4, invalidSuccessRate: 0 }),
          [malformedId]: score("malformed_response", { recentOutcomeCount: 5, recentFailureRate: 0.4, timeoutRate: 0, invalidSuccessRate: 0.4 }),
        },
        cooldowns: {
          [cooldownId]: { reason: "transport_timeout", until: now + 60_000 },
        },
        inflight: {
          [concurrencyId]: { count: 1, updatedAt: now },
        },
        learnedLimits: {
          [concurrencyId]: { maxParallel: 1, reason: "rate_limit_concurrency", expiresAt: now + 60_000 },
        },
      }),
    };

    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const report = await buildHealthReport(mockStateDo);
      const byCategory = report.workerPressure.deploymentsByCategory;

      expect(byCategory.healthy).toContain(healthyId);
      expect(byCategory.quota_window_pressure).toContain(quotaId);
      expect(byCategory.concurrency_pressure).toContain(concurrencyId);
      expect(byCategory.timeout_pressure).toContain(timeoutId);
      expect(byCategory.malformed_output_pressure).toContain(malformedId);
      expect(byCategory.cooldown).toContain(cooldownId);
      expect(byCategory.circuit_open).toContain(circuitId);
      expect(report.workerPressure.routeGroupsByCategory.unavailable).toContain("nim-secondary");
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not report stale failure pressure after a newer success", async () => {
    const now = Date.UTC(2026, 4, 24, 8, 0, 0);
    const deploymentId = "nim-primary-key-1";
    const mockStateDo = {
      getHealth: async () => ({
        circuits: {},
        healthScores: {
          [deploymentId]: {
            score: 100,
            lastFailureAt: now - 60_000,
            lastSuccessAt: now - 1_000,
            failureClass: "rate_limit_concurrency",
            updatedAt: now - 1_000,
            successCount: 4,
            failureCount: 1,
            consecutiveFailureCount: 0,
            latencySampleCount: 4,
          },
        },
        cooldowns: {},
        inflight: {},
        learnedLimits: {},
      }),
    };

    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const report = await buildHealthReport(mockStateDo);
      expect(report.deploymentDiagnostics[deploymentId].pressure.category).toBe("healthy");
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the latest same-deployment receipt attempt when classifying pressure", async () => {
    const now = Date.UTC(2026, 4, 24, 8, 30, 0);
    const deploymentId = "nim-primary-key-1";
    const receipt: RouteReceipt = {
      requestId: "req-recovered",
      timestamp: now - 1_000,
      originalModel: "glm-5.1",
      canonicalTarget: "smart-route-worker",
      selectedGroup: "nim-primary",
      fallbackGroups: [],
      attempts: [
        {
          group: "nim-primary",
          deploymentId,
          failureClass: "transport_timeout",
          action: "retry_fallback",
          durationMs: 1000,
        },
        {
          group: "nim-primary",
          deploymentId,
          action: "accept",
          durationMs: 1500,
        },
      ],
      finalOutcome: "success",
      stream: false,
    };
    const mockStateDo = {
      getHealth: async () => ({
        circuits: {},
        healthScores: {},
        cooldowns: {},
        inflight: {},
        learnedLimits: {},
      }),
      getRecentReceipts: async () => [receipt],
    };

    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const report = await buildHealthReport(mockStateDo);
      expect(report.deploymentDiagnostics[deploymentId].recentOutcome).toMatchObject({
        requestId: "req-recovered",
        action: "accept",
      });
      expect(report.deploymentDiagnostics[deploymentId].pressure.category).toBe("healthy");
    } finally {
      vi.useRealTimers();
    }
  });
});
