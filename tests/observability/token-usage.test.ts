import { describe, expect, it } from "vitest";
import {
  normalizeProviderUsage,
  usageEventFromTokenUsage,
} from "../../src/observability/token-usage";

describe("token usage normalization", () => {
  it("normalizes OpenAI-style prompt and completion counters", () => {
    const usage = normalizeProviderUsage({
      prompt_tokens: 10,
      completion_tokens: 7,
    }, "openai");

    expect(usage).toEqual({
      kind: "known",
      promptTokens: 10,
      completionTokens: 7,
      totalTokens: 17,
      source: "openai",
    });
  });

  it("uses total_tokens conservatively when total exceeds component sum", () => {
    const usage = normalizeProviderUsage({
      input_tokens: 10,
      output_tokens: 5,
      total_tokens: 20,
    }, "responses");

    expect(usage).toEqual({
      kind: "known",
      promptTokens: 10,
      completionTokens: 10,
      totalTokens: 20,
      source: "responses",
    });
  });

  it("keeps component sum when provider total underreports it", () => {
    const usage = normalizeProviderUsage({
      prompt_tokens: 10,
      completion_tokens: 5,
      total_tokens: 12,
    }, "provider");

    expect(usage).toMatchObject({
      kind: "known",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
    });
  });

  it("accounts total-only usage as estimated instead of dropping it", () => {
    const usage = normalizeProviderUsage({ total_tokens: "12" }, "provider");

    expect(usage).toEqual({
      kind: "estimated",
      promptTokens: 0,
      completionTokens: 12,
      totalTokens: 12,
      source: "provider:total_tokens",
    });
    expect(usageEventFromTokenUsage(usage).totalTokens).toBe(12);
  });

  it("preserves unknown usage as null counters in usage events", () => {
    const usage = normalizeProviderUsage(undefined, "provider");

    expect(usageEventFromTokenUsage(usage)).toEqual({
      usageKind: "unknown",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      usageSource: "provider",
      estimatedCostUsd: null,
    });
  });

  it("rejects malformed or negative counters", () => {
    expect(normalizeProviderUsage({
      prompt_tokens: -1,
      completion_tokens: 5,
    }, "provider")).toEqual({ kind: "unknown", source: "provider" });
    expect(normalizeProviderUsage({
      prompt_tokens: Number.POSITIVE_INFINITY,
      completion_tokens: 5,
    }, "provider")).toEqual({ kind: "unknown", source: "provider" });
  });
});
