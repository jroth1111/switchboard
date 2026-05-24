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
  rawUsage: Record<string, unknown> | undefined,
  provider: string,
): TokenUsage {
  if (!rawUsage) return { kind: "unknown", source: provider };

  const prompt = readTokenCount(rawUsage, ["prompt_tokens", "input_tokens"]);
  const completion = readTokenCount(rawUsage, ["completion_tokens", "output_tokens"]);
  const total = readTokenCount(rawUsage, ["total_tokens", "total"]);

  if (prompt === undefined || completion === undefined) {
    if (total !== undefined) {
      return {
        kind: "estimated",
        promptTokens: 0,
        completionTokens: total,
        totalTokens: total,
        source: `${provider}:total_tokens`,
      };
    }
    return { kind: "unknown", source: provider };
  }

  const componentSum = prompt + completion;
  const accountedTotal = Math.max(total ?? componentSum, componentSum);
  const accountedCompletion = completion + (accountedTotal - componentSum);
  return {
    kind: "known",
    promptTokens: prompt,
    completionTokens: accountedCompletion,
    totalTokens: accountedTotal,
    source: provider,
  };
}

function readTokenCount(rawUsage: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const parsed = parseTokenCount(rawUsage[key]);
    if (parsed !== undefined) return parsed;
  }
  return undefined;
}

function parseTokenCount(value: unknown): number | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) return undefined;
    return Math.ceil(value);
  }
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed < 0) return undefined;
    return Math.ceil(parsed);
  }
  return undefined;
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
