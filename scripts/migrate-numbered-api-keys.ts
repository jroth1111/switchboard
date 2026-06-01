#!/usr/bin/env node
/**
 * Migrate singular free-provider API key env names to numbered canonical names.
 * - Rewrites ../switchboard-local/.dev.vars (or --path): OPENROUTER_API_KEY → OPENROUTER_API_KEY_1 (when _1 unset)
 * - Optional --import-from: copy singular/numbered keys from another .dev.vars if missing locally
 *
 * GitHub / Wrangler secrets cannot be read back; this script prints copy commands when --print-ops is set.
 */
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defaultDevVarsPath } from "./local-secrets-dir.ts";

const PROVIDERS = [
  { singular: "OPENROUTER_API_KEY", numbered: "OPENROUTER_API_KEY_1" },
  { singular: "GROQ_API_KEY", numbered: "GROQ_API_KEY_1" },
  { singular: "KILO_API_KEY", numbered: "KILO_API_KEY_1" },
  { singular: "OPENCODE_API_KEY", numbered: "OPENCODE_API_KEY_1" },
] as const;

type EnvMap = Map<string, string>;

function parseDevVars(content: string): EnvMap {
  const map: EnvMap = new Map();
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (
      (value.startsWith("'") && value.endsWith("'"))
      || (value.startsWith('"') && value.endsWith('"'))
    ) {
      value = value.slice(1, -1);
    }
    map.set(key, value);
  }
  return map;
}

function serializeDevVars(map: EnvMap, original: string): string {
  const used = new Set<string>();
  const out: string[] = [];
  for (const line of original.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      out.push(line);
      continue;
    }
    const eq = trimmed.indexOf("=");
    if (eq <= 0) {
      out.push(line);
      continue;
    }
    const key = trimmed.slice(0, eq).trim();
    if (!map.has(key)) {
      out.push(line);
      continue;
    }
    if (used.has(key)) continue;
    used.add(key);
    const value = map.get(key) ?? "";
    const needsQuote = /[\s#]/.test(value) || value.includes("=");
    out.push(needsQuote ? `${key}='${value.replace(/'/g, "'\\''")}'` : `${key}=${value}`);
  }
  for (const [key, value] of map) {
    if (used.has(key)) continue;
    const needsQuote = /[\s#]/.test(value) || value.includes("=");
    out.push(needsQuote ? `${key}='${value.replace(/'/g, "'\\''")}'` : `${key}=${value}`);
  }
  return out.join("\n").replace(/\n?$/, "\n");
}

function migrateMap(map: EnvMap, importFrom?: EnvMap): string[] {
  const changes: string[] = [];
  for (const { singular, numbered } of PROVIDERS) {
    const hasNumbered = Boolean(map.get(numbered)?.trim());
    const singularVal = map.get(singular)?.trim();
    const importNumbered = importFrom?.get(numbered)?.trim();
    const importSingular = importFrom?.get(singular)?.trim();

    if (!hasNumbered) {
      const source = singularVal || importNumbered || importSingular;
      if (source) {
        map.set(numbered, source);
        changes.push(`set ${numbered} (from ${singularVal ? singular : importNumbered ? numbered : singular} import)`);
      }
    }
    if (map.has(singular)) {
      const numberedVal = map.get(numbered)?.trim();
      const singularOnly = map.get(singular)?.trim();
      if (!numberedVal) {
        map.delete(singular);
        changes.push(`removed empty ${singular}`);
      } else if (!singularOnly || singularOnly === numberedVal) {
        map.delete(singular);
        changes.push(`removed ${singular} (same as ${numbered})`);
      }
    }
  }
  return changes;
}

function printOps(): void {
  console.log("\nProduction secret migration (values must come from your password manager / old secret store):\n");
  for (const { singular, numbered } of PROVIDERS) {
    console.log(`  wrangler secret put ${numbered}   # was ${singular}`);
    console.log(`  gh secret set ${numbered}          # retire ${singular} in GitHub repo settings when done`);
  }
  console.log("");
}

function main(): void {
  const args = new Set(process.argv.slice(2));
  const devVarsPath = resolve(
    args.has("--path") ? process.argv[process.argv.indexOf("--path") + 1]! : defaultDevVarsPath(),
  );
  const importPath = args.has("--import-from")
    ? resolve(process.argv[process.argv.indexOf("--import-from") + 1]!)
    : undefined;
  const dryRun = args.has("--dry-run");
  const printOpsOnly = args.has("--print-ops");

  if (printOpsOnly) {
    printOps();
    return;
  }

  if (!existsSync(devVarsPath)) {
    console.error(`Missing ${devVarsPath}; copy .dev.vars.example to ../switchboard-local/.dev.vars first.`);
    process.exit(1);
  }

  const original = readFileSync(devVarsPath, "utf8");
  const map = parseDevVars(original);
  const importMap = importPath && existsSync(importPath)
    ? parseDevVars(readFileSync(importPath, "utf8"))
    : undefined;

  const changes = migrateMap(map, importMap);
  if (changes.length === 0) {
    console.log(`No migration needed in ${devVarsPath}`);
    return;
  }

  console.log(`${dryRun ? "[dry-run] " : ""}Would apply in ${devVarsPath}:`);
  for (const c of changes) console.log(`  - ${c}`);

  if (dryRun) return;

  writeFileSync(devVarsPath, serializeDevVars(map, original), "utf8");
  try {
    chmodSync(devVarsPath, 0o600);
  } catch {
    // best-effort
  }
  console.log(`Updated ${devVarsPath} (mode 0600)`);
}

main();
