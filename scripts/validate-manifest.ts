// Build-time manifest validator.
// Runs as part of the build pipeline to catch config errors early.
// Usage: npx tsx scripts/validate-manifest.ts

import { readFileSync } from "node:fs";
import { MANIFEST } from "../src/config/manifest";

interface ValidationError {
  severity: "error" | "warning";
  message: string;
}

const errors: ValidationError[] = [];
const requiredScheduledCrons = ["*/2 * * * *", "*/5 * * * *", "0 * * * *"];

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
