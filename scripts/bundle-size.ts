// Bundle size budget checker.
// Usage: node scripts/bundle-size.ts
// Fails if the Worker bundle exceeds size limits.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { gzipSync } from "node:zlib";

const MAX_RAW_KB = 512;
const MAX_GZIP_KB = 128;
const BUNDLE_PATH = ".wrangler/build/index.js";
const WRANGLER_BIN = process.platform === "win32" ? "wrangler.cmd" : "wrangler";
const WRANGLER_PATH = join("node_modules", ".bin", WRANGLER_BIN);
const WRANGLER_ARGS = ["deploy", "--dry-run", "--outdir=.wrangler/build", "--config", "wrangler.jsonc"];

// Build the bundle first
console.log("Building bundle...");
if (!existsSync(WRANGLER_PATH)) {
  console.error(`Build failed: local Wrangler binary not found at ${WRANGLER_PATH}; install project dependencies before running bundle-size.`);
  process.exit(1);
}

const build = spawnSync(WRANGLER_PATH, WRANGLER_ARGS, {
  encoding: "utf8",
  stdio: "pipe",
});
if (build.error || build.status !== 0) {
  console.error(`Build failed${build.status === null ? "" : ` with exit code ${build.status}`}`);
  if (build.error) console.error(build.error.message);
  const details = [tail(build.stdout), tail(build.stderr)].filter(Boolean).join("\n");
  if (details) console.error(details);
  process.exit(1);
}

try {
  const raw = readFileSync(BUNDLE_PATH);
  const rawKb = raw.length / 1024;
  const gzipped = gzipSync(raw);
  const gzipKb = gzipped.length / 1024;

  console.log(`\n=== Bundle Size Report ===`);
  console.log(`Raw:     ${rawKb.toFixed(1)} KiB (limit: ${MAX_RAW_KB} KiB)`);
  console.log(`Gzip:    ${gzipKb.toFixed(1)} KiB (limit: ${MAX_GZIP_KB} KiB)`);
  console.log(`Ratio:   ${((gzipKb / rawKb) * 100).toFixed(1)}%`);

  let failed = false;
  if (rawKb > MAX_RAW_KB) {
    console.log(`\nFAIL: Raw size ${rawKb.toFixed(1)} KiB exceeds limit ${MAX_RAW_KB} KiB`);
    failed = true;
  }
  if (gzipKb > MAX_GZIP_KB) {
    console.log(`\nFAIL: Gzip size ${gzipKb.toFixed(1)} KiB exceeds limit ${MAX_GZIP_KB} KiB`);
    failed = true;
  }

  if (!failed) {
    console.log(`\nPASS: Bundle within size budget`);
  }

  process.exit(failed ? 1 : 0);
} catch (e) {
  console.error(`Could not read bundle at ${BUNDLE_PATH}: ${(e as Error).message}`);
  process.exit(1);
}

function tail(value: string | null | undefined): string {
  if (!value) return "";
  const lines = value.trim().split(/\r?\n/u);
  return lines.slice(-20).join("\n");
}
