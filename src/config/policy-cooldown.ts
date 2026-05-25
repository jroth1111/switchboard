import type { Policy } from "./schema";

const TRANSPORT_FAILURE_CLASSES = ["transport_error", "transport_timeout", "server_5xx"];
const SEMANTIC_FAILURE_CLASSES = [
  "semantic_failure",
  "empty_response",
  "truncated_response",
  "repetition_detected",
  "reasoning_leak",
  "special_token_leak",
  "malformed_response",
];

export function applyPolicyCooldown(failureClass: string, cooldownSec: number, policy: Policy): number {
  if (TRANSPORT_FAILURE_CLASSES.includes(failureClass) && policy.health.transportCooldownSeconds > 0) {
    return Math.max(cooldownSec, policy.health.transportCooldownSeconds);
  }
  if (
    SEMANTIC_FAILURE_CLASSES.includes(failureClass)
    && policy.health.semanticCooldownThreshold > 0
    && cooldownSec === 0
  ) {
    return policy.health.semanticCooldownThreshold;
  }
  if (
    failureClass.startsWith("rate_limit_")
    && policy.health.rateLimitCooldownThreshold > 0
    && cooldownSec === 0
  ) {
    return policy.health.rateLimitCooldownThreshold;
  }
  return cooldownSec;
}
