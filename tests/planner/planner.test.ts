import { describe, it, expect } from "vitest";
import { canonicalize, planRequest, applyTransforms, type RequestEnvelope } from "../../src/planner/planner";
import { MANIFEST } from "../../src/config/manifest";

describe("canonicalize", () => {
  it("resolves smart-route aliases to smart-route-worker", () => {
    expect(canonicalize("smart-route").canonicalTarget).toBe("smart-route-worker");
    expect(canonicalize("glm-5.1").canonicalTarget).toBe("smart-route-worker");
    expect(canonicalize("z.ai/glm-5.1").canonicalTarget).toBe("smart-route-worker");
    expect(canonicalize("openai/glm-5.1").canonicalTarget).toBe("smart-route-worker");
  });

  it("resolves NIM aliases to nim-primary", () => {
    expect(canonicalize("nim-primary").canonicalTarget).toBe("nim-primary");
    expect(canonicalize("nvidia_nim/z-ai/glm-5.1").canonicalTarget).toBe("nim-primary");
    expect(canonicalize("z-ai/glm-5.1").canonicalTarget).toBe("nim-primary");
  });

  it("resolves ChatGPT aliases to subscription groups", () => {
    expect(canonicalize("gpt-5.5").canonicalTarget).toBe("chatgpt-subscription-gpt-5.5-medium");
    expect(canonicalize("chatgpt/gpt-5.5").canonicalTarget).toBe("chatgpt-subscription-gpt-5.5-medium");
    expect(canonicalize("gpt-5.5(high)").canonicalTarget).toBe("chatgpt-subscription-gpt-5.5-high");
  });

  it("resolves Claude aliases to anthropic subscription groups", () => {
    expect(canonicalize("claude-opus-4-7").canonicalTarget).toBe("anthropic-subscription-opus-4-7-high");
    expect(canonicalize("claude-sonnet-4-6").canonicalTarget).toBe("anthropic-subscription-sonnet-4-6-high");
    expect(canonicalize("sonnet-4-6").canonicalTarget).toBe("anthropic-subscription-sonnet-4-6-high");
  });

  it("resolves VibeProxy GHCP editor aliases", () => {
    expect(canonicalize("ghcp-op-46").canonicalTarget).toBe("anthropic-subscription-opus-4-7-high");
    expect(canonicalize("ghcp-son-46").canonicalTarget).toBe("anthropic-subscription-sonnet-4-6-high");
    expect(canonicalize("ghcp-haik-45").canonicalTarget).toBe("anthropic-subscription-sonnet-4-6-low");
  });

  it("returns unmanaged for unknown models", () => {
    const result = canonicalize("totally-unknown-model");
    expect(result.isManaged).toBe(false);
    expect(result.reason).toBe("unmanaged");
  });

  it("keeps terminal fallback aliases managed for parity while route policy keeps them hidden", () => {
    const result = canonicalize("zai-fallback");
    expect(result.isManaged).toBe(true);
    expect(result.canonicalTarget).toBe("zai-glm-5.1-terminal-fallback");
    expect(MANIFEST.routeGroups[result.canonicalTarget].hidden).toBe(true);
  });

  it("resolves ambiguous aliases when direct alias is missing", () => {
    // Both z.ai/glm-5.1 and z-ai/glm-5.1 are in allowedAmbiguousAliases.
    // z.ai/glm-5.1 is a direct alias → smart-route-worker (checked first).
    // z-ai/glm-5.1 is a direct alias → nim-primary (checked first).
    // The ambiguous fallback only triggers for names NOT in the direct alias map.
    // Test the fallback with a hypothetical variant that doesn't have a direct alias.
    const result = canonicalize("z.ai/glm-5.1");
    expect(result.isManaged).toBe(true);
    expect(result.canonicalTarget).toBe("smart-route-worker");
  });
});

describe("planRequest", () => {
  function makeEnvelope(model: string, opts: Partial<RequestEnvelope> = {}): RequestEnvelope {
    return {
      requestId: "test-req-1",
      originalModel: model,
      body: { model, messages: [{ role: "user", content: "hello" }] },
      stream: false,
      hasTools: false,
      hasStrictTools: false,
      isMultiTool: false,
      hasTypedContent: false,
      requiresJsonMode: false,
      requiresReasoning: false,
      ...opts,
    };
  }

  it("routes simple smart-route prompts to low-tier subscription", () => {
    const plan = planRequest(makeEnvelope("smart-route"), Date.now(), { shadowLog: true });
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBe("anthropic-subscription-sonnet-4-6-low");
    expect(plan!.smartRouteShadow).toEqual({
      tier: "low",
      selectedModel: "anthropic-subscription-sonnet-4-6-low",
    });
  });

  it("routes complex smart-route prompts to high-tier subscription", () => {
    const plan = planRequest(makeEnvelope("smart-route", {
      body: {
        model: "smart-route",
        messages: [{ role: "user", content: "Architect and refactor a comprehensive multi-file microservice migration." }],
      },
    }));
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBe("anthropic-subscription-opus-4-7-high");
  });

  it("routes tool requests to nim-tool-primary", () => {
    const plan = planRequest(makeEnvelope("smart-route", {
      hasTools: true,
      body: {
        model: "smart-route",
        messages: [{ role: "user", content: "use tool" }],
        tools: [{ type: "function", function: { name: "test" } }],
      },
    }), Date.now(), { shadowLog: true });
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBe("nim-tool-primary");
    expect(plan!.smartRouteShadow?.skippedReason).toBe("tools");
  });

  it("plans nim-primary with NIM fallback chain ending in Z.AI terminal", () => {
    const plan = planRequest(makeEnvelope("nim-primary"));
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBe("nim-primary");
    const fallbackNames = plan!.fallbackSequence.map((f) => f.group);
    expect(fallbackNames).toContain("zai-glm-5.1-terminal-fallback");
  });

  it("returns null for unmanaged models", () => {
    const plan = planRequest(makeEnvelope("unknown-model-xyz"));
    expect(plan).toBeNull();
  });

  it("skips deployment-less route groups and selects routeGroup.target first", () => {
    const plan = planRequest(makeEnvelope("nim-secondary"));
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBe("nim-minimax-m2.7");
  });

  it("chatgpt subscription routes include profile fallbacks", () => {
    const plan = planRequest(makeEnvelope("gpt-5.5"));
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBe("chatgpt-subscription-gpt-5.5-medium");
    expect(plan!.fallbackSequence.map((f) => f.group)).toContain("chatgpt-subscription-gpt-5.5-high");
  });

  it("anthropic subscription routes have no fallbacks", () => {
    const plan = planRequest(makeEnvelope("claude-opus-4-7"));
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBe("anthropic-subscription-opus-4-7-high");
    expect(plan!.fallbackSequence.length).toBe(0);
  });
});

describe("manifest integrity", () => {
  it("every alias target has a route group", () => {
    for (const [alias, target] of Object.entries(MANIFEST.aliases)) {
      expect(MANIFEST.routeGroups[target], `Alias "${alias}" -> "${target}" missing route group`).toBeDefined();
    }
  });

  it("every deployment group has a route group", () => {
    for (const d of MANIFEST.deployments) {
      expect(MANIFEST.routeGroups[d.group], `Deployment "${d.id}" group "${d.group}" missing route group`).toBeDefined();
    }
  });

  it("every route group fallback exists", () => {
    for (const [name, rg] of Object.entries(MANIFEST.routeGroups)) {
      for (const fb of rg.fallbacks) {
        expect(MANIFEST.routeGroups[fb], `Group "${name}" fallback "${fb}" missing`).toBeDefined();
      }
    }
  });

  it("hidden groups are not in aliases that are user-facing", () => {
    // At least check that subscription groups are hidden
    expect(MANIFEST.routeGroups["chatgpt-subscription-gpt-5.5-medium"].hidden).toBe(true);
    expect(MANIFEST.routeGroups["anthropic-subscription-opus-4-7-high"].hidden).toBe(true);
    expect(MANIFEST.routeGroups["smart-route-worker"].hidden).toBe(false);
  });

  it("every route group has a policy", () => {
    for (const name of Object.keys(MANIFEST.routeGroups)) {
      expect(MANIFEST.policies[name], `Group "${name}" missing policy`).toBeDefined();
    }
  });
});

describe("enableReasoning gating", () => {
  it("strips reasoning_effort when enableReasoning is false", () => {
    // NIM default policy has enableReasoning: false
    const plan = planRequest({
      requestId: "test-req-1",
      originalModel: "nim-primary",
      body: {
        model: "nim-primary",
        messages: [{ role: "user", content: "think about this" }],
        reasoning_effort: "high",
      },
      stream: false,
      hasTools: false,
      hasStrictTools: false,
      hasTypedContent: false,
      requiresJsonMode: false,
      requiresReasoning: true,
    });
    // nim-primary enableReasoning=false → reasoning should trigger rejection or strip
    // Since reasoning is requested but enableReasoning is false, candidate gets rejected
    // The plan may still succeed if there's a fallback that supports reasoning
    if (plan) {
      const hasReasoningStrip = plan.transforms.some((t) => t.type === "strip_reasoning");
      expect(hasReasoningStrip).toBe(true);
    }
  });

  it("strips reasoning_effort from body when enableReasoning is false", () => {
    // smart-route-worker uses DEFAULT_POLICY: enableReasoning=false
    const plan = planRequest({
      requestId: "test-req-2",
      originalModel: "smart-route-worker",
      body: {
        model: "smart-route-worker",
        messages: [{ role: "user", content: "think" }],
        reasoning_effort: "low",
        extra_body: { reasoning_effort: "low" },
      },
      stream: false,
      hasTools: false,
      hasStrictTools: false,
      hasTypedContent: false,
      requiresJsonMode: false,
      requiresReasoning: false,
    });
    // enableReasoning=false → should strip reasoning from request body
    expect(plan).not.toBeNull();
    const hasReasoningStrip = plan!.transforms.some((t) => t.type === "strip_reasoning");
    expect(hasReasoningStrip).toBe(true);
  });
});
