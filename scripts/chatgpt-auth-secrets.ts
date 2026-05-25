import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";

function resolveCiChatGptAuthFixturePath(cwd: string): string | null {
  const candidates = [
    fileURLToPath(new URL("../config/fixtures/chatgpt-auth.ci.json", import.meta.url)),
    join(cwd, "config/fixtures/chatgpt-auth.ci.json"),
  ];
  return candidates.find((path) => existsSync(path)) ?? null;
}

const DEFAULT_SECRET_FILES = [".dev.vars", ".env", ".env.local"];
const DEFAULT_SECRET_DIRS = [".secrets"];
const CHATGPT_SUBSCRIPTION_AUTH_REQUIRED_FIELDS = [
  "access_token",
  "refresh_token",
  "id_token",
] as const;

export interface LocalSecretEnv {
  values: Record<string, string>;
  localSecretSurfacePresent: boolean;
  loadErrors: string[];
}

export interface ChatGPTAuthValidationIssue {
  kind: "error" | "warning";
  message: string;
}

export function loadLocalSecretEnv(cwd = process.cwd(), processEnv: NodeJS.ProcessEnv = process.env): LocalSecretEnv {
  const values: Record<string, string> = {};
  const loadErrors: string[] = [];
  let localSecretSurfacePresent = false;

  for (const path of discoverDefaultSecretPaths(cwd)) {
    if (!existsSync(path)) continue;
    localSecretSurfacePresent = true;
    try {
      Object.assign(values, parseSecretFile(path));
    } catch (err) {
      loadErrors.push(`${basename(path)}: ${(err as Error).message}`);
    }
  }

  for (const key of ["CHATGPT_AUTH_JSON", "CHATGPT_AUTH_FILE", "CHATGPT_OAUTH"]) {
    const value = processEnv[key];
    if (typeof value === "string" && value.trim()) {
      values[key] = value.trim();
      localSecretSurfacePresent = true;
    }
  }

  if (!localSecretSurfacePresent && processEnv.CI === "true") {
    const fixturePath = resolveCiChatGptAuthFixturePath(cwd);
    if (fixturePath) {
      try {
        values.CHATGPT_AUTH_JSON = readFileSync(fixturePath, "utf8").trim();
        localSecretSurfacePresent = true;
      } catch (err) {
        loadErrors.push(`chatgpt-auth.ci.json: ${(err as Error).message}`);
      }
    }
  }

  return { values, localSecretSurfacePresent, loadErrors };
}

export function validateChatGPTStructuredAuthSurface(
  env: Record<string, string | undefined>,
  options: { localSecretSurfacePresent: boolean; chatgptResponsesEnabled: boolean },
): ChatGPTAuthValidationIssue[] {
  if (!options.chatgptResponsesEnabled) return [];
  if (!options.localSecretSurfacePresent) {
    return [{
      kind: "error",
      message: "ChatGPT Responses subscription lanes require a local structured auth secret surface; "
        + `set CHATGPT_AUTH_JSON or CHATGPT_AUTH_FILE with required fields: ${CHATGPT_SUBSCRIPTION_AUTH_REQUIRED_FIELDS.join(", ")}`,
    }];
  }

  const authJson = envValue(env, "CHATGPT_AUTH_JSON");
  if (authJson) {
    return withStaleOAuthWarning(validateStructuredAuthValue("CHATGPT_AUTH_JSON", authJson), env);
  }

  const authFile = envValue(env, "CHATGPT_AUTH_FILE");
  if (authFile) {
    if (!isChatGPTSubscriptionAuthJsonText(authFile)) {
      return [{
        kind: "error",
        message: "CHATGPT_AUTH_FILE must contain structured ChatGPT subscription auth JSON content; "
          + "filesystem paths must be resolved before deployment",
      }];
    }
    return withStaleOAuthWarning(validateStructuredAuthValue("CHATGPT_AUTH_FILE", authFile), env);
  }

  if (envValue(env, "CHATGPT_OAUTH")) {
    return [{
      kind: "error",
      message: "CHATGPT_OAUTH is legacy bare-token auth and is not accepted for ChatGPT Responses; "
        + `set CHATGPT_AUTH_JSON with required fields: ${CHATGPT_SUBSCRIPTION_AUTH_REQUIRED_FIELDS.join(", ")}`,
    }];
  }

  return [{
    kind: "error",
    message: "ChatGPT Responses subscription lanes require structured CHATGPT_AUTH_JSON or CHATGPT_AUTH_FILE "
      + `with required fields: ${CHATGPT_SUBSCRIPTION_AUTH_REQUIRED_FIELDS.join(", ")}`,
  }];
}

function withStaleOAuthWarning(
  issues: ChatGPTAuthValidationIssue[],
  env: Record<string, string | undefined>,
): ChatGPTAuthValidationIssue[] {
  if (issues.some((issue) => issue.kind === "error")) return issues;
  if (!envValue(env, "CHATGPT_OAUTH")) return issues;
  return [
    ...issues,
    {
      kind: "warning",
      message: "CHATGPT_OAUTH is legacy bare-token auth and is ignored while structured ChatGPT auth is present; "
        + "remove it from local secrets",
    },
  ];
}

function discoverDefaultSecretPaths(cwd: string): string[] {
  const paths = DEFAULT_SECRET_FILES.map((path) => join(cwd, path));
  for (const dirName of DEFAULT_SECRET_DIRS) {
    const dir = join(cwd, dirName);
    if (!existsSync(dir)) continue;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isFile()) paths.push(join(dir, entry.name));
    }
  }
  return paths;
}

function parseSecretFile(path: string): Record<string, string> {
  const text = readFileSync(path, "utf8");
  if (basename(path).endsWith(".json")) return parseJsonSecretFile(text);
  return parseEnvSecretFile(text);
}

function parseEnvSecretFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u.exec(trimmed);
    if (!match) continue;
    values[match[1]] = unquoteEnvValue(match[2].trim());
  }
  return values;
}

function parseJsonSecretFile(text: string): Record<string, string> {
  const parsed = JSON.parse(text) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const directAuth = materializeDirectStructuredAuth(parsed as Record<string, unknown>);
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value === "string") values[key] = value.trim();
  }
  if (directAuth && !values.CHATGPT_AUTH_JSON && !values.CHATGPT_AUTH_FILE) {
    return { CHATGPT_AUTH_JSON: directAuth };
  }
  return values;
}

function materializeDirectStructuredAuth(record: Record<string, unknown>): string | null {
  const auth: Record<string, string> = {};
  for (const field of CHATGPT_SUBSCRIPTION_AUTH_REQUIRED_FIELDS) {
    const value = record[field];
    if (typeof value !== "string" || value.trim() === "") return null;
    auth[field] = value.trim();
  }
  return JSON.stringify(auth);
}

function validateStructuredAuthValue(name: string, value: string): ChatGPTAuthValidationIssue[] {
  try {
    parseStructuredChatGPTAuth(value, name);
    return [];
  } catch (err) {
    return [{
      kind: "error",
      message: (err as Error).message,
    }];
  }
}

function isChatGPTSubscriptionAuthJsonText(value: string): boolean {
  return value.trim().startsWith("{");
}

function parseStructuredChatGPTAuth(raw: string, credentialName: string): void {
  if (!isChatGPTSubscriptionAuthJsonText(raw)) {
    throw new Error(
      `${credentialName} must be structured JSON with required fields: `
      + CHATGPT_SUBSCRIPTION_AUTH_REQUIRED_FIELDS.join(", "),
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${credentialName} must be valid JSON`);
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${credentialName} must be a flat JSON object`);
  }

  const record = parsed as Record<string, unknown>;
  const missing = CHATGPT_SUBSCRIPTION_AUTH_REQUIRED_FIELDS.filter((field) => {
    const value = record[field];
    return typeof value !== "string" || value.trim() === "";
  });
  if (missing.length > 0) {
    throw new Error(`${credentialName} is missing required fields: ${missing.join(", ")}`);
  }

  const accessToken = (record.access_token as string).trim();
  if (/^sk-[A-Za-z0-9]/.test(accessToken)) {
    throw new Error(`${credentialName} requires subscription OAuth, not an OpenAI API key`);
  }
}

function envValue(env: Record<string, string | undefined>, key: string): string {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

function unquoteEnvValue(value: string): string {
  if (value.length < 2) return value;
  const first = value[0];
  const last = value[value.length - 1];
  if ((first === "\"" && last === "\"") || (first === "'" && last === "'")) {
    return value.slice(1, -1).trim();
  }
  return value;
}
