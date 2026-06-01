import type {
  CredentialRotationSettings,
  CredentialRotationStrategy,
  FailureClass,
  ProviderType,
} from "../config/schema";

export type CredentialKind = "api_key" | "anthropic_oauth" | "chatgpt_oauth";

export interface ApiKeyCredentialSlot {
  kind: "api_key";
  credentialId: string;
  keyRef: string;
  secret: string;
}

export interface AnthropicOAuthCredentialSlot {
  kind: "anthropic_oauth";
  credentialId: string;
  accountId: string;
}

export interface ChatGPTOAuthCredentialSlot {
  kind: "chatgpt_oauth";
  credentialId: string;
  label: string;
  material: string;
}

export type CredentialSlot =
  | ApiKeyCredentialSlot
  | AnthropicOAuthCredentialSlot
  | ChatGPTOAuthCredentialSlot;

export type CredentialOutcomeAction =
  | "success"
  | "rotate"
  | "refresh_same"
  | "retry_same"
  | "fail";

export interface CredentialOutcome {
  action: CredentialOutcomeAction;
  failureClass?: FailureClass;
  cooldownSeconds?: number;
  requiresRelogin?: boolean;
}

export interface ResolvedCredentialRotationSettings extends Required<
  Pick<CredentialRotationSettings, "enabled" | "strategy" | "maxAttempts">
> {
  rateLimitCooldownSeconds: number;
  authFailureCooldownSeconds: number;
  subscriptionLimitCooldownSeconds: number;
  networkRetryAttempts: number;
  rotateOnStatus: number[];
  rotateOnFailureClass: FailureClass[];
}

export const CREDENTIAL_COOLDOWN_SCOPE_PREFIX = "cred:";
export const CREDENTIAL_POOL_ORDER_SCOPE_PREFIX = "cred-order:";

export function credentialCooldownScope(credentialId: string): string {
  return `${CREDENTIAL_COOLDOWN_SCOPE_PREFIX}${credentialId}`;
}

export function credentialPoolOrderScope(deploymentId: string): string {
  return `${CREDENTIAL_POOL_ORDER_SCOPE_PREFIX}${deploymentId}`;
}

export function materializeCredentialSlot(slot: CredentialSlot): string {
  switch (slot.kind) {
    case "api_key":
      return slot.secret;
    case "anthropic_oauth":
      return slot.accountId;
    case "chatgpt_oauth":
      return slot.material;
  }
}

export type { CredentialRotationStrategy, CredentialRotationSettings, ProviderType };
