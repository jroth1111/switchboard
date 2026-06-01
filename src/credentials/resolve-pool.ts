import type { Deployment, ProviderType } from "../config/schema";
import { sha256Hex } from "../security/digest";
import type { OAuthAccountAccessor } from "../providers/anthropic-subscription";
import type { ChatGPTOAuthAccessor } from "../providers/chatgpt-subscription-storage";
import { anthropicOAuthAccountCandidates } from "../providers/oauth-account-pool";
import { parseChatGPTAuthAccountsList } from "../providers/chatgpt-auth-pool";
import { isChatGPTSubscriptionAuthJsonText } from "../providers/chatgpt-responses";
import { parseOAuthAccountList } from "../providers/oauth-account-pool";
import {
  discoverNimKeyRefs,
  discoverProviderApiKeyRefs,
  inferApiKeyProviderId,
  resolveApiKeySecret,
} from "./discover-api-keys";
import type {
  AnthropicOAuthCredentialSlot,
  ApiKeyCredentialSlot,
  ChatGPTOAuthCredentialSlot,
  CredentialSlot,
} from "./types";

export { discoverNimKeyRefs } from "./discover-api-keys";

export interface SubscriptionPoolContext {
  anthropicOAuth?: {
    accessor?: OAuthAccountAccessor;
    clientId?: string;
    clientSecret?: string;
    tokenUrl?: string;
    accountIds?: string[];
  };
  chatgptOAuth?: ChatGPTOAuthAccessor;
}

function envString(env: Record<string, unknown>, key: string): string {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

function deploymentCredentialPool(deployment: Deployment): string[] {
  return [
    ...(deployment.credentialPool ?? []),
    ...(deployment.accountIds ?? []),
  ];
}

function resolveApiKeyPool(
  deployment: Deployment,
  env: Record<string, unknown>,
  _requestId: string | undefined,
): ApiKeyCredentialSlot[] {
  const poolRefs = new Set<string>();
  const primary = deployment.keyRef.trim();
  if (primary) poolRefs.add(primary);
  for (const ref of deploymentCredentialPool(deployment)) {
    if (ref.trim()) poolRefs.add(ref.trim());
  }

  const providerId = inferApiKeyProviderId(deployment);
  // Free-route providers rotate across all numbered keys; NIM uses deployment keyRef + credentialPool only.
  if (providerId && providerId !== "nim") {
    for (const ref of discoverProviderApiKeyRefs(env, providerId)) {
      poolRefs.add(ref);
    }
  }

  const refs = [...poolRefs];
  const orderedRefs = primary && refs.includes(primary)
    ? [primary, ...refs.filter((r) => r !== primary).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))]
    : refs.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  const slots: ApiKeyCredentialSlot[] = [];
  for (const keyRef of orderedRefs) {
    const secret = providerId
      ? resolveApiKeySecret(env, keyRef, providerId)
      : envString(env, keyRef);
    if (!secret) continue;
    slots.push({
      kind: "api_key",
      credentialId: keyRef,
      keyRef,
      secret,
    });
  }
  return slots;
}

function resolveAnthropicPool(
  deployment: Deployment,
  env: Record<string, unknown>,
  _requestId: string | undefined,
  subscriptionCtx?: SubscriptionPoolContext,
): AnthropicOAuthCredentialSlot[] {
  const primary = envString(env, deployment.keyRef) || envString(env, "ANTHROPIC_OAUTH_ACCOUNT");
  const extra = [
    ...deploymentCredentialPool(deployment),
    ...(subscriptionCtx?.anthropicOAuth?.accountIds ?? []),
    ...parseOAuthAccountList((env as { ANTHROPIC_OAUTH_ACCOUNTS?: string }).ANTHROPIC_OAUTH_ACCOUNTS),
  ];
  // Stable pool order; spread/sequential selection happens in pickNextCredential + persisted order.
  const accountIds = anthropicOAuthAccountCandidates(primary, deployment.id, extra, undefined);
  return accountIds.map((accountId) => ({
    kind: "anthropic_oauth" as const,
    credentialId: accountId,
    accountId,
  }));
}

async function resolveChatGPTPool(
  deployment: Deployment,
  env: Record<string, unknown>,
): Promise<ChatGPTOAuthCredentialSlot[]> {
  const slots: ChatGPTOAuthCredentialSlot[] = [];
  const seenLabels = new Set<string>();
  const seenMaterial = new Set<string>();

  const pushSlot = (label: string, material: string) => {
    const trimmedLabel = label.trim();
    if (!trimmedLabel || seenLabels.has(trimmedLabel)) return;
    if (material) {
      if (!isChatGPTSubscriptionAuthJsonText(material) || seenMaterial.has(material)) return;
      seenMaterial.add(material);
    }
    seenLabels.add(trimmedLabel);
    slots.push({
      kind: "chatgpt_oauth",
      credentialId: trimmedLabel,
      label: trimmedLabel,
      material,
    });
  };

  const labelCandidates = new Set<string>([
    "CHATGPT_AUTH_JSON",
    "CHATGPT_AUTH_FILE",
    ...deploymentCredentialPool(deployment),
  ]);
  const keyRef = deployment.keyRef?.trim();
  if (keyRef) labelCandidates.add(keyRef);

  for (const label of ["CHATGPT_AUTH_JSON", "CHATGPT_AUTH_FILE"]) {
    pushSlot(label, envString(env, label));
  }
  for (const key of deploymentCredentialPool(deployment)) {
    pushSlot(key, envString(env, key));
  }
  for (const entry of parseChatGPTAuthAccountsList(
    (env as { CHATGPT_AUTH_ACCOUNTS?: string }).CHATGPT_AUTH_ACCOUNTS,
  )) {
    if (entry.startsWith("{")) {
      const digest = (await sha256Hex(entry)).slice(0, 16);
      pushSlot(`CHATGPT_AUTH_ACCOUNTS:${digest}`, entry);
    } else {
      pushSlot(entry, envString(env, entry));
    }
  }

  // Label-only slots: auth may live in OAuthAccountDO after lazy seed (env optional at runtime).
  for (const label of labelCandidates) {
    if (!seenLabels.has(label)) pushSlot(label, "");
  }

  return slots;
}

export async function resolveCredentialPool(
  deployment: Deployment,
  env: Record<string, unknown>,
  requestId: string | undefined,
  subscriptionCtx?: SubscriptionPoolContext,
): Promise<CredentialSlot[]> {
  const provider = deployment.provider as ProviderType;
  switch (provider) {
    case "nvidia_nim":
    case "openai":
      return resolveApiKeyPool(deployment, env, requestId);
    case "anthropic_subscription":
      return resolveAnthropicPool(deployment, env, requestId, subscriptionCtx);
    case "chatgpt":
      return await resolveChatGPTPool(deployment, env);
    default:
      return [];
  }
}

export type { OAuthAccountAccessor };
