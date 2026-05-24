// Anthropic subscription-specific failure classification.
// Claude Code OAuth failures are health-neutral and account-scoped.

import type { FailureClass } from "../config/schema";
import type { ProviderFailureClassification } from "../nim/classify/provider-failure";

export function classifyAnthropicFailure(
  status: number,
  body: string,
): ProviderFailureClassification {
  const bodyLower = body.toLowerCase();

  // OAuth token expired or invalid
  if (status === 401) {
    if (bodyLower.includes("invalid") || bodyLower.includes("expired") || bodyLower.includes("token")) {
      return {
        failureClass: "oauth_refresh_failure",
        cooldownSeconds: 30,
        affectsHealth: false,
        affectsAccount: true,
        details: "anthropic_oauth_expired",
      };
    }
    return {
      failureClass: "auth_failure",
      cooldownSeconds: 0,
      affectsHealth: false,
      affectsAccount: true,
      details: "anthropic_auth_invalid",
    };
  }

  // Permission / subscription issue
  if (status === 403) {
    return {
      failureClass: "oauth_session_failure",
      cooldownSeconds: 60,
      affectsHealth: false,
      affectsAccount: true,
      details: "anthropic_forbidden",
    };
  }

  // Rate limit
  if (status === 429) {
    // Anthropic rate limits can indicate usage tier limits
    if (bodyLower.includes("usage") || bodyLower.includes("tier") || bodyLower.includes("limit")) {
      return {
        failureClass: "subscription_limit",
        cooldownSeconds: 120,
        affectsHealth: false,
        affectsAccount: true,
        details: "anthropic_usage_limit",
      };
    }
    return {
      failureClass: "rate_limit_overload",
      cooldownSeconds: 60,
      affectsHealth: true,
      affectsAccount: false,
      details: "anthropic_rate_limit",
    };
  }

  // Context length exceeded (Anthropic returns 400 with specific error type)
  if (status === 400 && (
    bodyLower.includes("context") ||
    bodyLower.includes("max tokens") ||
    bodyLower.includes("too many tokens") ||
    bodyLower.includes("prompt is too long")
  )) {
    return {
      failureClass: "context_length_exceeded",
      cooldownSeconds: 0,
      affectsHealth: false,
      affectsAccount: false,
      details: "anthropic_context_length",
    };
  }

  // Anthropic-specific overloaded
  if (status === 529) {
    return {
      failureClass: "server_5xx",
      cooldownSeconds: 30,
      affectsHealth: true,
      affectsAccount: false,
      details: "anthropic_overloaded",
    };
  }

  return {
    failureClass: "unknown_failure",
    cooldownSeconds: 0,
    affectsHealth: false,
    affectsAccount: false,
    details: `anthropic_unclassified_${status}`,
  };
}
