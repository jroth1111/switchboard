// Token usage observability: tri-state usage tracking.

export type TokenUsage =
  | { kind: "known"; promptTokens: number; completionTokens: number; totalTokens: number; source: string }
  | { kind: "estimated"; promptTokens: number; completionTokens: number; totalTokens: number; source: string }
  | { kind: "unknown"; source: string };

export interface UsageEventPayload {
  requestId: string;
  attemptIndex: number;
  timestamp: number;
  clientId?: string;
  appId?: string;
  userHash?: string;
  policyId?: string;
  policyVersion?: string;
  routeVersion?: string;
  canonicalTarget: string;
  selectedGroup: string;
  deploymentId: string;
  provider: string;
  model: string;
  stream: boolean;
  finalOutcome: string;
  usageKind: string;
  promptTokens: number | null;
  completionTokens: number | null;
  totalTokens: number | null;
  usageSource: string;
}

export function normalizeProviderUsage(
  rawUsage: Record<string, number> | undefined,
  provider: string,
): TokenUsage {
  if (!rawUsage) return { kind: "unknown", source: provider };

  const prompt = rawUsage.prompt_tokens ?? rawUsage.input_tokens;
  const completion = rawUsage.completion_tokens ?? rawUsage.output_tokens;

  if (prompt === undefined || completion === undefined) {
    return { kind: "unknown", source: provider };
  }

  return {
    kind: "known",
    promptTokens: prompt,
    completionTokens: completion,
    totalTokens: prompt + completion,
    source: provider,
  };
}

export function usageEventFromTokenUsage(
  usage: TokenUsage,
): Pick<UsageEventPayload, "usageKind" | "promptTokens" | "completionTokens" | "totalTokens" | "usageSource"> {
  if (usage.kind === "unknown") {
    return {
      usageKind: "unknown",
      promptTokens: null,
      completionTokens: null,
      totalTokens: null,
      usageSource: usage.source,
    };
  }
  return {
    usageKind: usage.kind,
    promptTokens: usage.promptTokens,
    completionTokens: usage.completionTokens,
    totalTokens: usage.totalTokens,
    usageSource: usage.source,
  };
}
