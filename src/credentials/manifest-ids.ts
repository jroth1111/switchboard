import type { Deployment } from "../config/schema";
import { discoverProviderApiKeyRefs, inferApiKeyProviderId } from "./discover-api-keys";
import { resolveCredentialPool } from "./resolve-pool";

/** Credential ids declared on a deployment (env key names or OAuth account ids). */
export function manifestCredentialIds(deployment: Deployment): string[] {
  const ids = new Set<string>();
  const primary = deployment.keyRef?.trim();
  if (primary) ids.add(primary);
  for (const id of deployment.credentialPool ?? []) {
    if (id.trim()) ids.add(id.trim());
  }
  for (const id of deployment.accountIds ?? []) {
    if (id.trim()) ids.add(id.trim());
  }
  return [...ids];
}

/** Manifest ids plus runtime-discovered API keys when env bindings are available. */
export function runtimeCredentialIds(
  deployment: Deployment,
  env?: Record<string, unknown>,
): string[] {
  const ids = new Set(manifestCredentialIds(deployment));
  if (!env) return [...ids];

  const providerId = inferApiKeyProviderId(deployment);
  if (providerId) {
    for (const ref of discoverProviderApiKeyRefs(env, providerId)) {
      ids.add(ref);
    }
  }
  return [...ids];
}

/** Credential ids from the same pool used at request time (OAuth accounts, inline ChatGPT JSON, API keys). */
export async function resolvedCredentialIds(
  deployment: Deployment,
  env?: Record<string, unknown>,
  requestId?: string,
): Promise<string[]> {
  if (!env) return manifestCredentialIds(deployment);
  const pool = await resolveCredentialPool(deployment, env, requestId);
  if (pool.length === 0) return manifestCredentialIds(deployment);
  return pool.map((slot) => slot.credentialId);
}
