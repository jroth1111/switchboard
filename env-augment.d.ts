// Augment the generated Env with secrets.
// Secrets are provisioned via `wrangler secret put` and are not in the config.

interface Env {
  PROXY_API_KEY: string;
  ADMIN_API_KEY: string;
  NIM_HEALTH_TOKEN: string;
  LITELLM_MASTER_KEY: string;
  METADATA_SIGNING_KEY: string;
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
  CHATGPT_OAUTH: string;
  ANTHROPIC_CLIENT_ID: string;
  ANTHROPIC_CLIENT_SECRET: string;
}
