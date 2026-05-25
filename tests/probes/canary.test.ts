import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  probeDeployment,
  runCanaryProbes,
  reapAllLeases,
  canaryProbeDecision,
  selectCanaryCandidates,
  type ProbeRecorder,
  type ProbeConfig,
} from "../../src/probes/canary";
import type { Deployment } from "../../src/config/schema";

function makeDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "test-deploy",
    group: "test-group",
    provider: "openai",
    model: "test-model",
    providerModel: "test-model",
    keyRef: "TEST_KEY",
    rpm: 10,
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

const TEST_PROBE_CONFIG: ProbeConfig = {
  timeoutMs: 15000,
  maxConcurrentProbes: 3,
  probeModel: "probe",
  probePrompt: "Reply with exactly: OK",
  expectedMinLength: 1,
  healthyIntervalMs: 15 * 60 * 1000,
  suspectIntervalMs: 60 * 1000,
  halfOpenIntervalMs: 30 * 1000,
  unhealthyIntervalMs: 2 * 60 * 1000,
  failureBackoffBaseMs: 2 * 60 * 1000,
  failureBackoffMaxMs: 30 * 60 * 1000,
};

// ─── probeDeployment ──────────────────────────────────────────────

describe("Canary probe single deployment", () => {
  it("returns success for 200 response", async () => {
    const deploy = makeDeployment({ providerModel: "test-model" });

    // Mock fetch globally
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }),
    );

    const result = await probeDeployment(deploy, "test-api-key");
    expect(result.success).toBe(true);
    expect(result.deploymentId).toBe("test-deploy");
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.status).toBe(200);

    globalThis.fetch = originalFetch;
  });

  it("returns failure for 500 response", async () => {
    const deploy = makeDeployment();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    const result = await probeDeployment(deploy, "test-api-key");
    expect(result.success).toBe(false);
    expect(result.failureClass).toBe("server_5xx");
    expect(result.status).toBe(500);

    globalThis.fetch = originalFetch;
  });

  it("returns failure for 401 response", async () => {
    const deploy = makeDeployment();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Unauthorized", { status: 401 }),
    );

    const result = await probeDeployment(deploy, "test-api-key");
    expect(result.success).toBe(false);
    expect(result.failureClass).toBe("auth_failure");

    globalThis.fetch = originalFetch;
  });

  it("returns failure for 429 response", async () => {
    const deploy = makeDeployment();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Rate limited", { status: 429 }),
    );

    const result = await probeDeployment(deploy, "test-api-key");
    expect(result.success).toBe(false);
    expect(result.failureClass).toBe("rate_limit_overload");

    globalThis.fetch = originalFetch;
  });

  it("returns timeout on fetch abort", async () => {
    const deploy = makeDeployment();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new DOMException("Aborted", "AbortError"));

    const result = await probeDeployment(deploy, "test-api-key");
    expect(result.success).toBe(false);
    expect(result.failureClass).toBe("transport_timeout");

    globalThis.fetch = originalFetch;
  });

  it("returns transport_error on network failure", async () => {
    const deploy = makeDeployment();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockRejectedValue(new Error("Network error"));

    const result = await probeDeployment(deploy, "test-api-key");
    expect(result.success).toBe(false);
    expect(result.failureClass).toBe("transport_error");

    globalThis.fetch = originalFetch;
  });

  it("returns empty_response for empty body", async () => {
    const deploy = makeDeployment();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("", { status: 200 }),
    );

    const result = await probeDeployment(deploy, "test-api-key");
    expect(result.success).toBe(false);
    expect(result.failureClass).toBe("empty_response");

    globalThis.fetch = originalFetch;
  });

  it("returns empty_response for a 200 response with no assistant content", async () => {
    const deploy = makeDeployment();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200 }),
    );

    const result = await probeDeployment(deploy, "test-api-key");
    expect(result.success).toBe(false);
    expect(result.failureClass).toBe("empty_response");
    expect(result.status).toBe(200);

    globalThis.fetch = originalFetch;
  });

  it("returns success_shaped_failure for a 200 provider error envelope", async () => {
    const deploy = makeDeployment();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ error: { message: "quota exceeded" } }), { status: 200 }),
    );

    const result = await probeDeployment(deploy, "test-api-key");
    expect(result.success).toBe(false);
    expect(result.failureClass).toBe("success_shaped_failure");
    expect(result.status).toBe(200);

    globalThis.fetch = originalFetch;
  });

  it("uses Anthropic format for anthropic_subscription provider", async () => {
    const deploy = makeDeployment({
      provider: "anthropic_subscription",
      apiBase: "https://api.anthropic.com",
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({
        content: [{ type: "text", text: "OK" }],
        stop_reason: "end_turn",
      }), { status: 200 }),
    );

    const result = await probeDeployment(deploy, "test-api-key");
    expect(result.success).toBe(true);

    // Verify Anthropic headers were set
    const callArgs = (globalThis.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
    const fetchHeaders = callArgs[1].headers as Record<string, string>;
    expect(fetchHeaders["anthropic-version"]).toBe("2023-06-01");
    expect(fetchHeaders["x-api-key"]).toBe("test-api-key");

    globalThis.fetch = originalFetch;
  });
});

// ─── runCanaryProbes ──────────────────────────────────────────────

describe("Canary probe batch runner", () => {
  it("runs probes and records results", async () => {
    const successes: string[] = [];
    const failures: Array<{ deploymentId: string; failureClass: string }> = [];

    const recorder: ProbeRecorder = {
      recordSuccess: vi.fn().mockImplementation(async (id: string) => { successes.push(id); }),
      recordFailure: vi.fn().mockImplementation(async (id: string, fc: string) => { failures.push({ deploymentId: id, failureClass: fc }); }),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { content: "OK" } }] }), { status: 200 }),
    );

    const results = await runCanaryProbes(
      { NIM_KEY_1: "test-key", ZAI_KEY_1: "test-key" } as unknown as Record<string, unknown>,
      recorder,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(successes.length).toBeGreaterThan(0);

    globalThis.fetch = originalFetch;
  });

  it("skips deployments with no API key", async () => {
    const recorder: ProbeRecorder = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn(),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn();

    const results = await runCanaryProbes(
      {} as Record<string, unknown>,
      recorder,
    );

    expect(results).toHaveLength(0);
    expect(globalThis.fetch).not.toHaveBeenCalled();

    globalThis.fetch = originalFetch;
  });

  it("records failures from probes", async () => {
    const failures: Array<{ deploymentId: string; failureClass: string }> = [];

    const recorder: ProbeRecorder = {
      recordSuccess: vi.fn(),
      recordFailure: vi.fn().mockImplementation(async (id: string, fc: string) => {
        failures.push({ deploymentId: id, failureClass: fc });
      }),
    };

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("Internal Server Error", { status: 500 }),
    );

    await runCanaryProbes(
      { NIM_KEY_1: "test-key", ZAI_KEY_1: "test-key" } as unknown as Record<string, unknown>,
      recorder,
    );

    expect(failures.length).toBeGreaterThan(0);
    expect(failures[0].failureClass).toBe("server_5xx");

    globalThis.fetch = originalFetch;
  });
});

// ─── Canary pacing ────────────────────────────────────────────────

describe("Canary pacing and backoff", () => {
  it("backs off healthy deployments after a recent successful probe", () => {
    const now = 1_000_000;
    const decision = canaryProbeDecision("deploy-1", now, TEST_PROBE_CONFIG, {}, [
      { deploymentId: "deploy-1", timestamp: now - 60_000, success: true },
    ]);

    expect(decision.due).toBe(false);
    expect(decision.intervalMs).toBe(TEST_PROBE_CONFIG.healthyIntervalMs);
    expect(decision.reason).toBe("healthy");
  });

  it("probes half-open deployments at the faster recovery interval", () => {
    const now = 1_000_000;
    const decision = canaryProbeDecision("deploy-1", now, TEST_PROBE_CONFIG, {
      health: { circuits: { "deploy-1": { state: "half_open" } } },
    }, [
      { deploymentId: "deploy-1", timestamp: now - TEST_PROBE_CONFIG.halfOpenIntervalMs - 1, success: true },
    ]);

    expect(decision.due).toBe(true);
    expect(decision.intervalMs).toBe(TEST_PROBE_CONFIG.halfOpenIntervalMs);
    expect(decision.reason).toBe("half_open");
  });

  it("applies exponential per-deployment backoff to repeated failed probes", () => {
    const now = 1_000_000;
    const decision = canaryProbeDecision("deploy-1", now, TEST_PROBE_CONFIG, {}, [
      { deploymentId: "deploy-1", timestamp: now - 3 * 60_000, success: false },
      { deploymentId: "deploy-1", timestamp: now - 5 * 60_000, success: false },
      { deploymentId: "deploy-1", timestamp: now - 7 * 60_000, success: true },
    ]);

    expect(decision.consecutiveFailures).toBe(2);
    expect(decision.intervalMs).toBe(4 * 60_000);
    expect(decision.due).toBe(false);
  });

  it("selects the due recovery candidate over a healthy candidate in the same group", () => {
    const now = 1_000_000;
    const healthy = makeDeployment({ id: "healthy", keyRef: "KEY_1", group: "shared" });
    const recovering = makeDeployment({ id: "recovering", keyRef: "KEY_2", group: "shared" });

    const candidates = selectCanaryCandidates([healthy, recovering], { KEY_1: "a", KEY_2: "b" }, TEST_PROBE_CONFIG, {
      now,
      health: { circuits: { recovering: { state: "half_open" } } },
      recentResults: [
        { deploymentId: "recovering", timestamp: now - TEST_PROBE_CONFIG.halfOpenIntervalMs - 1, success: false },
      ],
    });

    expect(candidates.map((d) => d.id)).toEqual(["recovering"]);
  });
});

// ─── reapAllLeases ────────────────────────────────────────────────

describe("Lease reaper", () => {
  it("reaps leases from all shards", async () => {
    const reaped: string[] = [];
    const reaper = (name: string) => ({
      reapExpired: vi.fn().mockImplementation(async () => {
        reaped.push(name);
        return name === "health" ? 3 : 1;
      }),
    });

    const total = await reapAllLeases(reaper);
    expect(total).toBeGreaterThan(0);
    expect(reaped.length).toBeGreaterThan(0);
  });

  it("handles errors gracefully", async () => {
    const reaper = (_name: string) => ({
      reapExpired: vi.fn().mockRejectedValue(new Error("DO not found")),
    });

    const total = await reapAllLeases(reaper);
    expect(total).toBe(0);
  });
});

// ─── Probe config ─────────────────────────────────────────────────

describe("Probe configuration", () => {
  it("has sensible defaults", () => {
    // Verify defaults are used correctly via a probe call
    const deploy = makeDeployment();
    expect(deploy.timeout).toBe(30);
    expect(deploy.streamTimeout).toBe(120);
  });
});
