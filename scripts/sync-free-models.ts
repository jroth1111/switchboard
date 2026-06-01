#!/usr/bin/env node
/**
 * Offline probe of public model list endpoints; emits JSON + regenerates free-routes.generated.ts.
 * Usage: pnpm sync-free-models
 */
import { execSync } from "node:child_process";
import { unlinkSync, writeFileSync } from "node:fs";
import { MANIFEST } from "../src/config/manifest.ts";
import { buildFreeCatalogSuggestions, resolveFreeModelEndpoints } from "../src/ops/sync-free-models.ts";
import { collectNimFreeRouteGroups } from "../src/ops/collect-nim-free.ts";
import { loadLocalSecretEnv } from "./chatgpt-auth-secrets.ts";

async function main() {
  const localSecrets = loadLocalSecretEnv();
  const env = { ...localSecrets.values, ...process.env } as Record<string, unknown>;
  const nimRouteGroups = collectNimFreeRouteGroups(MANIFEST);
  const catalog = await buildFreeCatalogSuggestions(fetch, env, nimRouteGroups);
  const endpoints = resolveFreeModelEndpoints(env);

  const byProvider: Record<string, number> = {};
  for (const hit of catalog.models) {
    byProvider[hit.provider] = (byProvider[hit.provider] ?? 0) + 1;
  }

  const outPath = "config/sync-free-models-suggestions.json";
  const tmpPath = `${outPath}.tmp`;
  const payload = JSON.stringify({
    ...catalog,
    probed: endpoints.map((e) => ({
      provider: e.provider,
      url: e.url,
      freeSignal: e.freeSignal,
      authenticated: Boolean(e.authBearer),
    })),
    totals: { all: catalog.models.length, byProvider },
  }, null, 2);
  writeFileSync(tmpPath, payload);

  try {
    execSync("tsx scripts/generate-free-routes.ts", {
      stdio: "inherit",
      env: { ...process.env, SUGGESTIONS_PATH: tmpPath },
    });
    writeFileSync(outPath, payload);
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      // ignore missing tmp
    }
  }

  const parts = Object.entries(byProvider).map(([p, n]) => `${p}=${n}`).join(", ");
  console.log(`Wrote ${catalog.models.length} free models to ${outPath}${parts ? ` (${parts})` : ""}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
