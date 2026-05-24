import { describe, it, expect } from "vitest";
import {
  normalizeProviderUsage,
  usageEventFromTokenUsage,
} from "../../src/observability/token-usage";

describe("normalizeProviderUsage", () => {
  it("returns unknown when usage is missing", () => {
    expect(normalizeProviderUsage(undefined, "openai")).toEqual({
      kind: "unknown",
      source: "openai",
    });
  });

  it("normalizes OpenAI-style usage fields", () => {
    expect(normalizeProviderUsage(
      { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      "openai",
    )).toEqual({
      kind: "known",
      promptTokens: 10,
      completionTokens: 5,
      totalTokens: 15,
      source: "openai",
    });
  });

  it("normalizes Anthropic-style usage fields", () => {
    expect(normalizeProviderUsage(
      { input_tokens: 8, output_tokens: 2 },
      "anthropic",
    )).toEqual({
      kind: "known",
      promptTokens: 8,
      completionTokens: 2,
      totalTokens: 10,
      source: "anthropic",
    });
  });

  it("accepts zero token counts", () => {
    expect(normalizeProviderUsage(
      { prompt_tokens: 0, completion_tokens: 0 },
      "openai",
    )).toEqual({
      kind: "known",
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      source: "openai",
    });
  });

  it("returns unknown for partial or invalid usage", () => {
    expect(normalizeProviderUsage({ prompt_tokens: 1 }, "openai").kind).toBe("unknown");
    expect(normalizeProviderUsage({ prompt_tokens: null, completion_tokens: 2 }, "openai").kind).toBe("unknown");
    expect(normalizeProviderUsage({ prompt_tokens: -1, completion_tokens: 2 }, "openai").kind).toBe("unknown");
    expect(normalizeProviderUsage({ prompt_tokens: Number.NaN, completion_tokens: 1 }, "openai").kind).toBe("unknown");
    expect(normalizeProviderUsage({ total_tokens: 100 }, "openai").kind).toBe("unknown");
  });

  it("coerces numeric strings without string-concat totals", () => {
    expect(normalizeProviderUsage(
      { prompt_tokens: "5" as unknown as number, completion_tokens: 3 },
      "openai",
    )).toEqual({
      kind: "known",
      promptTokens: 5,
      completionTokens: 3,
      totalTokens: 8,
      source: "openai",
    });
  });
});

describe("usageEventFromTokenUsage", () => {
  it("maps known usage to event fields", () => {
    expect(usageEventFromTokenUsage({
      kind: "known",
      promptTokens: 3,
      completionTokens: 4,
      totalTokens: 7,
      source: "openai",
    })).toEqual({
      usageKind: "known",
      promptTokens: 3,
      completionTokens: 4,
      totalTokens: 7,
      usageSource: "openai",
    });
  });

  it("maps unknown usage to null token fields", () => {
    expect(usageEventFromTokenUsage({ kind: "unknown", source: "streaming" })).toEqual({
      usageKind: "unknown",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      usageSource: "streaming",
    });
  });
});
