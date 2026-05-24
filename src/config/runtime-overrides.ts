import type { Deployment } from "./schema";

type RuntimeEnv = Record<string, unknown>;

function envToken(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function readString(env: RuntimeEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizeProviderApiBase(value: string): string | undefined {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return undefined;
  }

  if (url.username || url.password || url.search || url.hash) return undefined;
  if (url.protocol === "http:" && !isLocalHttpHost(url.hostname)) return undefined;
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;

  return url.toString().replace(/\/+$/u, "");
}

function isLocalHttpHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "localhost"
    || host.endsWith(".localhost")
    || host === "127.0.0.1"
    || host === "0.0.0.0"
    || host === "::1"
    || host === "[::1]";
}

function readProviderApiBase(env: RuntimeEnv, key: string): string | undefined {
  const value = readString(env, key);
  return value ? normalizeProviderApiBase(value) : undefined;
}

export function providerApiBaseOverrideKeys(deployment: Deployment): string[] {
  return [
    `PROVIDER_API_BASE_${envToken(deployment.id)}`,
    `PROVIDER_API_BASE_GROUP_${envToken(deployment.group)}`,
    `PROVIDER_API_BASE_PROVIDER_${envToken(deployment.provider)}`,
    "PROVIDER_API_BASE_ALL",
  ];
}

export function applyDeploymentRuntimeOverrides(
  deployment: Deployment,
  env: RuntimeEnv,
): Deployment {
  for (const key of providerApiBaseOverrideKeys(deployment)) {
    const apiBase = readProviderApiBase(env, key);
    if (apiBase) {
      return { ...deployment, apiBase };
    }
  }
  return deployment;
}
