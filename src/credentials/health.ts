import type { FailureClass } from "../config/schema";
import { credentialCooldownScope } from "./types";

export interface CredentialCooldownSnapshot {
  until: number;
  reason: string;
  requiresRelogin?: boolean;
}

export interface CredentialHealthAccessor {
  getCredentialCooldown?(credentialId: string, now?: number): Promise<CredentialCooldownSnapshot | null>;
  setCredentialCooldown?(
    credentialId: string,
    failureClass: FailureClass,
    untilMs: number,
    details?: { requiresRelogin?: boolean; statusCode?: number },
  ): Promise<void>;
  clearCredentialCooldown?(credentialId: string): Promise<void>;
  getCredentialPoolOrder?(deploymentId: string): Promise<string[] | null>;
  setCredentialPoolOrder?(deploymentId: string, order: string[]): Promise<void>;
}

export function isCredentialOnCooldown(
  snapshot: CredentialCooldownSnapshot | null | undefined,
  now: number,
): boolean {
  return snapshot !== null && snapshot !== undefined && snapshot.until > now;
}

export function credentialScopeForId(credentialId: string): string {
  return credentialCooldownScope(credentialId);
}

export function credentialHealthFromState(
  stateDo: CredentialHealthAccessor | undefined,
): CredentialHealthAccessor | undefined {
  if (!stateDo?.getCredentialCooldown) return undefined;
  return stateDo;
}
