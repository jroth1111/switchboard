// Generate an auditable route manifest snapshot without provider key refs.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { buildManifestSnapshot } from "./manifest-snapshot.ts";

const snapshotPath = "config/route-manifest.snapshot.json";
const snapshot = buildManifestSnapshot();

mkdirSync(dirname(snapshotPath), { recursive: true });
writeFileSync(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`Wrote ${snapshotPath} (${snapshot.version})`);
