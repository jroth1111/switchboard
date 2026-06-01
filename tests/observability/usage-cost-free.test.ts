import { describe, it, expect } from "vitest";
import { estimateUsageCostUsd } from "../../src/observability/usage-cost";

describe("estimateUsageCostUsd free billing", () => {
  it("returns zero cost for billingClass free", () => {
    const cost = estimateUsageCostUsd(
      "openai",
      { kind: "known", promptTokens: 1_000_000, completionTokens: 0, totalTokens: 1_000_000, source: "test" },
      "some-model",
      "free",
    );
    expect(cost).toBe(0);
  });
});
