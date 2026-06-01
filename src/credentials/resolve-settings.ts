import type { Deployment, Policy, ProviderType } from "../config/schema";
import { providerRotationDefaults } from "./defaults";
import type { ResolvedCredentialRotationSettings } from "./types";

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function mergeRotationSettings(
  ...layers: Array<Record<string, unknown> | undefined>
): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const layer of layers) {
    if (!layer) continue;
    for (const [key, value] of Object.entries(layer)) {
      if (key === "byProvider") continue;
      if (Array.isArray(value)) {
        result[key] = [...value];
      } else if (isPlainRecord(value) && isPlainRecord(result[key])) {
        result[key] = mergeRotationSettings(result[key] as Record<string, unknown>, value);
      } else {
        result[key] = value;
      }
    }
  }
  return result;
}

export function resolveCredentialRotationSettings(
  provider: ProviderType,
  deployment: Deployment,
  policy: Policy,
  poolSize: number,
  transportRetries: number,
): ResolvedCredentialRotationSettings {
  const defaults = providerRotationDefaults(provider);
  const policyRoot = policy.credentialRotation;
  const policyGlobal = policyRoot
    ? Object.fromEntries(Object.entries(policyRoot).filter(([k]) => k !== "byProvider"))
    : undefined;
  const policyProvider = policyRoot?.byProvider?.[provider];
  const merged = mergeRotationSettings(
    defaults as Record<string, unknown>,
    policyGlobal,
    policyProvider as Record<string, unknown> | undefined,
    deployment.credentialRotation as Record<string, unknown> | undefined,
  );

  const strategy = (merged.strategy as ResolvedCredentialRotationSettings["strategy"] | undefined)
    ?? "none";
  const enabled = merged.enabled !== undefined
    ? Boolean(merged.enabled)
    : poolSize > 1 && strategy !== "none";

  const maxAttemptsRaw = merged.maxAttempts;
  const maxAttempts = typeof maxAttemptsRaw === "number" && maxAttemptsRaw > 0
    ? Math.min(Math.floor(maxAttemptsRaw), Math.max(poolSize, 1))
    : Math.max(poolSize, 1);

  const networkRetryAttempts = typeof merged.networkRetryAttempts === "number"
    ? Math.max(0, Math.floor(merged.networkRetryAttempts))
    : transportRetries;

  return {
    enabled,
    strategy,
    maxAttempts,
    rateLimitCooldownSeconds: numberOr(merged.rateLimitCooldownSeconds, 30),
    authFailureCooldownSeconds: numberOr(merged.authFailureCooldownSeconds, 300),
    subscriptionLimitCooldownSeconds: numberOr(merged.subscriptionLimitCooldownSeconds, 900),
    networkRetryAttempts,
    rotateOnStatus: Array.isArray(merged.rotateOnStatus)
      ? merged.rotateOnStatus.filter((v): v is number => typeof v === "number")
      : [401, 403, 402, 429],
    rotateOnFailureClass: Array.isArray(merged.rotateOnFailureClass)
      ? merged.rotateOnFailureClass as ResolvedCredentialRotationSettings["rotateOnFailureClass"]
      : [],
  };
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}
