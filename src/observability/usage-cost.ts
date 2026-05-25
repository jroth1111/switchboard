import type { ProviderType } from "../config/schema";
import type { TokenUsage } from "./token-usage";

/** Rough USD per 1M tokens for hosted billing estimates (operator-facing, not invoice-grade). */
const USD_PER_MILLION: Partial<Record<ProviderType, { prompt: number; completion: number }>> = {
  anthropic_subscription: { prompt: 3, completion: 15 },
  openai: { prompt: 2.5, completion: 10 },
  chatgpt: { prompt: 2.5, completion: 10 },
  nvidia_nim: { prompt: 0, completion: 0 },
};

export function estimateUsageCostUsd(
  provider: string,
  usage: Pick<TokenUsage, "kind"> & Partial<Pick<TokenUsage, "promptTokens" | "completionTokens">>,
): number | null {
  if (usage.kind === "unknown") return null;
  const rates = USD_PER_MILLION[provider as ProviderType];
  if (!rates) return null;
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  const cost = (prompt * rates.prompt + completion * rates.completion) / 1_000_000;
  if (!Number.isFinite(cost) || cost < 0) return null;
  return Math.round(cost * 1e6) / 1e6;
}
