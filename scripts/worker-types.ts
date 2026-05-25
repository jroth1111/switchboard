import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const WORKER_TYPES_PATH = "worker-configuration.d.ts";
const WRANGLER_BIN = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
const WRANGLER_PATH = join("node_modules", ".bin", WRANGLER_BIN);
const WRANGLER_ARGS = [
  "types",
  "--config",
  "wrangler.jsonc",
  "--env-file",
  "fixtures/wrangler-types.env",
];

const mode = process.argv[2] ?? "check";
if (mode !== "check" && mode !== "write") {
  console.error("usage: node scripts/worker-types.ts [check|write]");
  process.exit(2);
}

const before = existsSync(WORKER_TYPES_PATH)
  ? normalize(readFileSync(WORKER_TYPES_PATH, "utf8"))
  : "";

const generated = spawnSync(WRANGLER_PATH, WRANGLER_ARGS, {
  encoding: "utf8",
  stdio: "inherit",
});
if (generated.error || generated.status !== 0) {
  if (generated.error) console.error(generated.error.message);
  process.exit(generated.status ?? 1);
}

const after = normalize(readFileSync(WORKER_TYPES_PATH, "utf8"));
writeFileSync(WORKER_TYPES_PATH, after);

if (mode === "check" && before !== after) {
  console.error("worker-configuration.d.ts is out of date; run `npm run types:worker`.");
  process.exit(1);
}

function normalize(value: string): string {
  return value.replace(/[ \t]+$/gmu, "").replace(/\n?$/u, "\n");
}
