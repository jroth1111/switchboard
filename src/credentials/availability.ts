import type { Deployment, Policy } from "../config/schema";
import { isChatGPTSubscriptionAuthJsonText } from "../providers/chatgpt-responses";
import { resolveCredentialPool, type SubscriptionPoolContext } from "./resolve-pool";
import { resolveCredentialRotationSettings } from "./resolve-settings";
import type { CredentialHealthAccessor } from "./health";
import { isCredentialOnCooldown } from "./health";
import type { CredentialSlot } from "./types";

function envString(env: Record<string, unknown>, key: string): string {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

async function slotHasUsableMaterial(
  slot: CredentialSlot,
  env: Record<string, unknown>,
  subscriptionCtx?: SubscriptionPoolContext,
): Promise<boolean> {
  if (slot.kind === "chatgpt_oauth") {
    if (slot.material && isChatGPTSubscriptionAuthJsonText(slot.material)) return true;
    const fromEnv = envString(env, slot.label);
    // Non-JSON env values still route so build-time validation can return a clear error.
    if (fromEnv.length > 0) return true;
    if (!slot.material.trim() && subscriptionCtx?.chatgptOAuth) {
      const fromDo = await subscriptionCtx.chatgptOAuth.getAuthMaterial(slot.label);
      if (fromDo && isChatGPTSubscriptionAuthJsonText(fromDo)) return true;
    }
    return false;
  }
  if (slot.kind === "api_key") {
    return slot.secret.length > 0;
  }
  if (slot.kind === "anthropic_oauth") {
    if (envString(env, slot.accountId).length > 0) return true;
    const accessor = subscriptionCtx?.anthropicOAuth?.accessor;
    if (accessor) {
      const stored = await accessor.getToken(slot.accountId);
      if (stored?.accessToken?.trim()) return true;
    }
    return false;
  }
  return true;
}

async function poolHasAvailableCredential(
  deployment: Deployment,
  pool: Awaited<ReturnType<typeof resolveCredentialPool>>,
  health: CredentialHealthAccessor | undefined,
  now: number,
  env: Record<string, unknown>,
  subscriptionCtx?: SubscriptionPoolContext,
): Promise<boolean> {
  if (pool.length === 0) {
    if (deployment.provider === "chatgpt" && envString(env, "CHATGPT_OAUTH").length > 0) return true;
    return false;
  }
  for (const candidate of pool) {
    if (!(await slotHasUsableMaterial(candidate, env, subscriptionCtx))) continue;
    if (!health?.getCredentialCooldown) return true;
    const cooldown = await health.getCredentialCooldown(candidate.credentialId, now);
    if (!isCredentialOnCooldown(cooldown, now) && !cooldown?.requiresRelogin) {
      return true;
    }
  }
  if (deployment.provider === "chatgpt" && envString(env, "CHATGPT_OAUTH").length > 0) {
    return true;
  }
  return false;
}

/** Returns true when at least one credential slot can be used (material + cooldown-aware). */
export async function hasAvailableCredential(
  deployment: Deployment,
  env: Record<string, unknown>,
  policy: Policy,
  requestId: string,
  health: CredentialHealthAccessor | undefined,
  subscriptionCtx?: SubscriptionPoolContext,
  now: number = Date.now(),
): Promise<boolean> {
  const pool = await resolveCredentialPool(deployment, env, requestId, subscriptionCtx);
  if (deployment.credentialOptional) {
    if (pool.length === 0) return true;
    let anyMaterial = false;
    for (const slot of pool) {
      if (await slotHasUsableMaterial(slot, env, subscriptionCtx)) {
        anyMaterial = true;
        break;
      }
    }
    if (!anyMaterial) return true;
    // Pooled keys on cooldown still admit: route may run keyless when credentialOptional.
    return true;
  }
  return poolHasAvailableCredential(deployment, pool, health, now, env, subscriptionCtx);
}
