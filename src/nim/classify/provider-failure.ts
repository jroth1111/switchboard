// Provider failure classification.
// Ports behavior from litellm_logic/nim/classify/provider_failure.py.

import type { FailureClass } from "../../config/schema";
import { classifyRateLimit } from "./rate-limit";

export interface ProviderFailureClassification {
  failureClass: FailureClass;
  cooldownSeconds: number;
  affectsHealth: boolean;
  affectsAccount: boolean;
  details: string;
}

export function classifyProviderFailure(
  status: number,
  body: string,
  providerType: string,
): ProviderFailureClassification {
  const bodyLower = body.toLowerCase();

  // Auth / OAuth failures
  if (status === 401 || status === 403) {
    if (providerType === "anthropic_subscription" || providerType === "chatgpt") {
      return {
        failureClass: "oauth_session_failure",
        cooldownSeconds: 0,
        affectsHealth: false,
        affectsAccount: true,
        details: `auth_${status}: session/account failure`,
      };
    }
    return {
      failureClass: "auth_failure",
      cooldownSeconds: 0,
      affectsHealth: false,
      affectsAccount: true,
      details: `auth_${status}: invalid key`,
    };
  }

  // Rate limit (delegated to rate_limit classifier, but provide fallback)
  if (status === 429) {
    const rateLimit = classifyRateLimit(status, body, {});
    if (rateLimit) {
      return {
        failureClass: rateLimit.failureClass,
        cooldownSeconds: rateLimit.cooldownSeconds,
        affectsHealth: rateLimit.failureClass !== "rate_limit_quota_window",
        affectsAccount: rateLimit.failureClass === "rate_limit_quota_window",
        details: rateLimit.details,
      };
    }
    return {
      failureClass: "rate_limit_overload",
      cooldownSeconds: 60,
      affectsHealth: true,
      affectsAccount: false,
      details: `rate_limit_429: ${body.slice(0, 200)}`,
    };
  }

  // Context length
  if (status === 400 && isContextLengthError(bodyLower)) {
    return {
      failureClass: "context_length_exceeded",
      cooldownSeconds: 0,
      affectsHealth: false,
      affectsAccount: false,
      details: "context_length_exceeded",
    };
  }

  // Invalid model — use specific patterns to avoid false positives on responses
  // that merely mention the word "model" (e.g. "this request is not a good model for...")
  if (status === 404 || (status === 400 && isInvalidModelError(bodyLower))) {
    return {
      failureClass: "invalid_model",
      cooldownSeconds: 300,
      affectsHealth: false,
      affectsAccount: false,
      details: `invalid_model_${status}`,
    };
  }

  // Server errors
  if (status >= 500) {
    return {
      failureClass: "server_5xx",
      cooldownSeconds: 30,
      affectsHealth: true,
      affectsAccount: false,
      details: `server_${status}: ${body.slice(0, 200)}`,
    };
  }

  // Other 4xx
  if (status >= 400 && status < 500) {
    return {
      failureClass: "client_4xx_bad_request",
      cooldownSeconds: 0,
      affectsHealth: false,
      affectsAccount: false,
      details: `client_${status}: ${body.slice(0, 200)}`,
    };
  }

  return {
    failureClass: "unknown_failure",
    cooldownSeconds: 0,
    affectsHealth: false,
    affectsAccount: false,
    details: `unknown_${status}`,
  };
}

function isContextLengthError(bodyLower: string): boolean {
  return [
    /\bcontext(?:\s+window|\s+length)?\b.{0,80}\b(exceeded|exceeds|too\s+long|max(?:imum)?|limit)\b/,
    /\bprompt\b.{0,80}\b(too\s+long|exceeded|exceeds|max(?:imum)?|limit)\b/,
    /\b(max(?:imum)?[_\s-]?tokens?|too\s+many\s+tokens|token\s+limit|tokens?\s+exceed(?:ed|s)?)\b/,
    /\bmaximum\s+context\b/,
  ].some((pattern) => pattern.test(bodyLower));
}

function isInvalidModelError(bodyLower: string): boolean {
  return (
    /\bmodel\b.{0,120}\b(not\s+found|does\s+not\s+exist|is\s+invalid|invalid|not\s+available|not\s+supported|unavailable|unknown)\b/.test(bodyLower) ||
    /\bunknown\s+model\b/.test(bodyLower)
  );
}

export class SubscriptionTokenError extends Error {
  failureClass: FailureClass;
  constructor(message: string, failureClass: FailureClass) {
    super(message);
    this.name = "SubscriptionTokenError";
    this.failureClass = failureClass;
  }
}

export function classifyThrownError(err: unknown): ProviderFailureClassification {
  // Subscription token errors carry their own failure class
  if (err instanceof SubscriptionTokenError) {
    return {
      failureClass: err.failureClass,
      cooldownSeconds: 0,
      affectsHealth: false,
      affectsAccount: true,
      details: `subscription_token: ${err.message}`,
    };
  }

  if (err instanceof TypeError && /fetch\s*(failed|error)|failed\s*to\s*fetch/i.test(err.message)) {
    return {
      failureClass: "transport_error",
      cooldownSeconds: 15,
      affectsHealth: true,
      affectsAccount: false,
      details: `transport_error: ${err.message}`,
    };
  }

  if (err instanceof Error) {
    if (err.message.includes("timeout") || err.message.includes("Timeout") || err.name === "TimeoutError") {
      return {
        failureClass: "transport_timeout",
        cooldownSeconds: 30,
        affectsHealth: true,
        affectsAccount: false,
        details: `timeout: ${err.message}`,
      };
    }
    if (err.message.includes("abort") || err.name === "AbortError") {
      return {
        failureClass: "transport_timeout",
        cooldownSeconds: 0,
        affectsHealth: false,
        affectsAccount: false,
        details: "abort",
      };
    }
  }

  return {
    failureClass: "unknown_failure",
    cooldownSeconds: 0,
    affectsHealth: false,
    affectsAccount: false,
    details: `unknown_error: ${err instanceof Error ? err.message : String(err)}`,
  };
}
