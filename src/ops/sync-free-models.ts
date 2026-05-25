export interface ModelHit {
  provider: string;
  modelId: string;
  freeSignal: string;
}

export const FREE_MODEL_ENDPOINTS: Array<{ provider: string; url: string; freeSignal: string }> = [
  { provider: "openrouter", url: "https://openrouter.ai/api/v1/models", freeSignal: "pricing.prompt==0" },
  { provider: "groq", url: "https://api.groq.com/openai/v1/models", freeSignal: "public_list" },
];

export async function probeFreeModelEndpoint(
  endpoint: typeof FREE_MODEL_ENDPOINTS[0],
  fetchImpl: typeof fetch = fetch,
): Promise<ModelHit[]> {
  const hits: ModelHit[] = [];
  try {
    const res = await fetchImpl(endpoint.url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) return hits;
    const data = await res.json() as { data?: Array<{ id?: string }> };
    for (const item of data.data ?? []) {
      if (item.id) hits.push({ provider: endpoint.provider, modelId: item.id, freeSignal: endpoint.freeSignal });
    }
  } catch {
    // skip unreachable providers
  }
  return hits.slice(0, 50);
}

export async function collectFreeModelSuggestions(
  fetchImpl: typeof fetch = fetch,
): Promise<ModelHit[]> {
  const results = await Promise.allSettled(
    FREE_MODEL_ENDPOINTS.map((ep) => probeFreeModelEndpoint(ep, fetchImpl)),
  );
  const all: ModelHit[] = [];
  for (const r of results) {
    if (r.status === "fulfilled") all.push(...r.value);
  }
  return all;
}
