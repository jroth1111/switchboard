import { ratesForUsageCost } from "../config/usage-pricing";
import type { TokenUsage } from "./token-usage";

export function estimateUsageCostUsd(
  provider: string,
  usage: Pick<TokenUsage, "kind"> & Partial<Pick<TokenUsage, "promptTokens" | "completionTokens">>,
  model?: string,
): number | null {
  if (usage.kind === "unknown") return null;
  const rates = ratesForUsageCost(provider, model);
  if (!rates) return null;
  const prompt = usage.promptTokens ?? 0;
  const completion = usage.completionTokens ?? 0;
  const cost = (prompt * rates.prompt + completion * rates.completion) / 1_000_000;
  if (!Number.isFinite(cost) || cost < 0) return null;
  return Math.round(cost * 1e6) / 1e6;
}
