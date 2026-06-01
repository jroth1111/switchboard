/**
 * Discover API-key env bindings: numbered vars (canonical) and optional
 * comma-separated bootstrap for local dev.
 */

export type ApiKeyProviderId = "nim" | "zai" | "openrouter" | "groq" | "kilo" | "opencode_zen";

export interface ApiKeyProviderConfig {
  numberedPrefix: string;
  primaryKeyRef: string;
  bootstrapPlural?: string;
}

export const API_KEY_PROVIDER_CONFIG: Record<ApiKeyProviderId, ApiKeyProviderConfig> = {
  nim: { numberedPrefix: "NIM_KEY", primaryKeyRef: "NIM_KEY_1" },
  zai: { numberedPrefix: "ZAI_KEY", primaryKeyRef: "ZAI_KEY_1" },
  openrouter: {
    numberedPrefix: "OPENROUTER_API_KEY",
    primaryKeyRef: "OPENROUTER_API_KEY_1",
    bootstrapPlural: "OPENROUTER_API_KEYS",
  },
  groq: {
    numberedPrefix: "GROQ_API_KEY",
    primaryKeyRef: "GROQ_API_KEY_1",
    bootstrapPlural: "GROQ_API_KEYS",
  },
  kilo: {
    numberedPrefix: "KILO_API_KEY",
    primaryKeyRef: "KILO_API_KEY_1",
    bootstrapPlural: "KILO_API_KEYS",
  },
  opencode_zen: {
    numberedPrefix: "OPENCODE_API_KEY",
    primaryKeyRef: "OPENCODE_API_KEY_1",
    bootstrapPlural: "OPENCODE_API_KEYS",
  },
};

const BOOTSTRAP_SUFFIX = /^(.+)__bootstrap_(\d+)$/;

function envString(env: Record<string, unknown>, key: string): string {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Numbered env keys matching `PREFIX_1`, `PREFIX_2`, … */
export function discoverNumberedKeyRefs(
  env: Record<string, unknown>,
  numberedPrefix: string,
): string[] {
  const pattern = new RegExp(`^${escapeRegExp(numberedPrefix)}_(\\d+)$`);
  const keys: string[] = [];
  for (const key of Object.keys(env)) {
    if (pattern.test(key) && envString(env, key)) {
      keys.push(key);
    }
  }
  keys.sort((a, b) => {
    const ma = pattern.exec(a);
    const mb = pattern.exec(b);
    const na = ma ? Number(ma[1]) : 0;
    const nb = mb ? Number(mb[1]) : 0;
    return na - nb;
  });
  return keys;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Split bootstrap CSV env into secret strings (deduped, order preserved). */
export function parseBootstrapSecrets(
  env: Record<string, unknown>,
  bootstrapPlural: string | undefined,
): string[] {
  if (!bootstrapPlural) return [];
  const raw = envString(env, bootstrapPlural);
  if (!raw) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const trimmed = part.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}

function bootstrapSecretForRef(
  env: Record<string, unknown>,
  keyRef: string,
  config: ApiKeyProviderConfig,
): string {
  const match = BOOTSTRAP_SUFFIX.exec(keyRef);
  if (!match || match[1] !== config.numberedPrefix) return "";
  const index = Number(match[2]);
  if (!Number.isFinite(index) || index < 1) return "";
  const secrets = parseBootstrapSecrets(env, config.bootstrapPlural);
  return secrets[index - 1] ?? "";
}

/** Resolve secret material for a keyRef (numbered env or bootstrap slot). */
export function resolveApiKeySecret(
  env: Record<string, unknown>,
  keyRef: string,
  providerId: ApiKeyProviderId,
): string {
  const direct = envString(env, keyRef);
  if (direct) return direct;

  const config = API_KEY_PROVIDER_CONFIG[providerId];
  return bootstrapSecretForRef(env, keyRef, config);
}

/** All keyRef identities with resolvable secrets for a provider. */
export function discoverProviderApiKeyRefs(
  env: Record<string, unknown>,
  providerId: ApiKeyProviderId,
): string[] {
  const config = API_KEY_PROVIDER_CONFIG[providerId];
  const refs: string[] = [];
  const seen = new Set<string>();

  const add = (ref: string) => {
    if (!ref || seen.has(ref)) return;
    if (!resolveApiKeySecret(env, ref, providerId)) return;
    seen.add(ref);
    refs.push(ref);
  };

  for (const ref of discoverNumberedKeyRefs(env, config.numberedPrefix)) {
    add(ref);
  }

  const bootstrapSecrets = parseBootstrapSecrets(env, config.bootstrapPlural);
  for (let i = 0; i < bootstrapSecrets.length; i++) {
    add(`${config.numberedPrefix}__bootstrap_${i + 1}`);
  }

  return refs;
}

export function hasProviderApiKeys(
  env: Record<string, unknown>,
  providerId: ApiKeyProviderId,
): boolean {
  return discoverProviderApiKeyRefs(env, providerId).length > 0;
}

export function primaryKeyRefForProvider(providerId: ApiKeyProviderId): string {
  return API_KEY_PROVIDER_CONFIG[providerId].primaryKeyRef;
}

const OPENROUTER_BASE = "https://openrouter.ai/api/v1";
const GROQ_BASE = "https://api.groq.com/openai/v1";
const KILO_BASE = "https://api.kilo.ai/api/gateway";
const OPENCODE_ZEN_BASE = "https://opencode.ai/zen/v1";

/** Infer API-key provider from deployment keyRef / apiBase (openai-compat free routes). */
export function inferApiKeyProviderId(deployment: {
  provider: string;
  keyRef: string;
  apiBase?: string;
}): ApiKeyProviderId | undefined {
  if (deployment.provider === "nvidia_nim") return "nim";
  const keyRef = deployment.keyRef.trim();
  if (/^ZAI_KEY_\d+$/.test(keyRef)) return "zai";
  if (/^NIM_KEY_\d+$/.test(keyRef)) return "nim";
  if (/^OPENROUTER_API_KEY/.test(keyRef)) return "openrouter";
  if (/^GROQ_API_KEY/.test(keyRef)) return "groq";
  if (/^KILO_API_KEY/.test(keyRef)) return "kilo";
  if (/^OPENCODE_API_KEY/.test(keyRef)) return "opencode_zen";

  const base = deployment.apiBase?.replace(/\/$/, "") ?? "";
  if (base === OPENROUTER_BASE || base.startsWith(OPENROUTER_BASE)) return "openrouter";
  if (base === GROQ_BASE || base.startsWith(GROQ_BASE)) return "groq";
  if (base === KILO_BASE || base.startsWith(KILO_BASE)) return "kilo";
  if (base === OPENCODE_ZEN_BASE || base.startsWith(OPENCODE_ZEN_BASE)) return "opencode_zen";

  return undefined;
}

export function discoverNimKeyRefs(env: Record<string, unknown>): string[] {
  return discoverProviderApiKeyRefs(env, "nim");
}
