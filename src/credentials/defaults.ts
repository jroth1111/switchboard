import type {
  CredentialRotationSettings,
  CredentialRotationStrategy,
  ProviderType,
} from "../config/schema";

const SEQUENTIAL: CredentialRotationSettings = {
  strategy: "sequential_exhaust",
  rateLimitCooldownSeconds: 30,
  authFailureCooldownSeconds: 300,
  subscriptionLimitCooldownSeconds: 900,
  rotateOnStatus: [401, 403, 402, 429],
  rotateOnFailureClass: [
    "rate_limit_overload",
    "rate_limit_quota_window",
    "rate_limit_concurrency",
    "rate_limit_concurrency_ambiguous",
    "auth_failure",
    "oauth_session_failure",
    "oauth_refresh_failure",
    "subscription_limit",
  ],
};

const SPREAD: CredentialRotationSettings = {
  strategy: "spread",
  rateLimitCooldownSeconds: 10,
  authFailureCooldownSeconds: 120,
  subscriptionLimitCooldownSeconds: 600,
  rotateOnStatus: [401, 403, 402, 429],
  rotateOnFailureClass: [
    "rate_limit_overload",
    "rate_limit_quota_window",
    "rate_limit_concurrency",
    "rate_limit_concurrency_ambiguous",
    "auth_failure",
    "subscription_limit",
  ],
};

const NONE: CredentialRotationSettings = {
  strategy: "none",
};

const BASE_DEFAULTS: Record<ProviderType, CredentialRotationSettings> = {
  nvidia_nim: SPREAD,
  openai: SPREAD,
  chatgpt: SEQUENTIAL,
  anthropic_subscription: SEQUENTIAL,
};

const registryOverrides = new Map<ProviderType, CredentialRotationSettings>();

export function registerCredentialRotationDefaults(
  provider: ProviderType,
  settings: CredentialRotationSettings,
): void {
  registryOverrides.set(provider, settings);
}

export function providerRotationDefaults(provider: ProviderType): CredentialRotationSettings {
  const override = registryOverrides.get(provider);
  if (override) return { ...BASE_DEFAULTS[provider], ...override };
  return BASE_DEFAULTS[provider] ?? NONE;
}

export function defaultStrategyForProvider(provider: ProviderType): CredentialRotationStrategy {
  return providerRotationDefaults(provider).strategy ?? "none";
}
