import type { BillingClass, ProviderType, RouteManifest } from "./schema";
import type { ValidationIssue } from "./validate-manifest";

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

export function ratesForUsageCost(
  provider: string,
  model?: string,
  billingClass?: BillingClass,
): { prompt: number; completion: number } | null {
  if (billingClass === "free") return { prompt: 0, completion: 0 };
  const modelKey = model?.trim();
  if (modelKey && MODEL_USD_PER_MILLION[modelKey]) return MODEL_USD_PER_MILLION[modelKey];
  return PROVIDER_USD_PER_MILLION[provider as ProviderType] ?? null;
}

/** Warn when manifest deployments lack heuristic pricing for cost estimates. */
export function validateUsagePricingCoverage(manifest: RouteManifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const seen = new Set<string>();

  for (const deployment of manifest.deployments) {
    const key = `${deployment.provider}\0${deployment.providerModel}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (ratesForUsageCost(deployment.provider, deployment.providerModel, deployment.billingClass) !== null) continue;

    issues.push({
      kind: "warning",
      code: "usage_pricing_missing_model",
      message: `No usage pricing for provider "${deployment.provider}" model "${deployment.providerModel}"`,
      detail: `deployment ${deployment.id}`,
    });
  }

  return issues;
}
