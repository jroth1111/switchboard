// Bundle size budget checker.
// Usage: npx tsx scripts/bundle-size.ts
// Fails if the Worker bundle exceeds size limits.

import { readFileSync, statSync } from "fs";
import { execSync } from "child_process";
import { gzipSync } from "zlib";

const MAX_RAW_KB = 512;
const MAX_GZIP_KB = 128;
const BUNDLE_PATH = ".wrangler/build/index.js";

// Build the bundle first
console.log("Building bundle...");
try {
  execSync("npx wrangler deploy --dry-run --outdir=.wrangler/build --config wrangler.jsonc", {
    stdio: "pipe",
  });
} catch (e) {
  console.error("Build failed");
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
  console.error(`Could not read bundle at ${BUNDLE_PATH}`);
  process.exit(1);
}
