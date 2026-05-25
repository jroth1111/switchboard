#!/usr/bin/env node
/**
 * Offline probe of public model list endpoints; emits JSON suggestions for manifest aliases.
 * Does not call the Worker runtime. Usage: npx tsx scripts/sync-free-models.ts
 */
import { writeFileSync } from "node:fs";

interface ModelHit {
  provider: string;
  modelId: string;
  freeSignal: string;
}

const ENDPOINTS: Array<{ provider: string; url: string; freeSignal: string }> = [
  { provider: "openrouter", url: "https://openrouter.ai/api/v1/models", freeSignal: "pricing.prompt==0" },
  { provider: "groq", url: "https://api.groq.com/openai/v1/models", freeSignal: "public_list" },
];

async function probe(endpoint: typeof ENDPOINTS[0]): Promise<ModelHit[]> {
  const hits: ModelHit[] = [];
  try {
    const res = await fetch(endpoint.url, { signal: AbortSignal.timeout(15000) });
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

async function main() {
  const all: ModelHit[] = [];
  for (const ep of ENDPOINTS) {
    all.push(...await probe(ep));
  }
  const outPath = "config/sync-free-models-suggestions.json";
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), models: all }, null, 2));
  console.log(`Wrote ${all.length} suggestions to ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
