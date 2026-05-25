import type { FailureClass } from "./schema";

/** LiteLLM-style fallback categories for routing after failures. */
export type FallbackProfile = "general" | "context_window" | "content_policy";

export function failureClassToFallbackProfile(failureClass: FailureClass | string): FallbackProfile {
  switch (failureClass) {
    case "context_length_exceeded":
      return "context_window";
    case "invalid_model":
      return "general";
    case "client_4xx":
    case "client_4xx_bad_request":
    case "tool_contract_failure":
      return "content_policy";
    default:
      return "general";
  }
}
