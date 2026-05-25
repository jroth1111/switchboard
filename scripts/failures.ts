#!/usr/bin/env node
// Inspect failed-request records through the Worker observability endpoint.

import {
  assertOperationalEnvLoaded,
  loadOperationalEnv,
  optionalOperationalEnv,
} from "./operational-env.ts";

const USAGE = `Usage:
  CONTROL_PLANE_URL=http://127.0.0.1:8787 NIM_HEALTH_TOKEN=... npm run failures -- recent [filters]
  CONTROL_PLANE_URL=http://127.0.0.1:8787 NIM_HEALTH_TOKEN=... npm run failures -- search [filters]
  CONTROL_PLANE_URL=http://127.0.0.1:8787 NIM_HEALTH_TOKEN=... npm run failures -- show <receipt_id> [--include-receipt]

Filters:
  --route <name>
  --selected-group <name>
  --selected-model <name>
  --failure-class <name>
  --issue-code <name>
  --request-source <name>
  --since <timestamp|duration>
  --until <timestamp|duration>
  --limit <1-500>
  --json

Durable Object SQLite is owned by the Worker runtime and is not exposed as a stable
local Node storage API. This CLI is therefore a safe authenticated HTTP wrapper
around /nim/failures and /nim/failures/{receipt_id}.`;

type Command = "recent" | "search" | "show";

interface ParsedArgs {
  command: Command;
  receiptId?: string;
  includeReceipt: boolean;
  json: boolean;
  filters: Record<string, string>;
}

const FILTER_FLAGS: Record<string, string> = {
  "--route": "route",
  "--selected-group": "selected_group",
  "--selected-model": "selected_model",
  "--failure-class": "failure_class",
  "--issue-code": "issue_code",
  "--request-source": "request_source",
  "--since": "since",
  "--until": "until",
  "--limit": "limit",
};

async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const args = parseArgs(argv);
    const payload = await fetchFailures(args);
    if (args.json) {
      console.log(JSON.stringify(payload, null, 2));
    } else if (args.command === "show") {
      printDetail(payload as Record<string, unknown>);
    } else {
      printTable(payload as { failures?: Array<Record<string, unknown>> });
    }
    return 0;
  } catch (error) {
    console.error(`error: ${(error as Error).message}`);
    return 2;
  }
}

function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0 || argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    process.exit(0);
  }
  const command = argv.shift();
  if (command !== "recent" && command !== "search" && command !== "show") {
    throw new Error("command must be recent, search, or show");
  }

  const filters: Record<string, string> = {};
  let receiptId: string | undefined;
  let includeReceipt = false;
  let json = false;

  if (command === "show") {
    receiptId = argv.shift();
    if (!receiptId?.trim()) throw new Error("show requires a receipt_id");
  }

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      json = true;
      continue;
    }
    if (arg === "--include-receipt") {
      includeReceipt = true;
      continue;
    }
    const param = FILTER_FLAGS[arg];
    if (!param) throw new Error(`unsupported flag: ${arg}`);
    const value = argv[++i];
    if (!value?.trim()) throw new Error(`${arg} requires a value`);
    if (param === "limit") validateLimit(value);
    filters[param] = value;
  }

  if (command !== "show" && includeReceipt) {
    throw new Error("--include-receipt is only supported for show");
  }

  return { command, receiptId, includeReceipt, json, filters };
}

async function fetchFailures(args: ParsedArgs): Promise<unknown> {
  const operationalEnv = loadOperationalEnv();
  assertOperationalEnvLoaded(operationalEnv);

  const baseUrl = trimTrailingSlash(optionalOperationalEnv(
    operationalEnv,
    "CONTROL_PLANE_URL",
    "SWITCHBOARD_URL",
    "LIVE_BASE_URL",
  ) ?? "");
  if (!baseUrl) throw new Error("CONTROL_PLANE_URL or SWITCHBOARD_URL is required");
  const token = optionalOperationalEnv(
    operationalEnv,
    "NIM_HEALTH_TOKEN",
    "ADMIN_API_KEY",
  ) ?? "";
  if (!token) throw new Error("NIM_HEALTH_TOKEN or ADMIN_API_KEY is required");

  const url = new URL(args.command === "show"
    ? `${baseUrl}/nim/failures/${encodeURIComponent(args.receiptId!)}`
    : `${baseUrl}/nim/failures`);
  for (const [key, value] of Object.entries(args.filters)) {
    url.searchParams.set(key, value);
  }
  if (args.includeReceipt) url.searchParams.set("include_receipt", "true");

  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const text = await response.text();
  let body: unknown;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { error: text.slice(0, 200) };
  }
  if (!response.ok) {
    const error = body && typeof body === "object" && "error" in body
      ? String((body as Record<string, unknown>).error)
      : `HTTP ${response.status}`;
    throw new Error(`HTTP ${response.status}: ${error}`);
  }
  return body;
}

function validateLimit(value: string): void {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isInteger(parsed) || String(parsed) !== value || parsed < 1 || parsed > 500) {
    throw new Error("--limit must be an integer between 1 and 500");
  }
}

function printTable(payload: { failures?: Array<Record<string, unknown>> }): void {
  const failures = payload.failures ?? [];
  if (failures.length === 0) {
    console.log("No failed requests found.");
    return;
  }
  console.log("timestamp request_id route selected_group selected_model failure_class issue_code attempts");
  for (const row of failures) {
    console.log([
      String(row.timestamp ?? ""),
      String(row.requestId ?? ""),
      String(row.route ?? row.canonicalTarget ?? ""),
      String(row.selectedGroup ?? ""),
      String(row.selectedModel ?? ""),
      String(row.failureClass ?? ""),
      String(row.issueCode ?? ""),
      String(row.attemptsCount ?? ""),
    ].map(clip).join(" "));
  }
}

function printDetail(payload: Record<string, unknown>): void {
  console.log(JSON.stringify(payload, null, 2));
}

function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

function clip(value: string): string {
  return value.length > 28 ? `${value.slice(0, 25)}...` : value;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const code = await main();
  process.exit(code);
}
