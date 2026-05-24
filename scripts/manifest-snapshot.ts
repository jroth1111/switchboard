// Shared route manifest snapshot builder used by generation and validation.

import { MANIFEST, ROUTE_MANIFEST_VERSION } from "../src/config/manifest.ts";

export function buildManifestSnapshot() {
  return {
    version: ROUTE_MANIFEST_VERSION,
    generatedAt: new Date(0).toISOString(),
    aliases: MANIFEST.aliases,
    routeGroups: MANIFEST.routeGroups,
    policies: Object.fromEntries(
      Object.entries(MANIFEST.policies).map(([name, policy]) => [name, {
        request: policy.request,
        deadline: policy.deadline,
        retry: policy.retry,
        health: policy.health,
        budget: policy.budget,
      }]),
    ),
    deployments: MANIFEST.deployments.map((deployment) => ({
      id: deployment.id,
      group: deployment.group,
      provider: deployment.provider,
      model: deployment.model,
      providerModel: deployment.providerModel,
      apiBase: deployment.apiBase,
      rpm: deployment.rpm,
      maxParallelRequests: deployment.maxParallelRequests,
      timeout: deployment.timeout,
      streamTimeout: deployment.streamTimeout,
      supportsStreaming: deployment.supportsStreaming,
      capabilities: deployment.capabilities,
      contextWindow: deployment.contextWindow,
      hidden: deployment.hidden,
      mode: deployment.mode,
      reasoningEffort: deployment.reasoningEffort,
    })),
  };
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortForJson(value));
}

function sortForJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortForJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, nested]) => [key, sortForJson(nested)]),
  );
}
