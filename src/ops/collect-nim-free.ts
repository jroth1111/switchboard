import type { RouteManifest } from "../config/schema";
import { ratesForUsageCost } from "../config/usage-pricing";

/** Route groups whose NIM deployments are treated as $0 for free multiplex fallbacks. */
export function collectNimFreeRouteGroups(manifest: RouteManifest): string[] {
  const groups = new Set<string>();
  for (const deployment of manifest.deployments) {
    if (deployment.provider !== "nvidia_nim") continue;
    const rates = ratesForUsageCost(deployment.provider, deployment.providerModel);
    if (!rates || rates.prompt !== 0 || rates.completion !== 0) continue;
    groups.add(deployment.group);
  }
  return [...groups].sort();
}
