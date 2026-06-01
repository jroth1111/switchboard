import type { OAuthAccountAccessor } from "./anthropic-subscription";
import { isChatGPTSubscriptionAuthJsonText } from "./chatgpt-responses";

export const CHATGPT_OAUTH_TOKEN_URL = "https://auth.openai.com/oauth/token";
export const CHATGPT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const CHATGPT_PROVIDER = "chatgpt_subscription";

function envString(env: Record<string, unknown>, key: string): string {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

export interface ChatGPTOAuthAccessor extends OAuthAccountAccessor {
  getAuthMaterial(accountId: string): Promise<string | null>;
}

type OAuthBinding = {
  idFromName(name: string): unknown;
  get(id: unknown): unknown;
};

export function buildChatGPTOAuthAccessor(env: Record<string, unknown>): ChatGPTOAuthAccessor {
  const oauthBinding = (env as { OAUTH_ACCOUNT?: OAuthBinding }).OAUTH_ACCOUNT;
  if (!oauthBinding) {
    throw new Error("OAUTH_ACCOUNT binding is required for ChatGPT subscription auth");
  }
  const stub = oauthBinding.get(
    oauthBinding.idFromName("chatgpt-subscription"),
  ) as unknown as OAuthAccountAccessor;

  return {
    ...stub,
    getAuthMaterial: (accountId) => getChatGPTAuthMaterial(stub, accountId, env),
    getToken: (accountId) => stub.getToken(accountId),
    setToken: (accountId, provider, accessToken, refreshToken, expiresAt) =>
      stub.setToken(accountId, provider, accessToken, refreshToken, expiresAt),
    acquireRefreshLock: (accountId, requestId, ttlMs) =>
      stub.acquireRefreshLock(accountId, requestId, ttlMs),
    releaseRefreshLock: (accountId, requestId) =>
      stub.releaseRefreshLock(accountId, requestId),
  };
}

export async function getChatGPTAuthMaterial(
  accessor: OAuthAccountAccessor,
  accountId: string,
  env: Record<string, unknown>,
): Promise<string | null> {
  const stored = await accessor.getToken(accountId);
  if (stored?.accessToken && isChatGPTSubscriptionAuthJsonText(stored.accessToken)) {
    return stored.accessToken;
  }

  const fromEnv = envString(env, accountId);
  if (fromEnv && isChatGPTSubscriptionAuthJsonText(fromEnv)) {
    await accessor.setToken(accountId, CHATGPT_PROVIDER, fromEnv);
    return fromEnv;
  }

  return null;
}

export async function refreshChatGPTSubscriptionAuthMaterial(
  authMaterial: string,
  options: {
    credentialName?: string;
    accessor?: OAuthAccountAccessor;
    accountId?: string;
    refreshTokenUrl?: string;
  } = {},
): Promise<string> {
  const credentialName = options.credentialName ?? "ChatGPT subscription auth";
  if (!isChatGPTSubscriptionAuthJsonText(authMaterial)) {
    throw new Error(`${credentialName} must be structured JSON`);
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(authMaterial) as Record<string, unknown>;
  } catch {
    throw new Error(`${credentialName} must be valid JSON`);
  }

  const refreshToken = typeof parsed.refresh_token === "string" ? parsed.refresh_token.trim() : "";
  if (!refreshToken) {
    throw new Error(`${credentialName} is missing refresh_token`);
  }

  const resp = await fetch(
    options.refreshTokenUrl || CHATGPT_OAUTH_TOKEN_URL,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: CHATGPT_OAUTH_CLIENT_ID,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
      signal: AbortSignal.timeout(10_000),
    },
  );

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`ChatGPT token refresh failed (${resp.status}): ${body.slice(0, 200)}`);
  }

  const data = await resp.json() as Record<string, unknown>;
  const accessToken = typeof data.access_token === "string" ? data.access_token.trim() : "";
  if (!accessToken) {
    throw new Error(`${credentialName} refresh returned no access_token`);
  }

  const next: Record<string, unknown> = {
    ...parsed,
    access_token: accessToken,
  };
  if (typeof data.refresh_token === "string" && data.refresh_token.trim()) {
    next.refresh_token = data.refresh_token.trim();
  }
  if (typeof data.id_token === "string" && data.id_token.trim()) {
    next.id_token = data.id_token.trim();
  }

  const refreshed = JSON.stringify(next);
  if (options.accessor && options.accountId) {
    await options.accessor.setToken(
      options.accountId,
      CHATGPT_PROVIDER,
      refreshed,
    );
  }
  return refreshed;
}
