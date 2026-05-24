import { describe, it, expect } from "vitest";
import { validateManifest, type ValidationIssue } from "../../src/config/validate-manifest";
import { MANIFEST, POLICY_PROFILES, composePolicy } from "../../src/config/manifest";
import type { RouteManifest, RouteGroup, Deployment, Policy } from "../../src/config/schema";

const DEFAULT_POLICY: Policy = {
  request: {
    unsupportedParams: [],
    supportedSurfaces: ["chat_completions"],
    supportedOperations: ["chat"],
    allowedContentClasses: ["text"],
    rejectStreamingTools: false,
    stripReasoningFromSuccess: false,
    minRequestTokens: null,
    maxRequestTokens: null,
    enableReasoning: false,
  },
  response: {
    enableSemanticValidation: false,
    enableToolRepair: false,
    enableSpecialTokenDetection: false,
    enableRepetitionDetection: false,
    repetitionMaxRatio: 0.5,
    semanticMinChars: 1,
    semanticMinEntropy: 2.5,
    semanticMinPrintableRatio: 0.8,
  },
  deadline: {
    attemptTimeoutSeconds: 120,
    firstTokenTimeoutSeconds: 15,
    streamIdleTimeoutSeconds: 30,
    totalTimeoutSeconds: 300,
  },
  retry: {
    transportRetries: 1,
    semanticRetries: 0,
    retryableFailureClasses: [],
    backoffBaseMs: 250,
    backoffMaxMs: 2000,
  },
  health: {
    circuitFailureThreshold: 5,
    circuitDurationSeconds: 300,
    transportCooldownThreshold: 2,
    transportCooldownSeconds: 90,
    semanticCooldownThreshold: 1,
    rateLimitCooldownThreshold: 1,
    halfOpenPenalty: 2.5,
    probeMaxInflight: 1,
  },
  budget: {
    scopeMode: "global",
    rpmLimit: null,
    maxParallelRequests: null,
    learnedConcurrencyEnabled: true,
    learnedConcurrencyTtlSeconds: 60,
    staleInflightSeconds: 120,
  },
};

function makeManifest(overrides: Partial<RouteManifest> = {}): RouteManifest {
  return {
    plannerSettings: {
      healthFallbackMargin: 75,
      halfOpenPenalty: 2.5,
      recentDispatchBonus: 20,
      recentDispatchTtlSeconds: 45,
    },
    aliases: { "model-a": "group-a" },
    allowedAmbiguousAliases: [],
    managedModelPrefixes: [],
    routeGroups: {
      "group-a": { target: "model-a", hidden: false, fallbacks: [] },
    },
    deployments: [{
      id: "deploy-1", group: "group-a", provider: "openai",
      model: "model-a", providerModel: "model-a",
      keyRef: "KEY_1", rpm: 30, maxParallelRequests: 2,
      timeout: 500, streamTimeout: 500, supportsStreaming: true,
      capabilities: {
        toolCalling: "native", streamingWithTools: "native",
        jsonMode: "native", reasoning: "native", multimodal: "none",
      },
      contextWindow: 128000, hidden: false,
    }],
    deploymentsByGroup: { "group-a": [] },
    policies: { "group-a": DEFAULT_POLICY },
    defaultPolicy: DEFAULT_POLICY,
    ...overrides,
  } as RouteManifest;
}

function errors(issues: ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.kind === "error");
}

// ─── Actual MANIFEST validation ──────────────────────────────────

describe("MANIFEST validation", () => {
  it("has no errors on the production manifest", () => {
    const issues = validateManifest(MANIFEST);
    const errs = errors(issues);
    expect(errs).toEqual([]);
  });

  it("all aliases resolve to existing groups", () => {
    const groupNames = new Set(Object.keys(MANIFEST.routeGroups));
    for (const [alias, target] of Object.entries(MANIFEST.aliases)) {
      expect(groupNames.has(target)).toBe(true);
    }
  });

  it("fallback graph is acyclic", () => {
    const issues = validateManifest(MANIFEST);
    const cycles = issues.filter((i) => i.code === "fallback_cycle");
    expect(cycles).toHaveLength(0);
  });

  it("all deployments reference valid groups", () => {
    const groupNames = new Set(Object.keys(MANIFEST.routeGroups));
    for (const d of MANIFEST.deployments) {
      expect(groupNames.has(d.group)).toBe(true);
    }
  });

  it("has no duplicate deployment IDs", () => {
    const ids = MANIFEST.deployments.map((d) => d.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ─── Alias validation ────────────────────────────────────────────

describe("alias validation", () => {
  it("detects alias pointing to nonexistent group", () => {
    const m = makeManifest({ aliases: { "model-a": "nonexistent-group" } });
    const issues = validateManifest(m);
    expect(errors(issues).some((i) => i.code === "alias_target_missing")).toBe(true);
  });

  it("detects alias chain through another alias", () => {
    const m = makeManifest({
      aliases: { "alias-1": "alias-2", "alias-2": "group-a" },
    });
    const issues = validateManifest(m);
    expect(issues.some((i) => i.code === "alias_chain")).toBe(true);
  });

  it("allows self-referencing alias (group name = alias target)", () => {
    const m = makeManifest({ aliases: { "group-a": "group-a" } });
    const issues = validateManifest(m);
    expect(errors(issues)).toEqual([]);
  });

  it("detects ambiguous alias referencing nonexistent alias", () => {
    const m = makeManifest({
      allowedAmbiguousAliases: [["model-a", "nonexistent"]],
    });
    const issues = validateManifest(m);
    expect(issues.some((i) => i.code === "ambiguous_alias_missing")).toBe(true);
  });
});

// ─── Fallback graph validation ───────────────────────────────────

describe("fallback graph validation", () => {
  it("detects direct cycle", () => {
    const m = makeManifest({
      routeGroups: {
        "group-a": { target: "a", hidden: false, fallbacks: ["group-b"] },
        "group-b": { target: "b", hidden: false, fallbacks: ["group-a"] },
      },
      deployments: [
        { id: "d1", group: "group-a", provider: "openai", model: "a", providerModel: "a", keyRef: "K", rpm: 30, maxParallelRequests: 2, timeout: 500, streamTimeout: 500, supportsStreaming: true, capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "none" }, contextWindow: 128000, hidden: false },
        { id: "d2", group: "group-b", provider: "openai", model: "b", providerModel: "b", keyRef: "K", rpm: 30, maxParallelRequests: 2, timeout: 500, streamTimeout: 500, supportsStreaming: true, capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "none" }, contextWindow: 128000, hidden: false },
      ],
      policies: { "group-a": DEFAULT_POLICY, "group-b": DEFAULT_POLICY },
    });
    const issues = validateManifest(m);
    expect(errors(issues).some((i) => i.code === "fallback_cycle")).toBe(true);
  });

  it("detects indirect cycle (3-node)", () => {
    const m = makeManifest({
      routeGroups: {
        "group-a": { target: "a", hidden: false, fallbacks: ["group-b"] },
        "group-b": { target: "b", hidden: false, fallbacks: ["group-c"] },
        "group-c": { target: "c", hidden: false, fallbacks: ["group-a"] },
      },
      deployments: [
        { id: "d1", group: "group-a", provider: "openai", model: "a", providerModel: "a", keyRef: "K", rpm: 30, maxParallelRequests: 2, timeout: 500, streamTimeout: 500, supportsStreaming: true, capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "none" }, contextWindow: 128000, hidden: false },
        { id: "d2", group: "group-b", provider: "openai", model: "b", providerModel: "b", keyRef: "K", rpm: 30, maxParallelRequests: 2, timeout: 500, streamTimeout: 500, supportsStreaming: true, capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "none" }, contextWindow: 128000, hidden: false },
        { id: "d3", group: "group-c", provider: "openai", model: "c", providerModel: "c", keyRef: "K", rpm: 30, maxParallelRequests: 2, timeout: 500, streamTimeout: 500, supportsStreaming: true, capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "none" }, contextWindow: 128000, hidden: false },
      ],
      policies: { "group-a": DEFAULT_POLICY, "group-b": DEFAULT_POLICY, "group-c": DEFAULT_POLICY },
    });
    const issues = validateManifest(m);
    expect(errors(issues).some((i) => i.code === "fallback_cycle")).toBe(true);
  });

  it("allows DAG fallback structure", () => {
    const m = makeManifest({
      routeGroups: {
        "group-a": { target: "a", hidden: false, fallbacks: ["group-b", "group-c"] },
        "group-b": { target: "b", hidden: false, fallbacks: ["group-c"] },
        "group-c": { target: "c", hidden: false, fallbacks: [] },
      },
      deployments: [
        { id: "d1", group: "group-a", provider: "openai", model: "a", providerModel: "a", keyRef: "K", rpm: 30, maxParallelRequests: 2, timeout: 500, streamTimeout: 500, supportsStreaming: true, capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "none" }, contextWindow: 128000, hidden: false },
        { id: "d2", group: "group-b", provider: "openai", model: "b", providerModel: "b", keyRef: "K", rpm: 30, maxParallelRequests: 2, timeout: 500, streamTimeout: 500, supportsStreaming: true, capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "none" }, contextWindow: 128000, hidden: false },
        { id: "d3", group: "group-c", provider: "openai", model: "c", providerModel: "c", keyRef: "K", rpm: 30, maxParallelRequests: 2, timeout: 500, streamTimeout: 500, supportsStreaming: true, capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "none" }, contextWindow: 128000, hidden: false },
      ],
      policies: { "group-a": DEFAULT_POLICY, "group-b": DEFAULT_POLICY, "group-c": DEFAULT_POLICY },
    });
    const issues = validateManifest(m);
    expect(errors(issues)).toEqual([]);
  });

  it("detects fallback referencing nonexistent group", () => {
    const m = makeManifest({
      routeGroups: {
        "group-a": { target: "a", hidden: false, fallbacks: ["nonexistent"] },
      },
    });
    const issues = validateManifest(m);
    expect(errors(issues).some((i) => i.code === "fallback_group_missing")).toBe(true);
  });
});

// ─── Deployment validation ───────────────────────────────────────

describe("deployment validation", () => {
  it("detects duplicate deployment IDs", () => {
    const d = { id: "dup-1", group: "group-a", provider: "openai" as const, model: "a", providerModel: "a", keyRef: "K", rpm: 30, maxParallelRequests: 2, timeout: 500, streamTimeout: 500, supportsStreaming: true, capabilities: { toolCalling: "native" as const, streamingWithTools: "native" as const, jsonMode: "native" as const, reasoning: "native" as const, multimodal: "none" as const }, contextWindow: 128000, hidden: false };
    const m = makeManifest({ deployments: [d, { ...d }] });
    const issues = validateManifest(m);
    expect(errors(issues).some((i) => i.code === "duplicate_deployment_id")).toBe(true);
  });

  it("detects deployment referencing nonexistent group", () => {
    const m = makeManifest({
      deployments: [{
        id: "d1", group: "nonexistent", provider: "openai", model: "a", providerModel: "a",
        keyRef: "K", rpm: 30, maxParallelRequests: 2, timeout: 500, streamTimeout: 500,
        supportsStreaming: true,
        capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "none" },
        contextWindow: 128000, hidden: false,
      }],
    });
    const issues = validateManifest(m);
    expect(errors(issues).some((i) => i.code === "deployment_group_missing")).toBe(true);
  });

  it("warns about non-hidden group with no deployments", () => {
    const m = makeManifest({
      routeGroups: {
        "group-a": { target: "a", hidden: false, fallbacks: [] },
        "empty-group": { target: "b", hidden: false, fallbacks: [] },
      },
      policies: { "group-a": DEFAULT_POLICY, "empty-group": DEFAULT_POLICY },
    });
    const issues = validateManifest(m);
    expect(issues.some((i) => i.code === "group_has_no_deployments" && i.kind === "warning")).toBe(true);
  });
});

// ─── Policy validation ───────────────────────────────────────────

describe("policy validation", () => {
  it("warns about groups without explicit policies", () => {
    const m = makeManifest({ policies: {} });
    const issues = validateManifest(m);
    expect(issues.some((i) => i.code === "missing_policy")).toBe(true);
  });

  it("errors when defaultPolicy is missing", () => {
    const m = makeManifest({ defaultPolicy: undefined as unknown as Policy });
    const issues = validateManifest(m);
    expect(errors(issues).some((i) => i.code === "no_default_policy")).toBe(true);
  });
});

// ─── Policy profile composition ──────────────────────────────────

describe("policy profile composition", () => {
  it("exposes named policy profiles in the manifest", () => {
    expect(MANIFEST.policyProfiles).toBe(POLICY_PROFILES);
    expect(Object.keys(POLICY_PROFILES)).toEqual(expect.arrayContaining([
      "nim-openai-chat",
      "nim-tool-primary",
      "chatgpt-responses",
      "anthropic-messages",
    ]));
  });

  it("composes reusable profiles with final overlays", () => {
    const policy = composePolicy(["nim-openai-chat", "nim-tool-primary"], {
      request: { maxRequestTokens: 32000 },
    });

    expect(policy.request.enableReasoning).toBe(true);
    expect(policy.request.rejectStreamingTools).toBe(true);
    expect(policy.request.maxRequestTokens).toBe(32000);
    expect(policy.request.unsupportedParams).toContain("response_format");
    expect(policy.retry.transportRetries).toBe(0);
  });

  it("fails closed on unknown policy profiles", () => {
    expect(() => composePolicy(["missing-profile"])).toThrow("Unknown policy profile");
  });

  it("default policy uses per_key scope so multi-key NIM groups don't share one bucket", () => {
    expect(MANIFEST.defaultPolicy.budget.scopeMode).toBe("per_key");
    // Every concrete policy should inherit per_key unless an explicit overlay says otherwise.
    for (const [name, policy] of Object.entries(MANIFEST.policies)) {
      expect(policy.budget.scopeMode, `policy ${name}`).toBe("per_key");
    }
  });

  it("NIM primary group exposes 9 distinct keyRefs that per_key mode separates", () => {
    const nimPrimary = MANIFEST.deploymentsByGroup["nim-primary"] ?? [];
    const keyRefs = new Set(nimPrimary.map((d) => d.keyRef));
    expect(keyRefs.size).toBe(9);
  });
});
