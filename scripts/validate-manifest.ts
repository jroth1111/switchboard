// Build-time manifest validator.
// Runs as part of the build pipeline to catch config errors early.
// Usage: node scripts/validate-manifest.ts

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";
import { MANIFEST, ROUTE_MANIFEST_VERSION } from "../src/config/manifest.ts";
import { ROUTING_ONLY_ROUTE_GROUPS, validateManifest } from "../src/config/validate-manifest.ts";
import { buildManifestSnapshot, canonicalJson } from "./manifest-snapshot.ts";
import { loadLocalSecretEnv, validateChatGPTStructuredAuthSurface } from "./chatgpt-auth-secrets.ts";

interface ValidationError {
  severity: "error" | "warning";
  message: string;
}

const errors: ValidationError[] = [];
const requiredScheduledCrons = ["*/2 * * * *", "*/5 * * * *", "0 * * * *"];
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const litellmConfigPath = join(repoRoot, ".litellm", "config.yaml");
const approvedMissingLiteLLMAliases: Record<string, string> = {};

function error(msg: string) {
  errors.push({ severity: "error", message: msg });
}

function warn(msg: string) {
  errors.push({ severity: "warning", message: msg });
}

// Core manifest checks (aliases, fallbacks, cycles, deployments, policies, planner refs).
for (const issue of validateManifest(MANIFEST)) {
  const message = issue.detail ? `${issue.message} — ${issue.detail}` : issue.message;
  if (issue.kind === "error") error(`[${issue.code}] ${message}`);
  else warn(`[${issue.code}] ${message}`);
}

// Visible alias targets have deployments (unless known routing-only groups)
const routingOnlyGroups = ROUTING_ONLY_ROUTE_GROUPS;
for (const [alias, target] of Object.entries(MANIFEST.aliases)) {
  const rg = MANIFEST.routeGroups[target];
  if (!rg || rg.hidden) continue;
  if (routingOnlyGroups.has(target)) continue;
  const deployments = MANIFEST.deploymentsByGroup[target];
  if (!deployments || deployments.length === 0) {
    warn(`Alias '${alias}' -> '${target}' has no deployments`);
  }
}

// Default policy has all required fields
const dp = MANIFEST.defaultPolicy;
if (dp) {
  if (!dp.retry.retryableFailureClasses) error("Default policy missing retryableFailureClasses");
  if (dp.health.circuitFailureThreshold <= 0) error("Default policy circuitFailureThreshold must be > 0");
  if (dp.deadline.totalTimeoutSeconds <= 0) error("Default policy totalTimeoutSeconds must be > 0");
}

// NIM paths have terminal fallbacks
const nimGroups = Object.keys(MANIFEST.routeGroups).filter((g) => g.startsWith("nim-"));
for (const nimGroup of nimGroups) {
  const rg = MANIFEST.routeGroups[nimGroup];
  if (!rg.hidden && rg.fallbacks.length === 0) {
    warn(`NIM group '${nimGroup}' has no fallbacks`);
  }
}

// Runtime configs include every scheduled maintenance task the worker handles
for (const configPath of ["wrangler.jsonc", "wrangler.dev.jsonc"]) {
  validateScheduledCrons(configPath, requiredScheduledCrons);
}

// Versioned manifest snapshot exists and matches the compiled manifest shape
validateManifestSnapshot("config/route-manifest.snapshot.json");

// LiteLLM alias parity: Switchboard must meet or supersede the local LiteLLM catalog.
validateLiteLLMAliasParity(litellmConfigPath);

// ChatGPT subscription lanes must prefer structured auth material.
validateChatGPTSubscriptionAuthRefs();
validateChatGPTSubscriptionRuntimeAuth();

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

function validateChatGPTSubscriptionRuntimeAuth(): void {
  const chatgptResponsesEnabled = MANIFEST.deployments
    .some((deployment) => deployment.provider === "chatgpt" && deployment.mode === "responses");
  if (!chatgptResponsesEnabled) return;

  const localSecrets = loadLocalSecretEnv();
  for (const loadError of localSecrets.loadErrors) {
    error(`Unable to inspect local secret surface for ChatGPT auth: ${loadError}`);
  }

  for (const issue of validateChatGPTStructuredAuthSurface(localSecrets.values, {
    localSecretSurfacePresent: localSecrets.localSecretSurfacePresent,
    chatgptResponsesEnabled,
  })) {
    if (issue.kind === "error") error(issue.message);
    else warn(issue.message);
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
