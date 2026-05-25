import type { ProviderType } from "./schema";

/** USD per 1M tokens — provider defaults. */
export const PROVIDER_USD_PER_MILLION: Partial<Record<ProviderType, { prompt: number; completion: number }>> = {
  anthropic_subscription: { prompt: 3, completion: 15 },
  openai: { prompt: 2.5, completion: 10 },
  chatgpt: { prompt: 2.5, completion: 10 },
  nvidia_nim: { prompt: 0, completion: 0 },
};

/** Optional per providerModel overrides (more accurate than provider-wide defaults). */
export const MODEL_USD_PER_MILLION: Record<string, { prompt: number; completion: number }> = {
  "claude-opus-4-7": { prompt: 15, completion: 75 },
  "claude-sonnet-4-6": { prompt: 3, completion: 15 },
  "gpt-5.5": { prompt: 2.5, completion: 10 },
  "z-ai/glm-5.1": { prompt: 0, completion: 0 },
  "deepseek-ai/deepseek-v3.2": { prompt: 0, completion: 0 },
};

export function ratesForUsageCost(provider: string, model?: string): { prompt: number; completion: number } | null {
  const modelKey = model?.trim();
  if (modelKey && MODEL_USD_PER_MILLION[modelKey]) return MODEL_USD_PER_MILLION[modelKey];
  return PROVIDER_USD_PER_MILLION[provider as ProviderType] ?? null;
}
