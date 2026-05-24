import type { Deployment } from "./schema";

type RuntimeEnv = Record<string, unknown>;

function envToken(value: string): string {
  return value.toUpperCase().replace(/[^A-Z0-9]+/g, "_").replace(/^_+|_+$/g, "");
}

function readString(env: RuntimeEnv, key: string): string | undefined {
  const value = env[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
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
    const apiBase = readString(env, key);
    if (apiBase) {
      return { ...deployment, apiBase };
    }
  }
  return deployment;
}
