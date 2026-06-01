/** RPM and token budget window key for a deployment candidate. */
export function keyWindowScope(
  keyRef: string,
  group: string,
  scopeMode: "global" | "per_key",
): string {
  return scopeMode === "global" ? `${group}:global` : `${group}:${keyRef}`;
}

/** Alias for token budget accounting (same grouping as RPM under scopeMode). */
export const tokenWindowKey = keyWindowScope;
