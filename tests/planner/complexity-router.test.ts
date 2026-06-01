import { describe, it, expect } from "vitest";
import { classifyPromptComplexity, smartRouteModelForTier } from "../../src/planner/complexity-router";
import { resolveSmartRouteModel, resolveSmartRouteWithShadow, canonicalize } from "../../src/planner/planner";
import type { RequestEnvelope } from "../../src/planner/planner";

function makeEnvelope(overrides: Partial<RequestEnvelope> = {}): RequestEnvelope {
  return {
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
    ...overrides,
  };
}

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
    const model = resolveSmartRouteModel(makeEnvelope());
    expect(model).not.toBe("smart-route");
    expect(canonicalize(model).isManaged).toBe(true);
  });

  it("resolveSmartRouteWithShadow selects low tier for simple prompts", () => {
    const shadow = resolveSmartRouteWithShadow(makeEnvelope({
      body: { model: "smart-route", messages: [{ role: "user", content: "What is JSON?" }] },
    }));
    expect(shadow.tier).toBe("low");
    expect(shadow.selectedModel).toBe(smartRouteModelForTier("low"));
    expect(shadow.skippedReason).toBeUndefined();
  });

  it("resolveSmartRouteWithShadow skips for tools", () => {
    const shadow = resolveSmartRouteWithShadow(makeEnvelope({
      hasTools: true,
      body: {
        model: "smart-route",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ type: "function", function: { name: "test" } }],
      },
    }));
    expect(shadow.skippedReason).toBe("tools");
    expect(shadow.selectedModel).toBe("smart-route");
  });

  it("resolveSmartRouteWithShadow skips for json mode", () => {
    const shadow = resolveSmartRouteWithShadow(makeEnvelope({
      requiresJsonMode: true,
      body: {
        model: "smart-route",
        messages: [{ role: "user", content: "hi" }],
        response_format: { type: "json_object" },
      },
    }));
    expect(shadow.skippedReason).toBe("json");
    expect(shadow.selectedModel).toBe("smart-route");
  });

  it("resolveSmartRouteWithShadow skips for multimodal content", () => {
    const shadow = resolveSmartRouteWithShadow(makeEnvelope({
      hasTypedContent: true,
    }));
    expect(shadow.skippedReason).toBe("multimodal");
    expect(shadow.selectedModel).toBe("smart-route");
  });

  it("resolveSmartRouteWithShadow skips for non-smart-route models", () => {
    const shadow = resolveSmartRouteWithShadow(makeEnvelope({
      originalModel: "nim-primary",
      body: { model: "nim-primary", messages: [{ role: "user", content: "hi" }] },
    }));
    expect(shadow.skippedReason).toBe("not_smart_route");
    expect(shadow.selectedModel).toBe("nim-primary");
  });
});
