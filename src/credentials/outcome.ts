import type { FailureClass } from "../config/schema";
import type { ProviderFailureClassification } from "../nim/classify/provider-failure";
import type { CredentialOutcome, ResolvedCredentialRotationSettings } from "./types";

export function classifyCredentialHttpOutcome(
  status: number,
  classification: ProviderFailureClassification,
  settings: ResolvedCredentialRotationSettings,
): CredentialOutcome {
  if (status < 400) return { action: "success" };

  const failureClass = classification.failureClass;
  const rotateByClass = settings.rotateOnFailureClass.includes(failureClass);
  const rotateByStatus = settings.rotateOnStatus.includes(status);

  if (status === 401 || status === 403 || failureClass === "oauth_session_failure" || failureClass === "oauth_refresh_failure") {
    if (rotateByStatus || rotateByClass) {
      return {
        action: "refresh_same",
        failureClass,
        cooldownSeconds: settings.authFailureCooldownSeconds,
        requiresRelogin: classification.affectsAccount && status === 403,
      };
    }
  }

  if (status === 402 || failureClass === "subscription_limit") {
    if (rotateByStatus || rotateByClass) {
      return {
        action: "rotate",
        failureClass,
        cooldownSeconds: settings.subscriptionLimitCooldownSeconds,
      };
    }
  }

  if (status === 429 || failureClass.startsWith("rate_limit_")) {
    if (rotateByStatus || rotateByClass) {
      return {
        action: "rotate",
        failureClass,
        cooldownSeconds: settings.rateLimitCooldownSeconds,
      };
    }
  }

  if (rotateByStatus || rotateByClass) {
    return {
      action: "rotate",
      failureClass,
      cooldownSeconds: settings.authFailureCooldownSeconds,
    };
  }

  return { action: "fail", failureClass };
}

export function classifyCredentialTransportOutcome(
  error: unknown,
  settings: ResolvedCredentialRotationSettings,
): CredentialOutcome {
  if (settings.networkRetryAttempts <= 0) {
    return { action: "fail", failureClass: "transport_error" };
  }
  return { action: "retry_same", failureClass: "transport_error" };
}

export function cooldownMsForOutcome(
  outcome: CredentialOutcome,
  settings: ResolvedCredentialRotationSettings,
  retryAfterHeader?: string,
): number {
  if (outcome.cooldownSeconds !== undefined) {
    return outcome.cooldownSeconds * 1000;
  }
  const parsed = retryAfterHeader ? Number(retryAfterHeader) : NaN;
  if (Number.isFinite(parsed) && parsed > 0) {
    return parsed * 1000;
  }
  return settings.rateLimitCooldownSeconds * 1000;
}

export type { FailureClass };
