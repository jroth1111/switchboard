import type { FallbackProfile } from "../config/fallback-profile";
import { failureClassToFallbackProfile } from "../config/fallback-profile";
import type { RouteGroup, Policy, Deployment } from "../config/schema";
import { MANIFEST } from "../config/manifest";

export interface AttemptSequenceEntry {
  group: string;
  policy: Policy;
  deployments: Deployment[];
}

/** Reorder remaining attempt sequence to prefer profile-specific fallback targets. */
export function promoteProfileFallbacks(
  sequence: AttemptSequenceEntry[],
  fromIndex: number,
  failureClass: string | undefined,
  primaryGroup: string,
): AttemptSequenceEntry[] {
  if (!failureClass || fromIndex >= sequence.length) return sequence;
  const routeGroup: RouteGroup | undefined = MANIFEST.routeGroups[primaryGroup];
  const profile: FallbackProfile = failureClassToFallbackProfile(failureClass);
  const targets = routeGroup?.fallbackByProfile?.[profile];
  if (!targets?.length) return sequence;

  const head = sequence.slice(0, fromIndex);
  const remaining = sequence.slice(fromIndex);
  const prioritized: AttemptSequenceEntry[] = [];
  const used = new Set<string>();

  for (const target of targets) {
    const entry = remaining.find((e) => e.group === target);
    if (entry && !used.has(entry.group)) {
      prioritized.push(entry);
      used.add(entry.group);
    }
  }
  for (const entry of remaining) {
    if (!used.has(entry.group)) prioritized.push(entry);
  }
  return [...head, ...prioritized];
}
