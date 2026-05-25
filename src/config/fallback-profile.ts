import type { FailureClass } from "./schema";

export type FallbackProfile = "general" | "context_window" | "content_policy";

export function failureClassToFallbackProfile(failureClass: FailureClass | string): FallbackProfile {
  switch (failureClass) {
    case "context_length_exceeded":
      return "context_window";
    case "client_4xx":
    case "client_4xx_bad_request":
    case "invalid_model":
    case "tool_contract_failure":
      return "content_policy";
    default:
      return "general";
  }
}
