#!/usr/bin/env node
// Validate that local secret files are private without printing secret values.

import { existsSync, lstatSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import {
  discoverLocalSecretPaths,
  repoRootDevVarsPresent,
  REPO_SECRETS_MIGRATION_HINT,
} from "./local-secrets-dir.ts";
const OWNER_ONLY_MASK = 0o077;

interface CheckResult {
  path: string;
  status: "ok" | "skip" | "error";
  message: string;
}

const args = process.argv.slice(2);

if (args.includes("--help") || args.includes("-h")) {
  console.log(`Usage: node scripts/check-secret-permissions.ts [paths...]

Checks local secret files for owner-only permissions. Missing default files are
skipped so CI remains usable when local secrets are absent. Values are never
printed; detected env or JSON keys are shown as <redacted>.

Default paths: ../switchboard-local/ (or SWITCHBOARD_LOCAL_DIR) plus legacy repo-root secret files`);
  process.exit(0);
}

const explicitPaths = args.filter((arg) => !arg.startsWith("-"));
const paths = explicitPaths.length > 0 ? explicitPaths : discoverLocalSecretPaths();
const results = paths.map((path) => checkSecretPath(path, explicitPaths.length > 0));

if (explicitPaths.length === 0 && repoRootDevVarsPresent()) {
  console.warn(`WARN: ${REPO_SECRETS_MIGRATION_HINT}\n`);
}

console.log("=== Secret Permission Check ===\n");
for (const result of results) {
  const prefix = result.status === "ok" ? "OK" : result.status === "skip" ? "SKIP" : "ERROR";
  console.log(`[${prefix}] ${result.path}: ${result.message}`);
}

const present = results.filter((result) => result.status !== "skip").length;
const errors = results.filter((result) => result.status === "error").length;
const skipped = results.filter((result) => result.status === "skip").length;

console.log(`\n${present} present, ${skipped} skipped, ${errors} errors`);
if (errors > 0) {
  console.log("\nSecret permission check FAILED");
  process.exit(1);
}

console.log("\nSecret permission check PASSED");

function checkSecretPath(path: string, explicit: boolean): CheckResult {
  if (!existsSync(path)) {
    return {
      path,
      status: explicit ? "error" : "skip",
      message: explicit ? "file is absent" : "not present",
    };
  }

  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    return {
      path,
      status: "error",
      message: "secret files must not be symbolic links",
    };
  }
  if (!stat.isFile()) {
    return {
      path,
      status: "error",
      message: "expected a regular file",
    };
  }

  const mode = stat.mode & 0o777;
  const modeText = mode.toString(8).padStart(4, "0");
  const summary = summarizeSecretKeys(path);
  if ((mode & OWNER_ONLY_MASK) !== 0) {
    return {
      path,
      status: "error",
      message: `mode ${modeText} allows group/other access; run chmod 0600 ${shellQuote(path)}. ${summary}`,
    };
  }

  return {
    path,
    status: "ok",
    message: `mode ${modeText} is owner-only. ${summary}`,
  };
}

function summarizeSecretKeys(path: string): string {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return `contents not inspected: ${(error as Error).message}`;
  }

  const keys = basename(path).endsWith(".json")
    ? summarizeJsonKeys(text)
    : summarizeEnvKeys(text);
  if (keys.length === 0) return "No env-style keys detected.";

  const rendered = keys.slice(0, 20).map((key) => `${key}=<redacted>`);
  const suffix = keys.length > rendered.length ? `, ... ${keys.length - rendered.length} more` : "";
  return `Detected keys: ${rendered.join(", ")}${suffix}.`;
}

function summarizeEnvKeys(text: string): string[] {
  const keys = new Set<string>();
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(trimmed);
    if (match) keys.add(match[1]);
  }
  return [...keys].sort();
}

function summarizeJsonKeys(text: string): string[] {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [];
    return Object.keys(parsed).sort();
  } catch {
    return [];
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9_./:-]+$/.test(value)) return value;
  return `'${value.replaceAll("'", "'\\''")}'`;
}
