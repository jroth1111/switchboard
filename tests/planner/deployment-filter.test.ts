import { describe, it, expect } from "vitest";
import {
  filterCandidates,
  createEmptyFilterState,
  type FilterState,
} from "../../src/planner/deployment-filter";
import type { Deployment } from "../../src/config/schema";

function makeDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "deploy-1",
    group: "test-group",
    provider: "nvidia_nim",
    model: "test-model",
    providerModel: "test-model-v1",
    keyRef: "TEST_KEY",
    rpm: 35,
    maxParallelRequests: 2,
    timeout: 30,
    streamTimeout: 120,
    supportsStreaming: true,
    capabilities: {
      toolCalling: "native",
      streamingWithTools: "native",
      jsonMode: "native",
      reasoning: "native",
      multimodal: "native",
    },
    contextWindow: 128000,
    hidden: false,
    ...overrides,
  };
}

describe("Deployment pre-routing filter", () => {
  it("passes healthy deployments", () => {
    const state = createEmptyFilterState();
    const candidates = [makeDeployment()];
    const result = filterCandidates(candidates, state, Date.now());
    expect(result.passed).toHaveLength(1);
    expect(result.rejected).toHaveLength(0);
  });

  it("rejects deployments in cooldown", () => {
    const state = createEmptyFilterState();
    state.cooldowns.set("deploy-1", { until: Date.now() + 30000 });
    const candidates = [makeDeployment()];
    const result = filterCandidates(candidates, state, Date.now());
    expect(result.passed).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("cooldown");
  });

  it("passes deployments with expired cooldown", () => {
    const state = createEmptyFilterState();
    state.cooldowns.set("deploy-1", { until: Date.now() - 1000 });
    const candidates = [makeDeployment()];
    const result = filterCandidates(candidates, state, Date.now());
    expect(result.passed).toHaveLength(1);
  });

  it("rejects deployments with open circuit", () => {
    const state = createEmptyFilterState();
    state.circuits.set("deploy-1", { state: "open", halfOpenAfter: Date.now() + 300000 });
    const candidates = [makeDeployment()];
    const result = filterCandidates(candidates, state, Date.now());
    expect(result.passed).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("circuit_open");
  });

  it("passes deployments with half-open circuit after halfOpenAfter", () => {
    const state = createEmptyFilterState();
    state.circuits.set("deploy-1", { state: "open", halfOpenAfter: Date.now() - 1000 });
    const candidates = [makeDeployment()];
    const result = filterCandidates(candidates, state, Date.now());
    expect(result.passed).toHaveLength(1);
  });

  it("rejects half-open probe deployments when inflight already has the single allowed slot", () => {
    const state = createEmptyFilterState();
    state.circuits.set("deploy-1", { state: "half_open" });
    state.inflight.set("deploy-1", 1);
    const candidates = [makeDeployment({ maxParallelRequests: 4 })];
    const result = filterCandidates(candidates, state, Date.now());
    expect(result.passed).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("inflight_exhausted");
  });

  it("rejects deployments at inflight capacity", () => {
    const state = createEmptyFilterState();
    state.inflight.set("deploy-1", 2);
    const candidates = [makeDeployment({ maxParallelRequests: 2 })];
    const result = filterCandidates(candidates, state, Date.now());
    expect(result.passed).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("inflight_exhausted");
  });

  it("respects learned concurrency limits", () => {
    const state = createEmptyFilterState();
    state.learnedLimits.set("deploy-1", { maxParallel: 1 });
    state.inflight.set("deploy-1", 1);
    const candidates = [makeDeployment({ maxParallelRequests: 4 })];
    const result = filterCandidates(candidates, state, Date.now());
    expect(result.passed).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("inflight_exhausted");
  });

  it("ignores expired learned limits", () => {
    const state = createEmptyFilterState();
    state.learnedLimits.set("deploy-1", { maxParallel: 1, expiresAt: Date.now() - 1000 });
    state.inflight.set("deploy-1", 2);
    const candidates = [makeDeployment({ maxParallelRequests: 4 })];
    const result = filterCandidates(candidates, state, Date.now());
    expect(result.passed).toHaveLength(1);
  });

  it("rejects deployments with exhausted key RPM", () => {
    const state = createEmptyFilterState();
    const now = Date.now();
    // Use second-granularity millisecond timestamp matching admission engine
    const windowStart = Math.floor(now / 1000) * 1000;
    state.keyWindows.set("test-group:TEST_KEY", { windowStart, count: 35 });
    const candidates = [makeDeployment({ rpm: 35 })];
    const result = filterCandidates(candidates, state, now);
    expect(result.passed).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("key_rpm_exhausted");
  });

  it("rejects deployments with exhausted group RPM", () => {
    const state = createEmptyFilterState();
    const now = Date.now();
    const windowStart = Math.floor(now / 1000) * 1000;
    state.groupWindows.set("test-group", { windowStart, count: 2 });

    const result = filterCandidates([makeDeployment()], state, now, "per_key", { rpmLimit: 2 });

    expect(result.passed).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("group_rpm_exhausted");
  });

  it("rejects deployments with exhausted token budget", () => {
    const state = createEmptyFilterState();
    const now = Date.now();
    const windowStart = Math.floor(now / 1000) * 1000;
    state.tokenWindows.set("TEST_KEY", { windowStart, promptTokens: 50, completionTokens: 50 });

    const result = filterCandidates([makeDeployment()], state, now, "per_key", { tokenBudgetPerMinute: 100 });

    expect(result.passed).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("token_budget_exhausted");
  });

  it("passes deployments in different RPM window", () => {
    const state = createEmptyFilterState();
    // Old window — 2 minutes ago, well outside 60s overlap
    state.keyWindows.set("test-group:TEST_KEY", { windowStart: Date.now() - 120000, count: 100 });
    const candidates = [makeDeployment({ rpm: 35 })];
    const result = filterCandidates(candidates, state, Date.now());
    expect(result.passed).toHaveLength(1);
  });

  it("scopes key RPM by lane so the same key in another group is not starved", () => {
    const state = createEmptyFilterState();
    const now = Date.now();
    const windowStart = Math.floor(now / 1000) * 1000;
    state.keyWindows.set("tool-lane:TEST_KEY", { windowStart, count: 35 });

    const candidates = [makeDeployment({ group: "chat-lane", keyRef: "TEST_KEY", rpm: 35 })];
    const result = filterCandidates(candidates, state, now);

    expect(result.passed).toHaveLength(1);
  });

  it("filters mixed candidate list", () => {
    const state = createEmptyFilterState();
    state.cooldowns.set("deploy-1", { until: Date.now() + 30000 });
    state.circuits.set("deploy-2", { state: "open", halfOpenAfter: Date.now() + 300000 });

    const candidates = [
      makeDeployment({ id: "deploy-1" }),
      makeDeployment({ id: "deploy-2" }),
      makeDeployment({ id: "deploy-3" }),
    ];

    const result = filterCandidates(candidates, state, Date.now());
    expect(result.passed).toHaveLength(1);
    expect(result.passed[0].deployment.id).toBe("deploy-3");
    expect(result.rejected).toHaveLength(2);
  });

  it("rejects quarantined deployments and keeps suspect deployments probeable", () => {
    const state = createEmptyFilterState();
    state.healthScores.set("deploy-1", { consecutiveFailureCount: 5 });
    state.healthScores.set("deploy-2", { consecutiveFailureCount: 5 });
    state.circuits.set("deploy-2", { state: "suspect", failureCount: 5 });

    const result = filterCandidates([
      makeDeployment({ id: "deploy-1" }),
      makeDeployment({ id: "deploy-2" }),
    ], state, Date.now(), "per_key", { quarantineFailureThreshold: 5 });

    expect(result.rejected).toHaveLength(1);
    expect(result.rejected[0].deployment.id).toBe("deploy-1");
    expect(result.rejected[0].reason).toBe("quarantine");
    expect(result.passed[0].deployment.id).toBe("deploy-2");
  });

  it("applies policy max-parallel override and suspect throttling", () => {
    const state = createEmptyFilterState();
    state.inflight.set("deploy-1", 1);
    state.circuits.set("deploy-1", { state: "suspect" });

    const result = filterCandidates(
      [makeDeployment({ maxParallelRequests: 8 })],
      state,
      Date.now(),
      "per_key",
      { maxParallelOverride: 4, suspectMaxParallelDivisor: 4 },
    );

    expect(result.passed).toHaveLength(0);
    expect(result.rejected[0].reason).toBe("inflight_exhausted");
  });
});
