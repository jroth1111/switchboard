import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

/** Env files and directories searched under each secrets root (repo-adjacent dir first, then repo root). */
export const DEFAULT_SECRET_FILES = [".dev.vars", ".env", ".env.local"] as const;
export const DEFAULT_SECRET_DIRS = [".secrets"] as const;

const DEFAULT_LOCAL_DIR_NAME = "switchboard-local";

/**
 * Directory for operator secrets kept out of the public git tree.
 * Override with SWITCHBOARD_LOCAL_DIR (absolute or relative to `cwd`).
 */
export function resolveSwitchboardLocalDir(
  cwd = process.cwd(),
  processEnv: NodeJS.ProcessEnv = process.env,
): string {
  const override = processEnv.SWITCHBOARD_LOCAL_DIR?.trim();
  if (override) return resolve(cwd, override);
  return resolve(cwd, "..", DEFAULT_LOCAL_DIR_NAME);
}

export function defaultDevVarsPath(
  cwd = process.cwd(),
  processEnv: NodeJS.ProcessEnv = process.env,
): string {
  return join(resolveSwitchboardLocalDir(cwd, processEnv), ".dev.vars");
}

/** Secret paths: external local dir first, then repo root (legacy / tests). Later files win in merge order. */
export function discoverLocalSecretPaths(
  cwd = process.cwd(),
  processEnv: NodeJS.ProcessEnv = process.env,
): string[] {
  const roots = [resolveSwitchboardLocalDir(cwd, processEnv), cwd];
  const paths: string[] = [];
  for (const root of roots) {
    for (const file of DEFAULT_SECRET_FILES) {
      paths.push(join(root, file));
    }
    for (const dirName of DEFAULT_SECRET_DIRS) {
      const dir = join(root, dirName);
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isFile()) paths.push(join(dir, entry.name));
      }
    }
  }
  return paths;
}

export function repoRootDevVarsPresent(cwd = process.cwd()): boolean {
  return existsSync(join(cwd, ".dev.vars"))
    || existsSync(join(cwd, ".env"))
    || existsSync(join(cwd, ".env.local"))
    || existsSync(join(cwd, ".secrets"));
}

export const REPO_SECRETS_MIGRATION_HINT =
  "Move local secrets out of the repo: mkdir -p ../switchboard-local/.secrets && "
  + "mv .dev.vars ../switchboard-local/.dev.vars (see README).";
