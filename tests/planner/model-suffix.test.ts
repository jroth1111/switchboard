import { describe, it, expect } from "vitest";
import { applyModelSuffixToBody } from "../../src/planner/model-suffix";
import { canonicalize } from "../../src/planner/planner";

describe("applyModelSuffixToBody", () => {
  it("strips -thinking-NUMBER and injects thinking budget", () => {
    const body: Record<string, unknown> = {
      model: "claude-sonnet-4-6-thinking-8000",
      messages: [{ role: "user", content: "hi" }],
    };
    const r = applyModelSuffixToBody(body);
    expect(r.originalModel).toBe("claude-sonnet-4-6-thinking-8000");
    expect(r.model).toBe("claude-sonnet-4-6");
    expect(body.model).toBe("claude-sonnet-4-6");
    expect(body.thinking).toEqual({ type: "enabled", budget_tokens: 8000 });
    expect(r.requiresReasoning).toBe(true);
  });

  it("leaves model unchanged when suffix is invalid", () => {
    const body = { model: "claude-sonnet-4-6-thinking-abc", messages: [] };
    const r = applyModelSuffixToBody(body);
    expect(r.model).toBe("claude-sonnet-4-6-thinking-abc");
    expect(r.requiresReasoning).toBe(false);
  });

  it("canonicalize works on stripped model after suffix rewrite", () => {
    const body = { model: "claude-opus-4-7-thinking-5000", messages: [] };
    applyModelSuffixToBody(body);
    expect(canonicalize(body.model as string).canonicalTarget).toBe("anthropic-subscription-opus-4-7-high");
  });
});
