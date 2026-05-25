// Route manifest — the audited source of truth for routing configuration.
// Validate with: pnpm validate

import type { RouteManifest, Policy, Deployment, PolicyProfile } from "./schema";

export const ROUTE_MANIFEST_VERSION = "switchboard-static-2026-05-24";

// ─── Default policy ───────────────────────────────────────────────

const DEFAULT_POLICY: Policy = {
  request: {
    unsupportedParams: [
      "logit_bias", "logprobs", "top_logprobs", "stream_options",
      "reasoning_effort", "ignore_eos", "parallel_tool_calls",
    ],
    supportedSurfaces: ["chat_completions"],
    supportedOperations: [
      "chat", "chat_stream", "tool", "tool_stream",
      "strict_tool", "strict_tool_stream",
    ],
    allowedContentClasses: ["empty", "text", "tool_result"],
    rejectStreamingTools: false,
    stripReasoningFromSuccess: true,
    minRequestTokens: 512,
    maxRequestTokens: null,
    enableReasoning: false,
  },
  response: {
    enableSemanticValidation: true,
    enableToolRepair: true,
    enableSpecialTokenDetection: true,
    enableRepetitionDetection: true,
    repetitionMaxRatio: 0.4,
    semanticMinChars: 1,
    semanticMinEntropy: 2.5,
    semanticMinPrintableRatio: 0.8,
    enableSchemaAwareRepair: false,
    repairPolicy: {
      allowDestructiveByDefault: false,
      conservativeToolPatterns: [],
      enumAliases: {},
      toolNameAliases: {},
      relationalDefaults: {},
    },
  },
  deadline: {
    attemptTimeoutSeconds: 120,
    firstTokenTimeoutSeconds: 15,
    streamIdleTimeoutSeconds: 30,
    streamHardTimeoutSeconds: 120,
    totalTimeoutSeconds: 300,
  },
  retry: {
    transportRetries: 1,
    semanticRetries: 1,
    retryableFailureClasses: [
      "transport_error", "transport_timeout", "server_5xx",
      "rate_limit_overload", "semantic_failure", "truncated_response",
      "tool_contract_failure",
    ],
    backoffBaseMs: 250,
    backoffMaxMs: 2000,
    hedge: { enabled: false, maxCandidates: 1, onlyWhenSuspect: true, hedgeDelayMs: 0 },
  },
  health: {
    circuitFailureThreshold: 5,
    circuitDurationSeconds: 300,
    transportCooldownThreshold: 2,
    transportCooldownSeconds: 90,
    semanticCooldownThreshold: 1,
    rateLimitCooldownThreshold: 1,
    halfOpenPenalty: 2.5,
    circuitSuccessThreshold: 3,
    probeMaxInflight: 1,
    suspectThresholdFraction: 0.6,
    suspectMaxParallelDivisor: 2,
    latencyPenaltyFactor: 5.0,
    latencyEmaAlpha: 0.3,
    latencyWarmupSamples: 5,
  },
  budget: {
    // per_key gives multi-key groups (e.g. NIM with 9 keys × rpm=35) a
    // bucket per (group, keyRef) so per-deployment rpm is honored. Single-key
    // groups collapse to the same bucket either way.
    scopeMode: "per_key",
    rpmLimit: null,
    maxParallelRequests: null,
    learnedConcurrencyEnabled: true,
    learnedConcurrencyTtlSeconds: 60,
    staleInflightSeconds: 120,
    tokenBudgetPerMinute: null,
  },
};

// ─── Profile overlay helpers ──────────────────────────────────────
// Use named policy profiles so common bundles are composed once and reused
// across route groups instead of being copy-pasted into each policy.

function deepOverlay<T extends object>(base: T, overlay: PolicyProfile | Record<string, unknown>): T {
  const result = { ...base };
  const overlayRecord = overlay as Record<string, unknown>;
  for (const key of Object.keys(overlay) as Array<keyof T>) {
    const val = overlayRecord[key as string];
    if (val && typeof val === "object" && !Array.isArray(val) && typeof base[key] === "object" && base[key] !== null) {
      (result as Record<string, unknown>)[key as string] = deepOverlay(
        base[key] as object,
        val as Record<string, unknown>,
      );
    } else {
      (result as Record<string, unknown>)[key as string] = val;
    }
  }
  return result;
}

export const POLICY_PROFILES: Record<string, PolicyProfile> = {
  "reasoning-enabled": {
    request: { enableReasoning: true },
  },
  "nim-openai-chat": {
    request: {
      unsupportedParams: [
        "logit_bias", "logprobs", "top_logprobs", "stream_options",
        "ignore_eos", "parallel_tool_calls", "response_format",
      ],
      enableReasoning: true,
    },
    deadline: { attemptTimeoutSeconds: 45, totalTimeoutSeconds: 240 },
    retry: {
      transportRetries: 0,
      semanticRetries: 0,
      hedge: { enabled: true, maxCandidates: 2, onlyWhenSuspect: true, hedgeDelayMs: 0 },
    },
  },
  "nim-tool-primary": {
    request: {
      rejectStreamingTools: true,
      supportedOperations: ["chat", "chat_stream", "tool", "strict_tool"],
    },
  },
  "chatgpt-responses": {
    request: {
      unsupportedParams: [
        "logit_bias", "logprobs", "top_logprobs", "stream_options",
        "reasoning_effort", "ignore_eos", "parallel_tool_calls",
        "response_format",
      ],
      supportedSurfaces: ["responses"],
      supportedOperations: ["responses", "responses_stream"],
      allowedContentClasses: ["empty", "text", "multimodal", "tool_result"],
      minRequestTokens: null,
      enableReasoning: false,
    },
    retry: { transportRetries: 0, semanticRetries: 0 },
  },
  "anthropic-messages": {
    request: {
      unsupportedParams: [
        "logit_bias", "logprobs", "top_logprobs", "stream_options",
        "response_format", "parallel_tool_calls",
        "presence_penalty", "frequency_penalty",
      ],
      allowedContentClasses: ["empty", "text", "multimodal", "tool_result"],
      minRequestTokens: null,
      enableReasoning: true,
    },
    retry: { transportRetries: 0, semanticRetries: 0 },
  },
};

export function composePolicy(profileNames: string[], overlay: PolicyProfile = {}): Policy {
  let policy = deepOverlay(DEFAULT_POLICY, {});
  for (const name of profileNames) {
    const profile = POLICY_PROFILES[name];
    if (!profile) throw new Error(`Unknown policy profile: ${name}`);
    policy = deepOverlay(policy, profile);
  }
  return deepOverlay(policy, overlay);
}

// ─── Computed policies ────────────────────────────────────────────

function nimOpenaiChat(): Policy {
  return composePolicy(["nim-openai-chat"]);
}

function nimToolPrimary(): Policy {
  return composePolicy(["nim-openai-chat", "nim-tool-primary"]);
}

function chatgptResponses(): Policy {
  return composePolicy(["chatgpt-responses"]);
}

function anthropicMessages(): Policy {
  return composePolicy(["anthropic-messages"]);
}

const policies: Record<string, Policy> = {
  "smart-route-worker": composePolicy(["reasoning-enabled"]),
  "zai-glm-5.1-terminal-fallback": composePolicy(["reasoning-enabled"]),
  "chatgpt-subscription-gpt-5.5-none": chatgptResponses(),
  "chatgpt-subscription-gpt-5.5-minimal": chatgptResponses(),
  "chatgpt-subscription-gpt-5.5-low": chatgptResponses(),
  "chatgpt-subscription-gpt-5.5-medium": chatgptResponses(),
  "chatgpt-subscription-gpt-5.5-high": chatgptResponses(),
  "chatgpt-subscription-gpt-5.5-xhigh": chatgptResponses(),
  "anthropic-subscription-opus-4-7-low": anthropicMessages(),
  "anthropic-subscription-opus-4-7-medium": anthropicMessages(),
  "anthropic-subscription-opus-4-7-high": anthropicMessages(),
  "anthropic-subscription-opus-4-7-xhigh": anthropicMessages(),
  "anthropic-subscription-opus-4-7-max": anthropicMessages(),
  "anthropic-subscription-sonnet-4-6-low": anthropicMessages(),
  "anthropic-subscription-sonnet-4-6-medium": anthropicMessages(),
  "anthropic-subscription-sonnet-4-6-high": anthropicMessages(),
  "anthropic-subscription-sonnet-4-6-max": anthropicMessages(),
  "nim-primary": deepOverlay(nimOpenaiChat(), { request: { maxRequestTokens: 32000 } }),
  "nim-deepseek-v4-pro": nimOpenaiChat(),
  "nim-tool-primary": nimToolPrimary(),
  "nim-secondary": nimOpenaiChat(),
  "nim-kimi-k2.5": nimOpenaiChat(),
  "nim-minimax-m2.7": nimOpenaiChat(),
};

// ─── Manifest ─────────────────────────────────────────────────────

export const MANIFEST: RouteManifest = {
  plannerSettings: {
    healthFallbackMargin: 75.0,
    halfOpenPenalty: 2.5,
    recentDispatchBonus: 20.0,
    recentDispatchTtlSeconds: 45.0,
  },

  aliases: {
    "anthropic-subscription-opus-4-7-low": "anthropic-subscription-opus-4-7-low",
    "anthropic-subscription-opus-4-7-medium": "anthropic-subscription-opus-4-7-medium",
    "anthropic-subscription-opus-4-7-high": "anthropic-subscription-opus-4-7-high",
    "anthropic-subscription-opus-4-7-xhigh": "anthropic-subscription-opus-4-7-xhigh",
    "anthropic-subscription-opus-4-7-max": "anthropic-subscription-opus-4-7-max",
    "anthropic-subscription-sonnet-4-6-low": "anthropic-subscription-sonnet-4-6-low",
    "anthropic-subscription-sonnet-4-6-medium": "anthropic-subscription-sonnet-4-6-medium",
    "anthropic-subscription-sonnet-4-6-high": "anthropic-subscription-sonnet-4-6-high",
    "anthropic-subscription-sonnet-4-6-max": "anthropic-subscription-sonnet-4-6-max",
    "anthropic_subscription/claude-opus-4-7": "anthropic-subscription-opus-4-7-high",
    "anthropic_subscription/claude-sonnet-4-6": "anthropic-subscription-sonnet-4-6-high",
    "anthropic/claude-opus-4-7": "anthropic-subscription-opus-4-7-high",
    "anthropic/claude-sonnet-4-6": "anthropic-subscription-sonnet-4-6-high",
    "claude-opus-4-7": "anthropic-subscription-opus-4-7-high",
    "claude-opus-4.7": "anthropic-subscription-opus-4-7-high",
    "claude-opus-4-7-low": "anthropic-subscription-opus-4-7-low",
    "claude-opus-4.7-low": "anthropic-subscription-opus-4-7-low",
    "claude-opus-4-7-medium": "anthropic-subscription-opus-4-7-medium",
    "claude-opus-4.7-medium": "anthropic-subscription-opus-4-7-medium",
    "claude-opus-4-7-high": "anthropic-subscription-opus-4-7-high",
    "claude-opus-4.7-high": "anthropic-subscription-opus-4-7-high",
    "claude-opus-4-7-xhigh": "anthropic-subscription-opus-4-7-xhigh",
    "claude-opus-4.7-xhigh": "anthropic-subscription-opus-4-7-xhigh",
    "claude-opus-4-7-max": "anthropic-subscription-opus-4-7-max",
    "claude-opus-4.7-max": "anthropic-subscription-opus-4-7-max",
    "claude-opus-4-20250514": "anthropic-subscription-opus-4-7-high",
    "claude-opus-4-6": "anthropic-subscription-opus-4-7-high",
    "claude-opus-4-6-fast": "anthropic-subscription-opus-4-7-high",
    // VibeProxy GHCP / editor IDs (ModelAliasMapper.swift)
    "ghcp-op-46": "anthropic-subscription-opus-4-7-high",
    "ghcp-son-46": "anthropic-subscription-sonnet-4-6-high",
    "ghcp-haik-45": "anthropic-subscription-sonnet-4-6-low",
    "opus-4-7": "anthropic-subscription-opus-4-7-high",
    "opus-4.7": "anthropic-subscription-opus-4-7-high",
    "opus-4-7-low": "anthropic-subscription-opus-4-7-low",
    "opus-4.7-low": "anthropic-subscription-opus-4-7-low",
    "opus-4-7-medium": "anthropic-subscription-opus-4-7-medium",
    "opus-4.7-medium": "anthropic-subscription-opus-4-7-medium",
    "opus-4-7-high": "anthropic-subscription-opus-4-7-high",
    "opus-4.7-high": "anthropic-subscription-opus-4-7-high",
    "opus-4-7-xhigh": "anthropic-subscription-opus-4-7-xhigh",
    "opus-4.7-xhigh": "anthropic-subscription-opus-4-7-xhigh",
    "opus-4-7-max": "anthropic-subscription-opus-4-7-max",
    "opus-4.7-max": "anthropic-subscription-opus-4-7-max",
    "claude-sonnet-4-6": "anthropic-subscription-sonnet-4-6-high",
    "claude-sonnet-4.6": "anthropic-subscription-sonnet-4-6-high",
    "claude-sonnet-4-6-low": "anthropic-subscription-sonnet-4-6-low",
    "claude-sonnet-4.6-low": "anthropic-subscription-sonnet-4-6-low",
    "claude-sonnet-4-6-medium": "anthropic-subscription-sonnet-4-6-medium",
    "claude-sonnet-4.6-medium": "anthropic-subscription-sonnet-4-6-medium",
    "claude-sonnet-4-6-high": "anthropic-subscription-sonnet-4-6-high",
    "claude-sonnet-4.6-high": "anthropic-subscription-sonnet-4-6-high",
    "claude-sonnet-4-6-max": "anthropic-subscription-sonnet-4-6-max",
    "claude-sonnet-4.6-max": "anthropic-subscription-sonnet-4-6-max",
    "claude-sonnet-4-5-20250929": "anthropic-subscription-sonnet-4-6-high",
    "claude-sonnet-4-20250514": "anthropic-subscription-sonnet-4-6-high",
    "sonnet-4-6": "anthropic-subscription-sonnet-4-6-high",
    "sonnet-4.6": "anthropic-subscription-sonnet-4-6-high",
    "sonnet-4-6-low": "anthropic-subscription-sonnet-4-6-low",
    "sonnet-4.6-low": "anthropic-subscription-sonnet-4-6-low",
    "sonnet-4-6-medium": "anthropic-subscription-sonnet-4-6-medium",
    "sonnet-4.6-medium": "anthropic-subscription-sonnet-4-6-medium",
    "sonnet-4-6-high": "anthropic-subscription-sonnet-4-6-high",
    "sonnet-4.6-high": "anthropic-subscription-sonnet-4-6-high",
    "sonnet-4-6-max": "anthropic-subscription-sonnet-4-6-max",
    "sonnet-4.6-max": "anthropic-subscription-sonnet-4-6-max",
    "smart-route": "smart-route-worker",
    "smart-route-worker": "smart-route-worker",
    "zai-glm-5.1": "smart-route-worker",
    "glm-5.1-zai": "smart-route-worker",
    "z.ai/glm-5.1": "smart-route-worker",
    "glm-5.1": "smart-route-worker",
    "muse-spark": "chatgpt-subscription-gpt-5.5-high",
    "openai/glm-5.1": "smart-route-worker",
    "gpt-5.5": "chatgpt-subscription-gpt-5.5-medium",
    "gpt-5.5(none)": "chatgpt-subscription-gpt-5.5-none",
    "gpt-5.5(minimal)": "chatgpt-subscription-gpt-5.5-minimal",
    "gpt-5.5(low)": "chatgpt-subscription-gpt-5.5-low",
    "gpt-5.5(medium)": "chatgpt-subscription-gpt-5.5-medium",
    "gpt-5.5(high)": "chatgpt-subscription-gpt-5.5-high",
    "gpt-5.5(xhigh)": "chatgpt-subscription-gpt-5.5-xhigh",
    "gpt-5.5(x-high)": "chatgpt-subscription-gpt-5.5-xhigh",
    "chatgpt/gpt-5.5": "chatgpt-subscription-gpt-5.5-medium",
    "chatgpt/gpt-5.5-none": "chatgpt-subscription-gpt-5.5-none",
    "chatgpt/gpt-5.5-minimal": "chatgpt-subscription-gpt-5.5-minimal",
    "chatgpt/gpt-5.5-low": "chatgpt-subscription-gpt-5.5-low",
    "chatgpt/gpt-5.5-medium": "chatgpt-subscription-gpt-5.5-medium",
    "chatgpt/gpt-5.5-high": "chatgpt-subscription-gpt-5.5-high",
    "chatgpt/gpt-5.5-xhigh": "chatgpt-subscription-gpt-5.5-xhigh",
    "chatgpt-subscription-gpt-5.5": "chatgpt-subscription-gpt-5.5-medium",
    "chatgpt-subscription-gpt-5.5-none": "chatgpt-subscription-gpt-5.5-none",
    "chatgpt-subscription-gpt-5.5-minimal": "chatgpt-subscription-gpt-5.5-minimal",
    "chatgpt-subscription-gpt-5.5-low": "chatgpt-subscription-gpt-5.5-low",
    "chatgpt-subscription-gpt-5.5-medium": "chatgpt-subscription-gpt-5.5-medium",
    "chatgpt-subscription-gpt-5.5-high": "chatgpt-subscription-gpt-5.5-high",
    "chatgpt-subscription-gpt-5.5-xhigh": "chatgpt-subscription-gpt-5.5-xhigh",
    "custom:gpt-5.5-none-proxy-0": "chatgpt-subscription-gpt-5.5-none",
    "custom:gpt-5.5-minimal-proxy-0": "chatgpt-subscription-gpt-5.5-minimal",
    "custom:gpt-5.5-low-proxy-0": "chatgpt-subscription-gpt-5.5-low",
    "custom:gpt-5.5-medium-proxy-1": "chatgpt-subscription-gpt-5.5-medium",
    "custom:gpt-5.5-high-proxy-2": "chatgpt-subscription-gpt-5.5-high",
    "custom:gpt-5.5-high-proxy-6": "chatgpt-subscription-gpt-5.5-high",
    "custom:gpt-5.5-xhigh-proxy-3": "chatgpt-subscription-gpt-5.5-xhigh",
    "proxy-worker-smart-router": "smart-route-worker",
    "custom:proxy-worker-smart-router-8": "smart-route-worker",
    "custom:proxy-workerpool-8": "smart-route-worker",
    "worker": "smart-route-worker",
    "custom:factory-worker-gpt-5.5-high-8": "chatgpt-subscription-gpt-5.5-high",
    "glm-5-turbo": "chatgpt-subscription-gpt-5.5-high",
    "custom:zai-glm-5-turbo-proxy-9": "chatgpt-subscription-gpt-5.5-high",
    "custom:glm-5-turbo-zai-proxy-1": "chatgpt-subscription-gpt-5.5-high",
    "gemini-3.1-pro-preview": "chatgpt-subscription-gpt-5.5-high",
    "gpt-4.1-mini": "chatgpt-subscription-gpt-5.5-high",
    "custom:glm-5-zai-coding-plan-0": "chatgpt-subscription-gpt-5.5-high",
    "zai-fallback": "zai-glm-5.1-terminal-fallback",
    "zai-glm-5.1-terminal-fallback": "zai-glm-5.1-terminal-fallback",
    "nim-default": "nim-primary",
    "nim-primary": "nim-primary",
    "glm-5.1-nvidia": "nim-primary",
    "custom:nvidia-glm-5.1-proxy-5": "nim-primary",
    "nvidia_nim/z-ai/glm-5.1": "nim-primary",
    "z-ai/glm-5.1": "nim-primary",
    "nim-deepseek-v4-pro": "nim-deepseek-v4-pro",
    "deepseek-v4-pro": "nim-deepseek-v4-pro",
    "deepseek-ai/deepseek-v4-pro": "nim-deepseek-v4-pro",
    "nvidia_nim/deepseek-ai/deepseek-v4-pro": "nim-deepseek-v4-pro",
    "nim-kimi-k2.5": "nim-kimi-k2.5",
    "moonshotai/kimi-k2.5": "nim-kimi-k2.5",
    "kimi-k2.5": "nim-kimi-k2.5",
    "custom:nvidia-kimi-k2.5-proxy-6": "nim-kimi-k2.5",
    "nim-tool-primary": "nim-tool-primary",
    "nim-gemma-4-31b-it": "nim-tool-primary",
    "google/gemma-4-31b-it": "nim-tool-primary",
    "gemma-4-31b-it": "nim-tool-primary",
    "custom:swiftlm-gemma-4-26b-heretic-9": "nim-tool-primary",
    "mlx-community/gemma-4-26b-a4b-it-heretic-4bit": "nim-tool-primary",
    "nim-tool-fallback": "nim-secondary",
    "nim-secondary": "nim-secondary",
    "nim-minimax-m2.7": "nim-minimax-m2.7",
    "minimax-m2.5": "nim-minimax-m2.7",
    "minimaxai/minimax-m2.7": "nim-minimax-m2.7",
    "minimax-m2.7": "nim-minimax-m2.7",
    "custom:nvidia-minimax-m2.5-proxy-7": "nim-minimax-m2.7",
  },

  allowedAmbiguousAliases: [
    ["z.ai/glm-5.1", "z-ai/glm-5.1"],
  ],

  managedModelPrefixes: [
    "anthropic_subscription/", "anthropic-subscription-",
    "claude-subscription-", "chatgpt-subscription-",
    "nim-", "nvidia_nim/", "nvidia/", "zai-",
  ],

  routeGroups: {
    "smart-route-worker": {
      target: "zai-glm-5.1", hidden: false,
      fallbacks: ["nim-primary", "nim-deepseek-v4-pro", "nim-kimi-k2.5", "nim-minimax-m2.7"],
      planner: { toolGroup: "nim-tool-primary", strictToolGroup: "nim-tool-primary" },
    },
    "zai-glm-5.1-terminal-fallback": {
      target: "zai-glm-5.1", hidden: true, fallbacks: [],
    },
    "nim-tool-primary": {
      target: "nim-gemma-4-31b-it", hidden: false, dedicatedToolLane: true,
      fallbacks: ["nim-secondary", "nim-primary", "smart-route-worker"],
    },
    "nim-secondary": {
      target: "nim-minimax-m2.7", hidden: false, dedicatedToolLane: true,
      fallbacks: ["nim-primary", "nim-deepseek-v4-pro", "zai-glm-5.1-terminal-fallback"],
    },
    "nim-primary": {
      target: "nim-primary", hidden: false,
      fallbacks: ["nim-deepseek-v4-pro", "nim-kimi-k2.5", "nim-minimax-m2.7", "zai-glm-5.1-terminal-fallback"],
    },
    "nim-deepseek-v4-pro": {
      target: "nim-deepseek-v4-pro", hidden: false,
      fallbacks: ["nim-minimax-m2.7", "zai-glm-5.1-terminal-fallback"],
    },
    "nim-kimi-k2.5": {
      target: "nim-kimi-k2.5", hidden: false,
      fallbacks: ["nim-minimax-m2.7", "zai-glm-5.1-terminal-fallback"],
    },
    "nim-minimax-m2.7": {
      target: "nim-minimax-m2.7", hidden: false,
      fallbacks: ["zai-glm-5.1-terminal-fallback"],
    },
    "anthropic-subscription-opus-4-7-low": { target: "anthropic-subscription-opus-4-7-low", hidden: true, fallbacks: [] },
    "anthropic-subscription-opus-4-7-medium": { target: "anthropic-subscription-opus-4-7-medium", hidden: true, fallbacks: [] },
    "anthropic-subscription-opus-4-7-high": { target: "anthropic-subscription-opus-4-7-high", hidden: true, fallbacks: [] },
    "anthropic-subscription-opus-4-7-xhigh": { target: "anthropic-subscription-opus-4-7-xhigh", hidden: true, fallbacks: [] },
    "anthropic-subscription-opus-4-7-max": { target: "anthropic-subscription-opus-4-7-max", hidden: true, fallbacks: [] },
    "anthropic-subscription-sonnet-4-6-low": { target: "anthropic-subscription-sonnet-4-6-low", hidden: true, fallbacks: [] },
    "anthropic-subscription-sonnet-4-6-medium": { target: "anthropic-subscription-sonnet-4-6-medium", hidden: true, fallbacks: [] },
    "anthropic-subscription-sonnet-4-6-high": { target: "anthropic-subscription-sonnet-4-6-high", hidden: true, fallbacks: [] },
    "anthropic-subscription-sonnet-4-6-max": { target: "anthropic-subscription-sonnet-4-6-max", hidden: true, fallbacks: [] },
    "chatgpt-subscription-gpt-5.5-none": { target: "chatgpt-subscription-gpt-5.5-none", hidden: true, fallbacks: [] },
    "chatgpt-subscription-gpt-5.5-minimal": { target: "chatgpt-subscription-gpt-5.5-minimal", hidden: true, fallbacks: [] },
    "chatgpt-subscription-gpt-5.5-low": { target: "chatgpt-subscription-gpt-5.5-low", hidden: true, fallbacks: [] },
    "chatgpt-subscription-gpt-5.5-medium": { target: "chatgpt-subscription-gpt-5.5-medium", hidden: true, fallbacks: [] },
    "chatgpt-subscription-gpt-5.5-high": { target: "chatgpt-subscription-gpt-5.5-high", hidden: true, fallbacks: [] },
    "chatgpt-subscription-gpt-5.5-xhigh": { target: "chatgpt-subscription-gpt-5.5-xhigh", hidden: true, fallbacks: [] },
  },

  deployments: [
    // Z.AI
    {
      id: "zai-glm-5.1-key-1", group: "smart-route-worker",
      provider: "openai", model: "glm-5.1", providerModel: "glm-5.1",
      keyRef: "ZAI_KEY_1", apiBase: "https://api.z.ai/api/coding/paas/v4",
      rpm: 30, maxParallelRequests: 1, timeout: 500, streamTimeout: 500,
      supportsStreaming: true,
      capabilities: { toolCalling: "best_effort", streamingWithTools: "best_effort", jsonMode: "native", reasoning: "native", multimodal: "none" },
      contextWindow: 128000, hidden: false,
      params: { temperature: 0.7, top_p: 0.95 },
    },
    // NIM Primary (9 keys)
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `nim-primary-key-${i + 1}`, group: "nim-primary",
      provider: "nvidia_nim" as const, model: "glm-5.1", providerModel: "z-ai/glm-5.1",
      keyRef: `NIM_KEY_${i + 1}`, apiBase: "https://integrate.api.nvidia.com/v1",
      rpm: 35, maxParallelRequests: 2, timeout: 500, streamTimeout: 500,
      supportsStreaming: true,
      capabilities: { toolCalling: "best_effort", streamingWithTools: "best_effort", jsonMode: "broken", reasoning: "native", multimodal: "none" } as const,
      contextWindow: 128000, hidden: false,
      params: { temperature: 0.7, top_p: 0.95, top_k: 40 },
    })),
    // NIM DeepSeek V4 Pro
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `nim-deepseek-v4-pro-key-${i + 1}`, group: "nim-deepseek-v4-pro",
      provider: "nvidia_nim" as const, model: "deepseek-v4-pro", providerModel: "deepseek-ai/deepseek-v4-pro",
      keyRef: `NIM_KEY_${i + 1}`, apiBase: "https://integrate.api.nvidia.com/v1",
      rpm: 35, maxParallelRequests: 2, timeout: 500, streamTimeout: 500,
      supportsStreaming: true,
      capabilities: { toolCalling: "best_effort", streamingWithTools: "best_effort", jsonMode: "broken", reasoning: "native", multimodal: "none" } as const,
      contextWindow: 128000, hidden: false,
      params: { temperature: 0.7, top_p: 0.95, top_k: 40 },
    })),
    // NIM Kimi K2.5
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `nim-kimi-k2.5-key-${i + 1}`, group: "nim-kimi-k2.5",
      provider: "nvidia_nim" as const, model: "kimi-k2.5", providerModel: "moonshotai/kimi-k2.5",
      keyRef: `NIM_KEY_${i + 1}`, apiBase: "https://integrate.api.nvidia.com/v1",
      rpm: 35, maxParallelRequests: 2, timeout: 500, streamTimeout: 500,
      supportsStreaming: true,
      capabilities: { toolCalling: "best_effort", streamingWithTools: "best_effort", jsonMode: "broken", reasoning: "native", multimodal: "none" } as const,
      contextWindow: 128000, hidden: false,
      params: { temperature: 0.7, top_p: 0.95, top_k: 40 },
    })),
    // NIM Gemma 4 31B IT (tool lane)
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `nim-gemma-4-31b-it-key-${i + 1}`, group: "nim-tool-primary",
      provider: "nvidia_nim" as const, model: "gemma-4-31b-it", providerModel: "google/gemma-4-31b-it",
      keyRef: `NIM_KEY_${i + 1}`, apiBase: "https://integrate.api.nvidia.com/v1",
      rpm: 35, maxParallelRequests: 2, timeout: 500, streamTimeout: 500,
      supportsStreaming: true,
      capabilities: { toolCalling: "native", streamingWithTools: "best_effort", jsonMode: "broken", reasoning: "native", multimodal: "none" } as const,
      contextWindow: 128000, hidden: false,
      params: { temperature: 0.7, top_p: 0.95, top_k: 40 },
    })),
    // NIM MiniMax M2.7
    ...Array.from({ length: 9 }, (_, i) => ({
      id: `nim-minimax-m2.7-key-${i + 1}`, group: "nim-minimax-m2.7",
      provider: "nvidia_nim" as const, model: "minimax-m2.7", providerModel: "minimaxai/minimax-m2.7",
      keyRef: `NIM_KEY_${i + 1}`, apiBase: "https://integrate.api.nvidia.com/v1",
      rpm: 35, maxParallelRequests: 2, timeout: 500, streamTimeout: 500,
      supportsStreaming: true,
      capabilities: { toolCalling: "best_effort", streamingWithTools: "best_effort", jsonMode: "broken", reasoning: "native", multimodal: "none" } as const,
      contextWindow: 128000, hidden: false,
      params: { temperature: 0.7, top_p: 0.95, top_k: 40 },
    })),
    // ChatGPT Subscription deployments
    {
      id: "chatgpt-subscription-gpt-5.5-none-key-1", group: "chatgpt-subscription-gpt-5.5-none",
      provider: "chatgpt", model: "gpt-5.5", providerModel: "gpt-5.5",
      keyRef: "CHATGPT_AUTH_JSON", rpm: 10, maxParallelRequests: 1, timeout: 500, streamTimeout: 500,
      supportsStreaming: true, mode: "responses", reasoningEffort: "none",
      capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "native" },
      contextWindow: 400000, hidden: true,
    },
    {
      id: "chatgpt-subscription-gpt-5.5-minimal-key-1", group: "chatgpt-subscription-gpt-5.5-minimal",
      provider: "chatgpt", model: "gpt-5.5", providerModel: "gpt-5.5",
      keyRef: "CHATGPT_AUTH_JSON", rpm: 10, maxParallelRequests: 1, timeout: 500, streamTimeout: 500,
      supportsStreaming: true, mode: "responses", reasoningEffort: "minimal",
      capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "native" },
      contextWindow: 400000, hidden: true,
    },
    {
      id: "chatgpt-subscription-gpt-5.5-low-key-1", group: "chatgpt-subscription-gpt-5.5-low",
      provider: "chatgpt", model: "gpt-5.5", providerModel: "gpt-5.5",
      keyRef: "CHATGPT_AUTH_JSON", rpm: 10, maxParallelRequests: 1, timeout: 500, streamTimeout: 500,
      supportsStreaming: true, mode: "responses", reasoningEffort: "low",
      capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "native" },
      contextWindow: 400000, hidden: true,
    },
    {
      id: "chatgpt-subscription-gpt-5.5-medium-key-1", group: "chatgpt-subscription-gpt-5.5-medium",
      provider: "chatgpt", model: "gpt-5.5", providerModel: "gpt-5.5",
      keyRef: "CHATGPT_AUTH_JSON", rpm: 10, maxParallelRequests: 1, timeout: 500, streamTimeout: 500,
      supportsStreaming: true, mode: "responses", reasoningEffort: "medium",
      capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "native" },
      contextWindow: 400000, hidden: true,
    },
    {
      id: "chatgpt-subscription-gpt-5.5-high-key-1", group: "chatgpt-subscription-gpt-5.5-high",
      provider: "chatgpt", model: "gpt-5.5", providerModel: "gpt-5.5",
      keyRef: "CHATGPT_AUTH_JSON", rpm: 10, maxParallelRequests: 1, timeout: 500, streamTimeout: 500,
      supportsStreaming: true, mode: "responses", reasoningEffort: "high",
      capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "native" },
      contextWindow: 400000, hidden: true,
    },
    {
      id: "chatgpt-subscription-gpt-5.5-xhigh-key-1", group: "chatgpt-subscription-gpt-5.5-xhigh",
      provider: "chatgpt", model: "gpt-5.5", providerModel: "gpt-5.5",
      keyRef: "CHATGPT_AUTH_JSON", rpm: 10, maxParallelRequests: 1, timeout: 500, streamTimeout: 500,
      supportsStreaming: true, mode: "responses", reasoningEffort: "xhigh",
      capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "native" },
      contextWindow: 400000, hidden: true,
    },
    // Anthropic Subscription deployments
    {
      id: "anthropic-subscription-opus-4-7-low-key-1", group: "anthropic-subscription-opus-4-7-low",
      provider: "anthropic_subscription", model: "claude-opus-4-7", providerModel: "claude-opus-4-7",
      keyRef: "ANTHROPIC_OAUTH_ACCOUNT", apiBase: "https://api.anthropic.com",
      rpm: 10, maxParallelRequests: 1, timeout: 500, streamTimeout: 500,
      supportsStreaming: true,
      capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "native" },
      contextWindow: 200000, hidden: true,
      extraBody: { output_config: { effort: "low" } },
    },
    {
      id: "anthropic-subscription-opus-4-7-medium-key-1", group: "anthropic-subscription-opus-4-7-medium",
      provider: "anthropic_subscription", model: "claude-opus-4-7", providerModel: "claude-opus-4-7",
      keyRef: "ANTHROPIC_OAUTH_ACCOUNT", apiBase: "https://api.anthropic.com",
      rpm: 10, maxParallelRequests: 1, timeout: 500, streamTimeout: 500,
      supportsStreaming: true,
      capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "native" },
      contextWindow: 200000, hidden: true,
      extraBody: { output_config: { effort: "medium" } },
    },
    {
      id: "anthropic-subscription-opus-4-7-high-key-1", group: "anthropic-subscription-opus-4-7-high",
      provider: "anthropic_subscription", model: "claude-opus-4-7", providerModel: "claude-opus-4-7",
      keyRef: "ANTHROPIC_OAUTH_ACCOUNT", apiBase: "https://api.anthropic.com",
      rpm: 10, maxParallelRequests: 1, timeout: 500, streamTimeout: 500,
      supportsStreaming: true,
      capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "native" },
      contextWindow: 200000, hidden: true,
      extraBody: { output_config: { effort: "high" } },
    },
    {
      id: "anthropic-subscription-opus-4-7-xhigh-key-1", group: "anthropic-subscription-opus-4-7-xhigh",
      provider: "anthropic_subscription", model: "claude-opus-4-7", providerModel: "claude-opus-4-7",
      keyRef: "ANTHROPIC_OAUTH_ACCOUNT", apiBase: "https://api.anthropic.com",
      rpm: 10, maxParallelRequests: 1, timeout: 500, streamTimeout: 500,
      supportsStreaming: true,
      capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "native" },
      contextWindow: 200000, hidden: true,
      extraBody: { output_config: { effort: "xhigh" } },
    },
    {
      id: "anthropic-subscription-opus-4-7-max-key-1", group: "anthropic-subscription-opus-4-7-max",
      provider: "anthropic_subscription", model: "claude-opus-4-7", providerModel: "claude-opus-4-7",
      keyRef: "ANTHROPIC_OAUTH_ACCOUNT", apiBase: "https://api.anthropic.com",
      rpm: 10, maxParallelRequests: 1, timeout: 500, streamTimeout: 500,
      supportsStreaming: true,
      capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "native" },
      contextWindow: 200000, hidden: true,
      extraBody: { output_config: { effort: "max" } },
    },
    {
      id: "anthropic-subscription-sonnet-4-6-low-key-1", group: "anthropic-subscription-sonnet-4-6-low",
      provider: "anthropic_subscription", model: "claude-sonnet-4-6", providerModel: "claude-sonnet-4-6",
      keyRef: "ANTHROPIC_OAUTH_ACCOUNT", apiBase: "https://api.anthropic.com",
      rpm: 10, maxParallelRequests: 1, timeout: 500, streamTimeout: 500,
      supportsStreaming: true,
      capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "native" },
      contextWindow: 200000, hidden: true,
      extraBody: { output_config: { effort: "low" } },
    },
    {
      id: "anthropic-subscription-sonnet-4-6-medium-key-1", group: "anthropic-subscription-sonnet-4-6-medium",
      provider: "anthropic_subscription", model: "claude-sonnet-4-6", providerModel: "claude-sonnet-4-6",
      keyRef: "ANTHROPIC_OAUTH_ACCOUNT", apiBase: "https://api.anthropic.com",
      rpm: 10, maxParallelRequests: 1, timeout: 500, streamTimeout: 500,
      supportsStreaming: true,
      capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "native" },
      contextWindow: 200000, hidden: true,
      extraBody: { output_config: { effort: "medium" } },
    },
    {
      id: "anthropic-subscription-sonnet-4-6-high-key-1", group: "anthropic-subscription-sonnet-4-6-high",
      provider: "anthropic_subscription", model: "claude-sonnet-4-6", providerModel: "claude-sonnet-4-6",
      keyRef: "ANTHROPIC_OAUTH_ACCOUNT", apiBase: "https://api.anthropic.com",
      rpm: 10, maxParallelRequests: 1, timeout: 500, streamTimeout: 500,
      supportsStreaming: true,
      capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "native" },
      contextWindow: 200000, hidden: true,
      extraBody: { output_config: { effort: "high" } },
    },
    {
      id: "anthropic-subscription-sonnet-4-6-max-key-1", group: "anthropic-subscription-sonnet-4-6-max",
      provider: "anthropic_subscription", model: "claude-sonnet-4-6", providerModel: "claude-sonnet-4-6",
      keyRef: "ANTHROPIC_OAUTH_ACCOUNT", apiBase: "https://api.anthropic.com",
      rpm: 10, maxParallelRequests: 1, timeout: 500, streamTimeout: 500,
      supportsStreaming: true,
      capabilities: { toolCalling: "native", streamingWithTools: "native", jsonMode: "native", reasoning: "native", multimodal: "native" },
      contextWindow: 200000, hidden: true,
      extraBody: { output_config: { effort: "max" } },
    },
    // Terminal fallback Z.AI
    {
      id: "zai-glm-5.1-terminal-fallback-key-1", group: "zai-glm-5.1-terminal-fallback",
      provider: "openai", model: "glm-5.1", providerModel: "glm-5.1",
      keyRef: "ZAI_KEY_1", apiBase: "https://api.z.ai/api/coding/paas/v4",
      rpm: 30, maxParallelRequests: 1, timeout: 500, streamTimeout: 500,
      supportsStreaming: true,
      capabilities: { toolCalling: "best_effort", streamingWithTools: "best_effort", jsonMode: "native", reasoning: "native", multimodal: "none" },
      contextWindow: 128000, hidden: true,
      params: { temperature: 0.7, top_p: 0.95 },
    },
  ],

  deploymentsByGroup: {},

  policyProfiles: POLICY_PROFILES,
  defaultPolicy: DEFAULT_POLICY,
  policies,
};

// Precompute deploymentsByGroup once (replaces getter that recomputed on every access).
const _deploymentsByGroup: Record<string, Deployment[]> = {};
for (const d of MANIFEST.deployments) {
  (_deploymentsByGroup[d.group] ??= []).push(d);
}
MANIFEST.deploymentsByGroup = _deploymentsByGroup;

export type { RouteManifest };
