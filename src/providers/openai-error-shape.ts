import type { FailureClass } from "../config/schema";

export interface OpenAIErrorFields {
  message: string;
  type: string;
  code: string;
  param?: string;
}

/** Maps internal FailureClass to OpenAI-compatible error objects (CCR / Claude Code clients). */
export function failureClassToOpenAIError(
  failureClass: FailureClass | string | undefined,
  message: string,
): OpenAIErrorFields {
  const fc = failureClass ?? "unknown_failure";
  switch (fc) {
    case "rate_limit_overload":
    case "rate_limit_quota_window":
    case "rate_limit_concurrency":
    case "rate_limit_concurrency_ambiguous":
      return { message, type: "rate_limit_error", code: "rate_limit_exceeded" };
    case "auth_failure":
    case "oauth_session_failure":
    case "oauth_refresh_failure":
      return { message, type: "authentication_error", code: fc };
    case "subscription_limit":
      return { message, type: "insufficient_quota", code: "subscription_limit" };
    case "context_length_exceeded":
      return { message, type: "invalid_request_error", code: "context_length_exceeded", param: "messages" };
    case "invalid_model":
      return { message, type: "invalid_request_error", code: "model_not_found", param: "model" };
    case "client_4xx":
    case "client_4xx_bad_request":
      return { message, type: "invalid_request_error", code: "invalid_request" };
    case "server_5xx":
    case "transport_error":
    case "transport_timeout":
      return { message, type: "server_error", code: fc };
    case "tool_contract_failure":
    case "semantic_failure":
    case "malformed_response":
    case "empty_response":
    case "truncated_response":
    case "repetition_detected":
    case "reasoning_leak":
    case "special_token_leak":
    case "input_echo":
    case "success_shaped_failure":
    case "stream_interruption":
    case "responses_api_error":
      return { message, type: "api_error", code: fc };
    default:
      return { message, type: "api_error", code: typeof fc === "string" ? fc : "unknown_failure" };
  }
}

export function openAIErrorJson(
  failureClass: FailureClass | string | undefined,
  message: string,
  requestId?: string,
): string {
  const error = failureClassToOpenAIError(failureClass, message);
  const body: Record<string, unknown> = { error };
  if (requestId) body.request_id = requestId;
  return JSON.stringify(body);
}
