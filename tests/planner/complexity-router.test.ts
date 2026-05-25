import { describe, it, expect } from "vitest";
import { classifyPromptComplexity, smartRouteModelForTier } from "../../src/planner/complexity-router";
import { resolveSmartRouteModel, canonicalize } from "../../src/planner/planner";

describe("complexity-router", () => {
  it("classifies short simple prompts as low", () => {
    expect(classifyPromptComplexity([{ role: "user", content: "What is JSON?" }])).toBe("low");
  });

  it("classifies short prompts without question words as medium", () => {
    expect(classifyPromptComplexity([{ role: "user", content: "Rewrite this function to use async await" }])).toBe("medium");
  });

  it("classifies long prompts as high", () => {
    const long = "x".repeat(8100);
    expect(classifyPromptComplexity([{ role: "user", content: long }])).toBe("high");
  });

  it("classifies complex keyword prompts as high", () => {
    expect(classifyPromptComplexity([{ role: "user", content: "architect a microservice" }])).toBe("high");
  });

  it("maps tiers to managed anthropic aliases", () => {
    expect(canonicalize(smartRouteModelForTier("low")).canonicalTarget).toBe("anthropic-subscription-sonnet-4-6-low");
    expect(canonicalize(smartRouteModelForTier("high")).canonicalTarget).toBe("anthropic-subscription-opus-4-7-high");
  });

  it("resolves smart-route to a tier model", () => {
    const model = resolveSmartRouteModel({
      requestId: "r1",
      originalModel: "smart-route",
      body: { model: "smart-route", messages: [{ role: "user", content: "hi" }] },
      stream: false,
      hasTools: false,
      hasStrictTools: false,
      isMultiTool: false,
      hasTypedContent: false,
      requiresJsonMode: false,
      requiresReasoning: false,
    });
    expect(model).not.toBe("smart-route");
    expect(canonicalize(model).isManaged).toBe(true);
  });
});
