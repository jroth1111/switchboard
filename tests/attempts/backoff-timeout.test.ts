import { describe, it, expect } from "vitest";
import { MANIFEST } from "../../src/config/manifest";
import {
  resolveAdaptiveAttemptTimeoutMs,
  resolveAdaptiveFirstTokenTimeoutMs,
  resolveAdaptiveStreamHardTimeoutMs,
} from "../../src/attempts/attempt-loop";

describe("Exponential backoff computation", () => {
  // Import the computeBackoff function indirectly via the attempt loop module
  // We test the backoff behavior through the exported backoff parameters in policy

  it("default policy has backoff configuration", async () => {
    const { MANIFEST } = await import("../../src/config/manifest");
    const policy = MANIFEST.defaultPolicy;
    expect(policy.retry.backoffBaseMs).toBeGreaterThan(0);
    expect(policy.retry.backoffMaxMs).toBeGreaterThanOrEqual(policy.retry.backoffBaseMs);
  });

  it("backoff parameters are reasonable", async () => {
    const { MANIFEST } = await import("../../src/config/manifest");
    const policy = MANIFEST.defaultPolicy;
    // Base: 250ms, Max: 2000ms
    expect(policy.retry.backoffBaseMs).toBe(250);
    expect(policy.retry.backoffMaxMs).toBe(2000);
  });

  it("policy has attempt and total timeout configured", async () => {
    const { MANIFEST } = await import("../../src/config/manifest");
    const policy = MANIFEST.defaultPolicy;
    expect(policy.deadline.attemptTimeoutSeconds).toBeGreaterThan(0);
    expect(policy.deadline.totalTimeoutSeconds).toBeGreaterThan(policy.deadline.attemptTimeoutSeconds);
    expect(policy.deadline.firstTokenTimeoutSeconds).toBeGreaterThan(0);
    expect(policy.deadline.streamIdleTimeoutSeconds).toBeGreaterThan(0);
    expect(policy.deadline.streamHardTimeoutSeconds).toBeGreaterThan(0);
  });

  it("first token timeout is shorter than attempt timeout", async () => {
    const { MANIFEST } = await import("../../src/config/manifest");
    const policy = MANIFEST.defaultPolicy;
    expect(policy.deadline.firstTokenTimeoutSeconds).toBeLessThanOrEqual(policy.deadline.attemptTimeoutSeconds);
  });
});

describe("Streaming timeout configuration", () => {
  it("pre-buffer config includes first-token and hard timeouts", async () => {
    // Verify the PreBufferConfig interface supports the new fields
    const config: import("../../src/streaming/pre-buffer").PreBufferConfig = {
      preBufferChunks: 4,
      enableThinkingLeakStripping: true,
      enableSpecialTokenRepair: true,
      heartbeatIntervalMs: 15000,
      maxSilenceMs: 30000,
      firstTokenTimeoutMs: 15000,
      hardTimeoutMs: 120000,
      signal: undefined,
    };
    expect(config.firstTokenTimeoutMs).toBe(15000);
    expect(config.hardTimeoutMs).toBe(120000);
  });
});

describe("Adaptive deadline resolution", () => {
  const policy = MANIFEST.defaultPolicy;
  const deployment = MANIFEST.deployments[0];

  it("derives attempt timeout from rolling p95 total latency when warmed up", () => {
    const timeoutMs = resolveAdaptiveAttemptTimeoutMs(policy, deployment, {
      rollingMetrics: {
        recentOutcomeCount: policy.health.latencyWarmupSamples,
        recentFailureRate: 0,
        timeoutRate: 0,
        invalidSuccessRate: 0,
        p95FirstByteLatencyMs: 400,
        p95TotalLatencyMs: 10_000,
      },
      latencySampleCount: policy.health.latencyWarmupSamples,
    }, false);

    expect(timeoutMs).toBe(30_000);
  });

  it("falls back to latency EMA when rolling p95 is unavailable", () => {
    const timeoutMs = resolveAdaptiveAttemptTimeoutMs(policy, deployment, {
      latencyEmaMs: 8_000,
      latencySampleCount: policy.health.latencyWarmupSamples,
    }, false);

    expect(timeoutMs).toBe(24_000);
  });

  it("adapts stream first-token and hard timeouts independently", () => {
    const snapshot = {
      rollingMetrics: {
        recentOutcomeCount: policy.health.latencyWarmupSamples,
        recentFailureRate: 0,
        timeoutRate: 0,
        invalidSuccessRate: 0,
        p95FirstByteLatencyMs: 2_000,
        p95TotalLatencyMs: 20_000,
      },
    };

    expect(resolveAdaptiveFirstTokenTimeoutMs(policy, snapshot)).toBe(4_000);
    expect(resolveAdaptiveStreamHardTimeoutMs(policy, snapshot)).toBe(60_000);
  });
});

describe("Deadline-aware attempt timeout", () => {
  it("total timeout exceeds single attempt timeout", async () => {
    const { MANIFEST } = await import("../../src/config/manifest");
    const policy = MANIFEST.defaultPolicy;
    // totalTimeoutSeconds should be >= attemptTimeoutSeconds to allow at least one attempt
    expect(policy.deadline.totalTimeoutSeconds).toBeGreaterThanOrEqual(
      policy.deadline.attemptTimeoutSeconds,
    );
  });
});
