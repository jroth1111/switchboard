import { describe, expect, it } from "vitest";
import { MANIFEST } from "../../src/config/manifest";
import { orderAttemptSequenceByDurableHealth } from "../../src/attempts/attempt-loop";
import type { Deployment } from "../../src/config/schema";
import type { RequestEnvelope } from "../../src/planner/planner";

function deployment(id: string, group: string): Deployment {
  return {
    id,
    group,
    provider: "nvidia_nim",
    model: id,
    providerModel: id,
    keyRef: `${id.toUpperCase()}_KEY`,
    rpm: 100,
    maxParallelRequests: 4,
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
  };
}

function envelope(overrides: Partial<RequestEnvelope> = {}): RequestEnvelope {
  return {
    requestId: "req-health-route",
    originalModel: "smart-route",
    body: { model: "smart-route", messages: [{ role: "user", content: "hello" }] },
    stream: false,
    hasTools: false,
    hasStrictTools: false,
    isMultiTool: false,
    hasTypedContent: false,
    requiresJsonMode: false,
    requiresReasoning: false,
    ...overrides,
  };
}

describe("Durable health attempt ordering", () => {
  const primary = {
    group: "primary",
    policy: MANIFEST.defaultPolicy,
    deployments: [deployment("primary-deploy", "primary")],
  };
  const fallback = {
    group: "fallback",
    policy: MANIFEST.defaultPolicy,
    deployments: [deployment("fallback-deploy", "fallback")],
  };

  it("promotes a healthier fallback when the primary is outside the health margin", async () => {
    const ordered = await orderAttemptSequenceByDurableHealth(
      [primary, fallback],
      { canonicalTarget: "smart-route-worker" },
      envelope(),
      {
        getHealth: async () => ({
          healthScores: {
            "primary-deploy": {
              score: 10,
              successCount: 5,
              failureCount: 5,
              consecutiveFailureCount: 5,
              updatedAt: Date.now(),
            },
            "fallback-deploy": {
              score: 100,
              successCount: 5,
              failureCount: 0,
              consecutiveFailureCount: 0,
              updatedAt: Date.now(),
            },
          },
        }),
      },
    );

    expect(ordered.map((entry) => entry.group)).toEqual(["fallback", "primary"]);
  });

  it("preserves primary ordering when health is within the configured fallback margin", async () => {
    const ordered = await orderAttemptSequenceByDurableHealth(
      [primary, fallback],
      { canonicalTarget: "smart-route-worker" },
      envelope(),
      {
        getHealth: async () => ({
          healthScores: {
            "primary-deploy": {
              score: 97,
              successCount: 5,
              failureCount: 1,
              consecutiveFailureCount: 0,
              updatedAt: Date.now(),
            },
            "fallback-deploy": {
              score: 100,
              successCount: 5,
              failureCount: 0,
              consecutiveFailureCount: 0,
              updatedAt: Date.now(),
            },
          },
        }),
      },
    );

    expect(ordered.map((entry) => entry.group)).toEqual(["primary", "fallback"]);
  });

  it("does not route to a primary whose durable cooldown is still active", async () => {
    const ordered = await orderAttemptSequenceByDurableHealth(
      [primary, fallback],
      { canonicalTarget: "smart-route-worker" },
      envelope(),
      {
        getHealth: async () => ({
          cooldowns: {
            "primary-deploy": { until: Date.now() + 60_000 },
          },
          healthScores: {
            "primary-deploy": {
              score: 100,
              successCount: 5,
              failureCount: 0,
              consecutiveFailureCount: 0,
              updatedAt: Date.now(),
            },
            "fallback-deploy": {
              score: 90,
              successCount: 5,
              failureCount: 0,
              consecutiveFailureCount: 0,
              updatedAt: Date.now(),
            },
          },
        }),
      },
    );

    expect(ordered.map((entry) => entry.group)).toEqual(["fallback", "primary"]);
  });

  it("keeps static plan order when durable health is unavailable", async () => {
    const ordered = await orderAttemptSequenceByDurableHealth(
      [primary, fallback],
      { canonicalTarget: "smart-route-worker" },
      envelope(),
      {},
    );

    expect(ordered.map((entry) => entry.group)).toEqual(["primary", "fallback"]);
  });

  it("treats half-open circuit as available with effectiveMax=1 for ordering", async () => {
    const now = Date.now();
    const ordered = await orderAttemptSequenceByDurableHealth(
      [primary, fallback],
      { canonicalTarget: "smart-route-worker" },
      envelope(),
      {
        getHealth: async () => ({
          circuits: {
            "primary-deploy": { state: "half_open", halfOpenAfter: now - 1000 },
          },
          inflight: {
            "primary-deploy": { count: 0 },
          },
          healthScores: {
            "primary-deploy": {
              score: 80,
              successCount: 3,
              failureCount: 3,
              consecutiveFailureCount: 0,
              updatedAt: now,
            },
            "fallback-deploy": {
              score: 100,
              successCount: 5,
              failureCount: 0,
              consecutiveFailureCount: 0,
              updatedAt: now,
            },
          },
        }),
      },
    );

    // Half-open deployment is still available (0 inflight, effectiveMax=1)
    expect(ordered[0].group).toBe("fallback");
    expect(ordered.map((e) => e.group)).toContain("primary");
  });

  it("rejects half-open deployment when inflight=1 (effectiveMax=1)", async () => {
    const now = Date.now();
    const ordered = await orderAttemptSequenceByDurableHealth(
      [primary, fallback],
      { canonicalTarget: "smart-route-worker" },
      envelope(),
      {
        getHealth: async () => ({
          circuits: {
            "primary-deploy": { state: "half_open", halfOpenAfter: now - 1000 },
          },
          inflight: {
            "primary-deploy": { count: 1 },
          },
          healthScores: {
            "primary-deploy": {
              score: 80,
              successCount: 3,
              failureCount: 3,
              consecutiveFailureCount: 0,
              updatedAt: now,
            },
            "fallback-deploy": {
              score: 100,
              successCount: 5,
              failureCount: 0,
              consecutiveFailureCount: 0,
              updatedAt: now,
            },
          },
        }),
      },
    );

    // Primary is unavailable (half-open with inflight=1 >= effectiveMax=1)
    expect(ordered[0].group).toBe("fallback");
  });
});
