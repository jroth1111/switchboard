// ChatGPT subscription-specific failure classification.
// Health-neutral: auth/session failures should not affect provider health,
// only account availability.

import type { ProviderFailureClassification } from "../nim/classify/provider-failure";

export { failureClassToOpenAIError, openAIErrorJson } from "./openai-error-shape";

export function classifyChatGPTFailure(
  status: number,
  body: string,
): ProviderFailureClassification {
  const bodyLower = body.toLowerCase();

  // Session/auth expiry — health-neutral, account-scoped
  if (status === 401) {
    if (bodyLower.includes("session") || bodyLower.includes("expired") || bodyLower.includes("token")) {
      return {
        failureClass: "oauth_session_failure",
        cooldownSeconds: 60,
        affectsHealth: false,
        affectsAccount: true,
        details: "chatgpt_session_expired",
      };
    }
    return {
      failureClass: "auth_failure",
      cooldownSeconds: 0,
      affectsHealth: false,
      affectsAccount: true,
      details: "chatgpt_auth_invalid",
    };
  }

  // Subscription limits
  if (status === 403) {
    if (bodyLower.includes("limit") || bodyLower.includes("quota") || bodyLower.includes("subscription")) {
      return {
        failureClass: "subscription_limit",
        cooldownSeconds: 300,
        affectsHealth: false,
        affectsAccount: true,
        details: "chatgpt_subscription_limit",
      };
    }
    return {
      failureClass: "oauth_session_failure",
      cooldownSeconds: 60,
      affectsHealth: false,
      affectsAccount: true,
      details: "chatgpt_forbidden",
    };
  }

  // Context length exceeded (check before Responses API errors — context errors with
  // "responses" in the body should be classified as context_length, not responses_api_error)
  if (status === 400 && isChatGPTContextLengthError(bodyLower)) {
    return {
      failureClass: "context_length_exceeded",
      cooldownSeconds: 0,
      affectsHealth: false,
      affectsAccount: false,
      details: "chatgpt_context_length",
    };
  }

  // OAuth/token validation on 400, before generic Responses API errors.
  if (status === 400 && isChatGPTTokenAuthError(bodyLower)) {
    return {
      failureClass: "oauth_session_failure",
      cooldownSeconds: 60,
      affectsHealth: false,
      affectsAccount: true,
      details: "chatgpt_token_invalid",
    };
  }

  if (status === 404 || (status === 400 && /model.*(?:not\s*found|does\s*not\s*exist|is\s*invalid|not\s*available|not\s*supported|unavailable)/i.test(bodyLower))) {
    return {
      failureClass: "invalid_model",
      cooldownSeconds: 300,
      affectsHealth: false,
      affectsAccount: false,
      details: `chatgpt_invalid_model_${status}`,
    };
  }

  // Responses API specific errors
  if (status === 422 || status === 400) {
    return {
      failureClass: "responses_api_error",
      cooldownSeconds: 0,
      affectsHealth: false,
      affectsAccount: false,
      details: `chatgpt_responses_error_${status}: ${body.slice(0, 200)}`,
    };
  }

  // Rate limit — treat like any other rate limit
  if (status === 429) {
    return {
      failureClass: "rate_limit_overload",
      cooldownSeconds: 60,
      affectsHealth: true,
      affectsAccount: true,
      details: "chatgpt_rate_limit",
    };
  }

  // No special classification needed
  return {
    failureClass: "unknown_failure",
    cooldownSeconds: 0,
    affectsHealth: false,
    affectsAccount: false,
    details: `chatgpt_unclassified_${status}`,
  };
}

export function isChatGPTContextLengthError(bodyLower: string): boolean {
  return bodyLower.includes("context")
    || bodyLower.includes("max_tokens")
    || bodyLower.includes("too many tokens")
    || bodyLower.includes("maximum context");
}

function isChatGPTTokenAuthError(bodyLower: string): boolean {
  if (!bodyLower.includes("token")) return false;
  return bodyLower.includes("invalid")
    || bodyLower.includes("expired")
    || bodyLower.includes("malformed")
    || bodyLower.includes("unauthorized");
}
