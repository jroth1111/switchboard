#!/usr/bin/env node
/**
 * Offline probe of public model list endpoints; emits JSON suggestions for manifest aliases.
 * Does not call the Worker runtime. Usage: pnpm sync-free-models
 */
import { writeFileSync } from "node:fs";
import { collectFreeModelSuggestions } from "../src/ops/sync-free-models";

async function main() {
  const all = await collectFreeModelSuggestions();
  const outPath = "config/sync-free-models-suggestions.json";
  writeFileSync(outPath, JSON.stringify({ generatedAt: new Date().toISOString(), models: all }, null, 2));
  console.log(`Wrote ${all.length} suggestions to ${outPath}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
