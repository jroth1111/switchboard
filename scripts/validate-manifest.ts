// Build-time manifest validator.
// Runs as part of the build pipeline to catch config errors early.
// Usage: node scripts/validate-manifest.ts

import { readFileSync } from "node:fs";
import YAML from "yaml";
import { MANIFEST, ROUTE_MANIFEST_VERSION } from "../src/config/manifest.ts";
import { buildManifestSnapshot, canonicalJson } from "./manifest-snapshot.ts";

interface ValidationError {
  severity: "error" | "warning";
  message: string;
}

const errors: ValidationError[] = [];
const requiredScheduledCrons = ["*/2 * * * *", "*/5 * * * *", "0 * * * *"];
const litellmConfigPath = "../../.litellm/config.yaml";
const approvedMissingLiteLLMAliases: Record<string, string> = {};

function error(msg: string) {
  errors.push({ severity: "error", message: msg });
}

function warn(msg: string) {
  errors.push({ severity: "warning", message: msg });
}

// 1. All aliases resolve to valid route groups
for (const [alias, target] of Object.entries(MANIFEST.aliases)) {
  const rg = MANIFEST.routeGroups[target];
  if (!rg) {
    error(`Alias '${alias}' -> '${target}' has no route group`);
  }
}

// 2. All fallback groups exist
for (const [group, rg] of Object.entries(MANIFEST.routeGroups)) {
  for (const fb of rg.fallbacks) {
    if (!MANIFEST.routeGroups[fb]) {
      error(`Group '${group}' references fallback '${fb}' which doesn't exist`);
    }
  }
}

// 3. Fallback graph is acyclic
function detectCycles(): string[] {
  const cycles: string[] = [];
  const visited = new Set<string>();
  const stack = new Set<string>();

  function dfs(group: string, path: string[]): boolean {
    if (stack.has(group)) {
      cycles.push(path.concat(group).join(" -> "));
      return true;
    }
    if (visited.has(group)) return false;

    visited.add(group);
    stack.add(group);
    const rg = MANIFEST.routeGroups[group];
    if (rg) {
      for (const fb of rg.fallbacks) {
        dfs(fb, path.concat(group));
      }
    }
    stack.delete(group);
    return false;
  }

  for (const group of Object.keys(MANIFEST.routeGroups)) {
    dfs(group, []);
  }
  return cycles;
}

const cycles = detectCycles();
for (const cycle of cycles) {
  warn(`Fallback cycle detected: ${cycle}`);
}

// 4. All deployments reference existing groups
for (const d of MANIFEST.deployments) {
  if (!MANIFEST.routeGroups[d.group]) {
    error(`Deployment '${d.id}' references group '${d.group}' which doesn't exist`);
  }
}

// 5. Visible alias targets have deployments (unless known routing-only groups)
const routingOnlyGroups = new Set(["nim-secondary"]);
for (const [alias, target] of Object.entries(MANIFEST.aliases)) {
  const rg = MANIFEST.routeGroups[target];
  if (!rg || rg.hidden) continue;
  if (routingOnlyGroups.has(target)) continue;
  const deployments = MANIFEST.deploymentsByGroup[target];
  if (!deployments || deployments.length === 0) {
    warn(`Alias '${alias}' -> '${target}' has no deployments`);
  }
}

// 6. Policies exist for all groups
for (const group of Object.keys(MANIFEST.routeGroups)) {
  const policy = MANIFEST.policies[group] ?? MANIFEST.defaultPolicy;
  if (!policy) {
    error(`No policy for group '${group}' and no default policy`);
  }
}

// 7. Default policy has all required fields
const dp = MANIFEST.defaultPolicy;
if (dp) {
  if (!dp.retry.retryableFailureClasses) error("Default policy missing retryableFailureClasses");
  if (dp.health.circuitFailureThreshold <= 0) error("Default policy circuitFailureThreshold must be > 0");
  if (dp.deadline.totalTimeoutSeconds <= 0) error("Default policy totalTimeoutSeconds must be > 0");
}

// 8. NIM paths have terminal fallbacks
const nimGroups = Object.keys(MANIFEST.routeGroups).filter((g) => g.startsWith("nim-"));
for (const nimGroup of nimGroups) {
  const rg = MANIFEST.routeGroups[nimGroup];
  if (!rg.hidden && rg.fallbacks.length === 0) {
    warn(`NIM group '${nimGroup}' has no fallbacks`);
  }
}

// 9. Runtime configs include every scheduled maintenance task the worker handles
for (const configPath of ["wrangler.jsonc", "wrangler.dev.jsonc"]) {
  validateScheduledCrons(configPath, requiredScheduledCrons);
}

// 10. Versioned manifest snapshot exists and matches the compiled manifest shape
validateManifestSnapshot("config/route-manifest.snapshot.json");

// 11. LiteLLM alias parity: Switchboard must meet or supersede the local LiteLLM catalog.
validateLiteLLMAliasParity(litellmConfigPath);

// 12. ChatGPT subscription lanes must prefer structured auth material.
validateChatGPTSubscriptionAuthRefs();

function validateScheduledCrons(configPath: string, requiredCrons: string[]): void {
  let config: Record<string, unknown>;
  try {
    config = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    error(`Unable to parse ${configPath}: ${(err as Error).message}`);
    return;
  }

  const triggers = config.triggers as Record<string, unknown> | undefined;
  const crons = triggers?.crons;
  if (!Array.isArray(crons)) {
    error(`${configPath} missing triggers.crons`);
    return;
  }

  for (const cron of requiredCrons) {
    if (!crons.includes(cron)) {
      error(`${configPath} missing scheduled cron '${cron}'`);
    }
  }
}

function validateManifestSnapshot(snapshotPath: string): void {
  let snapshot: Record<string, unknown>;
  try {
    snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
  } catch (err) {
    error(`Unable to parse ${snapshotPath}: ${(err as Error).message}`);
    return;
  }
  if (snapshot.version !== ROUTE_MANIFEST_VERSION) {
    error(`${snapshotPath} version ${String(snapshot.version)} does not match ${ROUTE_MANIFEST_VERSION}`);
  }
  if (Object.keys((snapshot.aliases as Record<string, unknown> | undefined) ?? {}).length !== Object.keys(MANIFEST.aliases).length) {
    error(`${snapshotPath} alias count does not match compiled manifest`);
  }
  if (Object.keys((snapshot.routeGroups as Record<string, unknown> | undefined) ?? {}).length !== Object.keys(MANIFEST.routeGroups).length) {
    error(`${snapshotPath} route group count does not match compiled manifest`);
  }
  if (((snapshot.deployments as unknown[] | undefined) ?? []).length !== MANIFEST.deployments.length) {
    error(`${snapshotPath} deployment count does not match compiled manifest`);
  }
  const expected = buildManifestSnapshot();
  if (canonicalJson(snapshot) !== canonicalJson(expected)) {
    error(`${snapshotPath} content does not match compiled manifest; run npm run snapshot`);
  }
}

function validateLiteLLMAliasParity(configPath: string): void {
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(configPath, "utf8"));
  } catch (err) {
    error(`Unable to parse LiteLLM config ${configPath}: ${(err as Error).message}`);
    return;
  }

  const aliases = ((parsed as { nim_policy_plane?: { aliases?: unknown } })?.nim_policy_plane?.aliases);
  if (!aliases || typeof aliases !== "object" || Array.isArray(aliases)) {
    error(`${configPath} missing nim_policy_plane.aliases`);
    return;
  }

  const litellmAliases = aliases as Record<string, unknown>;
  const missing = Object.entries(litellmAliases)
    .filter(([alias]) => !(alias in MANIFEST.aliases) && !(alias in approvedMissingLiteLLMAliases))
    .map(([alias, target]) => `${alias} -> ${String(target)}`);
  if (missing.length > 0) {
    error(`LiteLLM alias parity missing ${missing.length} unapproved aliases: ${missing.join(", ")}`);
  }

  const staleApprovals = Object.keys(approvedMissingLiteLLMAliases)
    .filter((alias) => alias in MANIFEST.aliases);
  if (staleApprovals.length > 0) {
    error(`LiteLLM alias parity approval is stale for aliases now present in Switchboard: ${staleApprovals.join(", ")}`);
  }

  const mismatched = Object.entries(litellmAliases)
    .filter(([alias, target]) => alias in MANIFEST.aliases && MANIFEST.aliases[alias] !== target)
    .map(([alias, target]) => `${alias}: switchboard=${MANIFEST.aliases[alias]} litellm=${String(target)}`);
  if (mismatched.length > 0) {
    error(`LiteLLM alias parity has ${mismatched.length} mismatched targets: ${mismatched.join(", ")}`);
  }
}

function validateChatGPTSubscriptionAuthRefs(): void {
  const legacyRefs = MANIFEST.deployments
    .filter((deployment) => deployment.provider === "chatgpt" && deployment.mode === "responses")
    .filter((deployment) => deployment.keyRef !== "CHATGPT_AUTH_JSON")
    .map((deployment) => `${deployment.id}:${deployment.keyRef}`);

  if (legacyRefs.length > 0) {
    error(
      "ChatGPT Responses subscription deployments must use CHATGPT_AUTH_JSON as their primary auth ref; "
      + `legacy refs: ${legacyRefs.join(", ")}`,
    );
  }
}

// Report
console.log("=== Manifest Validation ===\n");

const errorCount = errors.filter((e) => e.severity === "error").length;
const warnCount = errors.filter((e) => e.severity === "warning").length;

for (const e of errors) {
  const prefix = e.severity === "error" ? "ERROR" : "WARN";
  console.log(`[${prefix}] ${e.message}`);
}

console.log(`\n${Object.keys(MANIFEST.aliases).length} aliases, ${Object.keys(MANIFEST.routeGroups).length} groups, ${MANIFEST.deployments.length} deployments`);
console.log(`${errorCount} errors, ${warnCount} warnings`);

if (errorCount > 0) {
  console.log("\nValidation FAILED");
  process.exit(1);
} else {
  console.log("\nValidation PASSED");
}
