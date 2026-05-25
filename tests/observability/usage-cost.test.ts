import { describe, it, expect } from "vitest";
import { estimateUsageCostUsd } from "../../src/observability/usage-cost";

describe("estimateUsageCostUsd", () => {
  it("estimates known anthropic usage", () => {
    const cost = estimateUsageCostUsd("anthropic_subscription", {
      kind: "known",
      promptTokens: 1_000_000,
      completionTokens: 0,
      totalTokens: 1_000_000,
      source: "test",
    }, "claude-opus-4-7");
    expect(cost).toBe(15);
  });

  it("returns null for unknown usage", () => {
    expect(estimateUsageCostUsd("anthropic_subscription", { kind: "unknown", source: "x" })).toBeNull();
  });
});
