import { createHash } from "node:crypto";
import type { BillingClass, FreeTier } from "../config/schema";
import { resolveApiKeySecret } from "../credentials/discover-api-keys";
import { resolveFreeProviderAvailability } from "./free-provider-availability";
import { MAX_KEYLESS_PROBES_PER_PROVIDER, probeKeylessInference } from "./probe-keyless-inference";

export interface ModelHit {
  provider: string;
  modelId: string;
  freeSignal: string;
  billingClass: BillingClass;
  freeTier: FreeTier;
  /** true/false when probed; undefined means not probed (treat as possibly keyless). */
  keylessEligible?: boolean;
}

export interface FreeModelEndpoint {
  provider: string;
  url: string;
  freeSignal: string;
  authBearer?: string;
  chatCompletionsUrl?: string;
}

export interface FreeCatalogSuggestions {
  generatedAt: string;
  fingerprint: string;
  providersEnabled: {
    openrouter: boolean;
    groq: boolean;
    nim: boolean;
    kilo: boolean;
    opencodeZen: boolean;
  };
  nimRouteGroups: string[];
  models: ModelHit[];
}

const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";
const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const GROQ_MODELS_URL = "https://api.groq.com/openai/v1/models";
const KILO_MODELS_URL = "https://api.kilo.ai/api/gateway/models";
const KILO_CHAT_URL = "https://api.kilo.ai/api/gateway/chat/completions";
const OPENCODE_ZEN_MODELS_URL = "https://opencode.ai/zen/v1/models";
const OPENCODE_ZEN_CHAT_URL = "https://opencode.ai/zen/v1/chat/completions";

/** Default probes when no env is passed; Groq is added only by resolveFreeModelEndpoints when a key exists. */
export const FREE_MODEL_ENDPOINTS: FreeModelEndpoint[] = [
  { provider: "openrouter", url: OPENROUTER_MODELS_URL, freeSignal: "pricing.prompt==0" },
  { provider: "kilo", url: KILO_MODELS_URL, freeSignal: "kilo_gateway", chatCompletionsUrl: KILO_CHAT_URL },
  { provider: "opencode_zen", url: OPENCODE_ZEN_MODELS_URL, freeSignal: "opencode_zen", chatCompletionsUrl: OPENCODE_ZEN_CHAT_URL },
];

/** v1 stubs — not probed until xAI/Grok integration lands. */
export const FUTURE_FREE_PROVIDER_STUBS: ReadonlyArray<{ provider: string; freeTier: FreeTier; note: string }> = [
  { provider: "grok", freeTier: "future", note: "xAI API — not wired in v1" },
];

function readEnvString(env: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = env?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isZeroPrice(value: unknown): boolean {
  if (value === 0) return true;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return false;
    const n = Number(trimmed);
    return Number.isFinite(n) && n === 0;
  }
  return false;
}

function isOpenRouterFreeModel(item: Record<string, unknown>): boolean {
  const pricing = item.pricing;
  if (!pricing || typeof pricing !== "object") return false;
  const p = pricing as Record<string, unknown>;
  return isZeroPrice(p.prompt) && isZeroPrice(p.completion);
}

function isKiloFreeCandidate(item: Record<string, unknown>, id: string): boolean {
  if (item.isFree === true) return true;
  if (id === "kilo-auto/free") return true;
  if (id.endsWith(":free")) return true;
  const pricing = item.pricing;
  if (pricing && typeof pricing === "object") {
    const p = pricing as Record<string, unknown>;
    if (isZeroPrice(p.prompt) && isZeroPrice(p.completion)) return true;
  }
  return false;
}

function isOpencodeZenFreeCandidate(id: string): boolean {
  const lower = id.toLowerCase();
  return lower.endsWith("-free") || lower.endsWith(":free") || /\/free$/.test(lower);
}

/** Exclude non-chat SKUs from OpenRouter/Kilo free codegen (audio, etc.). */
export function isChatCompletionsFreeCatalogCandidate(id: string): boolean {
  const lower = id.toLowerCase();
  if (lower.includes("lyria")) return false;
  if (lower.includes("whisper") || lower.includes("tts") || lower.includes("orpheus")) return false;
  if (lower.includes("imagen") || lower.includes("dall-e")) return false;
  return true;
}

/** Groq /models lists paid SKUs; limit free-route codegen to chat LLM families. */
function isGroqFreeTierCandidate(id: string): boolean {
  const lower = id.toLowerCase();
  if (lower.includes("whisper") || lower.includes("orpheus") || lower.includes("canopy")) return false;
  if (lower.includes("prompt-guard") || lower.includes("safeguard")) return false;
  return lower.startsWith("llama-")
    || lower.startsWith("gemma")
    || lower.startsWith("mixtral")
    || lower.startsWith("openai/")
    || lower.startsWith("qwen/")
    || lower.startsWith("meta-llama/");
}

function groqPricingIsZero(value: unknown): boolean {
  if (value === 0 || value === "0") return true;
  const n = Number(value);
  return Number.isFinite(n) && n === 0;
}

/** When Groq exposes pricing, require zero cost; omit pricing only for prefix-filtered chat ids. */
function isGroqFreeCatalogItem(item: Record<string, unknown>, id: string): boolean {
  if (!isGroqFreeTierCandidate(id)) return false;
  const pricing = item.pricing;
  if (!pricing || typeof pricing !== "object") return true;
  const p = pricing as Record<string, unknown>;
  const prompt = p.prompt ?? p.input;
  const completion = p.completion ?? p.output;
  if (prompt !== undefined && completion !== undefined) {
    return groqPricingIsZero(prompt) && groqPricingIsZero(completion);
  }
  if (prompt !== undefined) return groqPricingIsZero(prompt);
  if (completion !== undefined) return groqPricingIsZero(completion);
  return true;
}

export function resolveFreeModelEndpoints(env?: Record<string, unknown>): FreeModelEndpoint[] {
  const endpoints: FreeModelEndpoint[] = [
    { provider: "openrouter", url: OPENROUTER_MODELS_URL, freeSignal: "pricing.prompt==0" },
    { provider: "kilo", url: KILO_MODELS_URL, freeSignal: "kilo_gateway", chatCompletionsUrl: KILO_CHAT_URL },
    { provider: "opencode_zen", url: OPENCODE_ZEN_MODELS_URL, freeSignal: "opencode_zen", chatCompletionsUrl: OPENCODE_ZEN_CHAT_URL },
  ];
  const groqKey = env
    ? resolveApiKeySecret(env, "GROQ_API_KEY_1", "groq")
    : "";
  if (groqKey) {
    endpoints.push({
      provider: "groq",
      url: GROQ_MODELS_URL,
      freeSignal: "groq_free_tier",
      authBearer: groqKey,
      chatCompletionsUrl: "https://api.groq.com/openai/v1/chat/completions",
    });
  }
  return endpoints;
}

function freeTierForProvider(provider: string): FreeTier {
  switch (provider) {
    case "openrouter": return "catalog_zero";
    case "groq": return "rate_limited";
    case "kilo": return "kilo_gateway";
    case "opencode_zen": return "opencode_zen";
    default: return "future";
  }
}

function extractCatalogHits(endpoint: FreeModelEndpoint, data: { data?: unknown }): ModelHit[] {
  const hits: ModelHit[] = [];
  const rows = data.data;
  if (!Array.isArray(rows)) return hits;

  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const item = row as Record<string, unknown>;
    const id = typeof item.id === "string" ? item.id.trim() : "";
    if (!id) continue;

    if (endpoint.provider === "openrouter" && !isOpenRouterFreeModel(item)) continue;
    if (endpoint.provider === "kilo" && !isKiloFreeCandidate(item, id)) continue;
    if (
      (endpoint.provider === "openrouter" || endpoint.provider === "kilo")
      && !isChatCompletionsFreeCatalogCandidate(id)
    ) continue;
    if (endpoint.provider === "opencode_zen" && !isOpencodeZenFreeCandidate(id)) continue;
    if (endpoint.provider === "groq" && !isGroqFreeCatalogItem(item, id)) continue;

    hits.push({
      provider: endpoint.provider,
      modelId: id,
      freeSignal: endpoint.freeSignal,
      billingClass: "free",
      freeTier: freeTierForProvider(endpoint.provider),
    });
  }
  return hits;
}

export async function probeFreeModelEndpoint(
  endpoint: FreeModelEndpoint,
  fetchImpl: typeof fetch = fetch,
): Promise<ModelHit[]> {
  if (endpoint.provider === "groq" && !endpoint.authBearer) return [];

  const headers: Record<string, string> = { Accept: "application/json" };
  if (endpoint.authBearer) headers.Authorization = `Bearer ${endpoint.authBearer}`;

  try {
    const res = await fetchImpl(endpoint.url, {
      signal: AbortSignal.timeout(15000),
      headers,
    });
    if (!res.ok) return [];
    const data = await res.json() as { data?: unknown };
    return extractCatalogHits(endpoint, data);
  } catch {
    return [];
  }
}

async function probeKeylessForHits(
  hits: ModelHit[],
  fetchImpl: typeof fetch,
): Promise<void> {
  const byProvider = new Map<string, ModelHit[]>();
  for (const hit of hits) {
    if (hit.provider !== "kilo" && hit.provider !== "opencode_zen") continue;
    const list = byProvider.get(hit.provider) ?? [];
    list.push(hit);
    byProvider.set(hit.provider, list);
  }

  for (const [provider, list] of byProvider) {
    const url = provider === "kilo" ? KILO_CHAT_URL : OPENCODE_ZEN_CHAT_URL;
    const prioritized = [...list].sort((a, b) => {
      const score = (id: string) => (id.includes("kilo-auto/free") || id === "deepseek-v4-flash-free" ? 0 : 1);
      return score(a.modelId) - score(b.modelId);
    });
    let probed = 0;
    for (const hit of prioritized) {
      if (probed >= MAX_KEYLESS_PROBES_PER_PROVIDER) break;
      probed++;
      hit.keylessEligible = await probeKeylessInference(
        { provider, chatCompletionsUrl: url, modelId: hit.modelId },
        fetchImpl,
      );
    }
  }
}

export function computeFreeCatalogFingerprint(input: {
  models: ModelHit[];
  nimRouteGroups: string[];
  providersEnabled: FreeCatalogSuggestions["providersEnabled"];
}): string {
  const payload = {
    models: input.models.map((m) => ({
      p: m.provider,
      id: m.modelId,
      k: m.keylessEligible,
    })),
    nim: input.nimRouteGroups,
    pe: input.providersEnabled,
  };
  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}

export async function collectFreeModelSuggestions(
  fetchImpl: typeof fetch = fetch,
  env?: Record<string, unknown>,
): Promise<ModelHit[]> {
  const endpoints = env ? resolveFreeModelEndpoints(env) : FREE_MODEL_ENDPOINTS;
  const results = await Promise.allSettled(
    endpoints.map((ep) => probeFreeModelEndpoint(ep, fetchImpl)),
  );
  const seen = new Set<string>();
  const all: ModelHit[] = [];
  for (const r of results) {
    if (r.status !== "fulfilled") continue;
    for (const hit of r.value) {
      const key = `${hit.provider}:${hit.modelId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      all.push(hit);
    }
  }
  await probeKeylessForHits(all, fetchImpl);
  all.sort((a, b) => a.provider.localeCompare(b.provider) || a.modelId.localeCompare(b.modelId));
  return all;
}

export async function buildFreeCatalogSuggestions(
  fetchImpl: typeof fetch = fetch,
  env?: Record<string, unknown>,
  nimRouteGroups: string[] = [],
): Promise<FreeCatalogSuggestions> {
  const models = await collectFreeModelSuggestions(fetchImpl, env);
  const keylessKilo = models.filter((m) => m.provider === "kilo" && m.keylessEligible).map((m) => m.modelId);
  const keylessZen = models.filter((m) => m.provider === "opencode_zen" && m.keylessEligible).map((m) => m.modelId);
  const availability = resolveFreeProviderAvailability(env, {
    keylessKilo,
    keylessOpencodeZen: keylessZen,
  });
  availability.nim.routeGroups = nimRouteGroups;

  const providersEnabled = {
    openrouter: availability.openrouter.inference,
    groq: availability.groq.inference,
    nim: availability.nim.inference && nimRouteGroups.length > 0,
    kilo: availability.kilo.inference,
    opencodeZen: availability.opencodeZen.inference,
  };

  const fingerprint = computeFreeCatalogFingerprint({ models, nimRouteGroups, providersEnabled });

  return {
    generatedAt: new Date().toISOString(),
    fingerprint,
    providersEnabled,
    nimRouteGroups,
    models,
  };
}

export { OPENROUTER_CHAT_URL, KILO_CHAT_URL, OPENCODE_ZEN_CHAT_URL };
