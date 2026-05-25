// Augment generated Wrangler Env with intentionally configured secrets and
// runtime override names. `worker-configuration.d.ts` is generated with
// fixtures/wrangler-types.env so local-only `.dev.vars` keys do not drift into
// the committed Worker Env surface.

interface Env {
  CLIENT_KEYS_JSON?: string;
  CLIENT_USER_CLAIM_SECRET?: string;
  PROXY_API_KEY?: string;
  ADMIN_API_KEY: string;
  NIM_HEALTH_TOKEN?: string;
  METADATA_SIGNING_KEY?: string;
  ENCRYPTION_KEY: string;
  NIM_KEY_1: string;
  NIM_KEY_2: string;
  NIM_KEY_3: string;
  NIM_KEY_4: string;
  NIM_KEY_5: string;
  NIM_KEY_6: string;
  NIM_KEY_7: string;
  NIM_KEY_8: string;
  NIM_KEY_9: string;
  ZAI_KEY_1: string;
  CHATGPT_AUTH_JSON?: string;
  CHATGPT_AUTH_FILE?: string;
  ANTHROPIC_OAUTH_ACCOUNT?: string;
  ANTHROPIC_CLIENT_ID?: string;
  ANTHROPIC_CLIENT_SECRET?: string;
  ANTHROPIC_OAUTH_TOKEN_URL?: string;
  PROVIDER_API_BASE_ALL?: string;
  [key: `PROVIDER_API_BASE_${string}`]: string | undefined;
}
