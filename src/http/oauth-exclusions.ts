import { MANIFEST } from "../config/manifest";

export function oauthProviderKeyForGroup(groupName: string): string | undefined {
  const dep = MANIFEST.deploymentsByGroup[groupName]?.[0];
  if (!dep) return undefined;
  switch (dep.provider) {
    case "anthropic_subscription": return "anthropic";
    case "chatgpt": return "chatgpt";
    case "nvidia_nim": return "nim";
    case "openai": return "openai";
    default: return dep.provider;
  }
}

export function modelIdentitySet(requestedModel: string, canonicalTarget: string): Set<string> {
  const values = new Set([requestedModel, canonicalTarget]);
  for (const [alias, target] of Object.entries(MANIFEST.aliases)) {
    if (target === canonicalTarget) values.add(alias);
  }
  return values;
}

export function mergeOAuthExcludedModels(
  manifestExclusions?: Record<string, string[]>,
  clientExclusions?: Record<string, string[]>,
): Record<string, string[]> | undefined {
  const merged: Record<string, string[]> = {};
  for (const source of [manifestExclusions, clientExclusions]) {
    if (!source) continue;
    for (const [key, list] of Object.entries(source)) {
      if (!list?.length) continue;
      merged[key] = Array.from(new Set([...(merged[key] ?? []), ...list]));
    }
  }
  return Object.keys(merged).length > 0 ? merged : undefined;
}

export function isOAuthExcluded(
  groupName: string,
  modelKeys: Set<string>,
  exclusions?: Record<string, string[]>,
): boolean {
  if (!exclusions) return false;
  const providerKey = oauthProviderKeyForGroup(groupName);
  if (!providerKey) return false;
  const list = exclusions[providerKey];
  if (!list?.length) return false;
  if (list.includes("*")) return true;
  return list.some((entry) => modelKeys.has(entry));
}
