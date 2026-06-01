import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultDevVarsPath,
  discoverLocalSecretPaths,
  resolveSwitchboardLocalDir,
} from "../../scripts/local-secrets-dir";

const testEnv: NodeJS.ProcessEnv = {};

describe("local-secrets-dir", () => {
  it("defaults to sibling switchboard-local", () => {
    const repo = mkdtempSync("/tmp/switchboard-repo-");
    try {
      expect(resolveSwitchboardLocalDir(repo, testEnv)).toBe(join(repo, "..", "switchboard-local"));
      expect(defaultDevVarsPath(repo, testEnv)).toBe(join(repo, "..", "switchboard-local", ".dev.vars"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it("honors SWITCHBOARD_LOCAL_DIR", () => {
    const repo = mkdtempSync("/tmp/switchboard-repo-");
    const custom = mkdtempSync("/tmp/switchboard-custom-secrets-");
    const env = { SWITCHBOARD_LOCAL_DIR: custom };
    try {
      expect(resolveSwitchboardLocalDir(repo, env)).toBe(custom);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(custom, { recursive: true, force: true });
    }
  });

  it("discovers external secrets before repo-root files", () => {
    const repo = mkdtempSync("/tmp/switchboard-repo-");
    const external = mkdtempSync("/tmp/switchboard-local-");
    const env = { SWITCHBOARD_LOCAL_DIR: external };
    try {
      writeFileSync(join(external, ".dev.vars"), "EXTERNAL=1\n");
      writeFileSync(join(repo, ".dev.vars"), "REPO=1\n");
      const paths = discoverLocalSecretPaths(repo, env).filter((p) => p.endsWith(".dev.vars"));
      expect(paths).toEqual([join(external, ".dev.vars"), join(repo, ".dev.vars")]);
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });

  it("includes files under external .secrets", () => {
    const repo = mkdtempSync("/tmp/switchboard-repo-");
    const external = mkdtempSync("/tmp/switchboard-local-");
    const env = { SWITCHBOARD_LOCAL_DIR: external };
    try {
      mkdirSync(join(external, ".secrets"));
      writeFileSync(join(external, ".secrets", "chatgpt-auth.json"), "{}");
      expect(discoverLocalSecretPaths(repo, env)).toContain(join(external, ".secrets", "chatgpt-auth.json"));
    } finally {
      rmSync(repo, { recursive: true, force: true });
      rmSync(external, { recursive: true, force: true });
    }
  });
});
