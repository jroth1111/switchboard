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
  ZAI_KEY_2?: string;
  /** Canonical numbered API keys (Wrangler secrets / CI). */
  OPENROUTER_API_KEY_1?: string;
  OPENROUTER_API_KEY_2?: string;
  GROQ_API_KEY_1?: string;
  GROQ_API_KEY_2?: string;
  KILO_API_KEY_1?: string;
  KILO_API_KEY_2?: string;
  OPENCODE_API_KEY_1?: string;
  OPENCODE_API_KEY_2?: string;
  /** Local-only bootstrap: comma-separated keys expanded to per-slot credentials at resolve time. */
  OPENROUTER_API_KEYS?: string;
  GROQ_API_KEYS?: string;
  KILO_API_KEYS?: string;
  OPENCODE_API_KEYS?: string;
  CHATGPT_AUTH_JSON?: string;
  CHATGPT_AUTH_FILE?: string;
  ANTHROPIC_OAUTH_ACCOUNT?: string;
  ANTHROPIC_CLIENT_ID?: string;
  ANTHROPIC_CLIENT_SECRET?: string;
  ANTHROPIC_OAUTH_TOKEN_URL?: string;
  PROVIDER_API_BASE_ALL?: string;
  SMART_ROUTE_SHADOW_LOG?: string;
  SWITCHBOARD_QUERY_CAPTURE_ENABLED?: string;
  SWITCHBOARD_QUERY_CAPTURE_TIER?: string;
  SWITCHBOARD_QUERY_CAPTURE_MAX_EVENTS?: string;
  SWITCHBOARD_QUERY_CAPTURE_RAW_ENABLED?: string;
  SWITCHBOARD_QUERY_CAPTURE_RAW_KEY?: string;
  QUERY_CAPTURE_ENABLED?: string;
  QUERY_CAPTURE_TIER?: string;
  QUERY_CAPTURE_MAX_EVENTS?: string;
  [key: `PROVIDER_API_BASE_${string}`]: string | undefined;
}
