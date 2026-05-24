// ─── Provider types ───────────────────────────────────────────────

export type ProviderType =
  | "nvidia_nim"
  | "openai"
  | "chatgpt"
  | "anthropic_subscription";

export type CapabilityLevel = "native" | "best_effort" | "broken" | "none";

export type Surface = "chat_completions" | "responses";
export type Operation =
  | "chat" | "chat_stream"
  | "tool" | "tool_stream"
  | "strict_tool" | "strict_tool_stream"
  | "responses" | "responses_stream";
export type ContentClass = "empty" | "text" | "multimodal" | "tool_result";

export type FailureClass =
  | "rate_limit_overload"
  | "rate_limit_quota_window"
  | "rate_limit_concurrency"
  | "rate_limit_concurrency_ambiguous"
  | "server_5xx"
  | "transport_error"
  | "transport_timeout"
  | "auth_failure"
  | "oauth_session_failure"
  | "oauth_refresh_failure"
  | "subscription_limit"
  | "responses_api_error"
  | "client_4xx"
  | "client_4xx_bad_request"
  | "context_length_exceeded"
  | "invalid_model"
  | "malformed_response"
  | "empty_response"
  | "truncated_response"
  | "semantic_failure"
  | "success_shaped_failure"
  | "tool_contract_failure"
  | "stream_interruption"
  | "repetition_detected"
  | "reasoning_leak"
  | "special_token_leak"
  | "input_echo"
  | "unknown_failure";

// ─── Deployment ───────────────────────────────────────────────────

export interface ProviderCooldownProfile {
  overloadCooldownSeconds?: number;
  quotaCooldownSeconds?: number;
  concurrencyCooldownSeconds?: number;
  ambiguousCooldownSeconds?: number;
}

export interface Deployment {
  id: string;
  group: string;
  provider: ProviderType;
  model: string;
  providerModel: string;
  keyRef: string;
  apiBase?: string;
  rpm: number;
  maxParallelRequests: number;
  timeout: number;
  streamTimeout: number;
  supportsStreaming: boolean;
  capabilities: {
    toolCalling: CapabilityLevel;
    streamingWithTools: CapabilityLevel;
    jsonMode: CapabilityLevel;
    reasoning: CapabilityLevel;
    multimodal: CapabilityLevel;
  };
  contextWindow: number;
  hidden: boolean;
  mode?: string;
  reasoningEffort?: string;
  params?: Record<string, unknown>;
  extraBody?: Record<string, unknown>;
  cooldownProfile?: ProviderCooldownProfile;
}

// ─── Route group ──────────────────────────────────────────────────

export interface RouteGroup {
  target: string;
  hidden: boolean;
  fallbacks: string[];
  dedicatedToolLane?: boolean;
  planner?: {
    toolGroup?: string;
    strictToolGroup?: string;
  };
}

// ─── Policy ───────────────────────────────────────────────────────

export interface Policy {
  request: {
    unsupportedParams: string[];
    supportedSurfaces: Surface[];
    supportedOperations: Operation[];
    allowedContentClasses: ContentClass[];
    rejectStreamingTools: boolean;
    stripReasoningFromSuccess: boolean;
    minRequestTokens: number | null;
    maxRequestTokens: number | null;
    enableReasoning: boolean;
  };
  response: {
    enableSemanticValidation: boolean;
    enableToolRepair: boolean;
    enableSpecialTokenDetection: boolean;
    enableRepetitionDetection: boolean;
    repetitionMaxRatio: number;
    semanticMinChars: number;
    semanticMinEntropy: number;
    semanticMinPrintableRatio: number;
    enableSchemaAwareRepair: boolean;
    repairPolicy: {
      allowDestructiveByDefault: boolean;
      conservativeToolPatterns: string[];
      enumAliases: Record<string, Record<string, string>>;
      toolNameAliases: Record<string, string>;
      relationalDefaults: Record<string, Array<{
        whenPresent: string[];
        whenMissing: string[];
        set: Record<string, unknown>;
      }>>;
    };
  };
  deadline: {
    attemptTimeoutSeconds: number;
    firstTokenTimeoutSeconds: number;
    streamIdleTimeoutSeconds: number;
    streamHardTimeoutSeconds?: number;
    totalTimeoutSeconds: number;
  };
  retry: {
    transportRetries: number;
    semanticRetries: number;
    retryableFailureClasses: FailureClass[];
    backoffBaseMs: number;
    backoffMaxMs: number;
    hedge?: {
      enabled: boolean;
      maxCandidates: number;
      onlyWhenSuspect: boolean;
      hedgeDelayMs: number;
    };
  };
  health: {
    circuitFailureThreshold: number;
    circuitDurationSeconds: number;
    transportCooldownThreshold: number;
    transportCooldownSeconds: number;
    semanticCooldownThreshold: number;
    rateLimitCooldownThreshold: number;
    halfOpenPenalty: number;
    circuitSuccessThreshold: number;
    probeMaxInflight: number;
    suspectThresholdFraction: number;
    suspectMaxParallelDivisor: number;
    latencyPenaltyFactor: number;
    latencyEmaAlpha: number;
    latencyWarmupSamples: number;
  };
  budget: {
    scopeMode: "global" | "per_key";
    rpmLimit: number | null;
    maxParallelRequests: number | null;
    learnedConcurrencyEnabled: boolean;
    learnedConcurrencyTtlSeconds: number;
    staleInflightSeconds: number;
    tokenBudgetPerMinute: number | null;
  };
}

export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends Array<infer U>
    ? U[]
    : T[P] extends object
      ? DeepPartial<T[P]>
      : T[P];
};

export type PolicyProfile = DeepPartial<Policy>;

// ─── Planner settings ─────────────────────────────────────────────

export interface PlannerSettings {
  healthFallbackMargin: number;
  halfOpenPenalty: number;
  recentDispatchBonus: number;
  recentDispatchTtlSeconds: number;
}

// ─── Manifest ─────────────────────────────────────────────────────

export interface RouteManifest {
  plannerSettings: PlannerSettings;
  aliases: Record<string, string>;
  allowedAmbiguousAliases: string[][];
  managedModelPrefixes: string[];
  routeGroups: Record<string, RouteGroup>;
  deployments: Deployment[];
  deploymentsByGroup: Record<string, Deployment[]>;
  policyProfiles?: Record<string, PolicyProfile>;
  policies: Record<string, Policy>;
  defaultPolicy: Policy;
}
