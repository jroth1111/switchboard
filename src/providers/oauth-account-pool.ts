/** Parse ANTHROPIC_OAUTH_ACCOUNTS env (JSON array or comma-separated). */
export function parseOAuthAccountList(raw: string | undefined): string[] {
  if (!raw?.trim()) return [];
  const trimmed = raw.trim();
  if (trimmed.startsWith("[")) {
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (Array.isArray(parsed)) {
        return parsed.filter((x): x is string => typeof x === "string" && x.trim().length > 0).map((x) => x.trim());
      }
    } catch {
      return [];
    }
  }
  return trimmed.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Deterministic rotation: try accounts starting at index derived from requestId. */
export function rotateOAuthAccountCandidates(
  accounts: string[],
  requestId: string | undefined,
): string[] {
  const unique = Array.from(new Set(accounts.filter(Boolean)));
  if (unique.length <= 1 || !requestId) return unique;
  const start = stableIndex(requestId, unique.length);
  return [...unique.slice(start), ...unique.slice(0, start)];
}

function stableIndex(seed: string, mod: number): number {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0) % mod;
}

export function anthropicOAuthAccountCandidates(
  configuredAccountId: string,
  deploymentId: string,
  extraAccounts: string[] | undefined,
  requestId: string | undefined,
): string[] {
  const candidates: string[] = [];
  const configured = configuredAccountId.trim();
  if (configured) candidates.push(configured);
  candidates.push(`anthropic:${deploymentId}`);
  if (extraAccounts?.length) candidates.push(...extraAccounts);
  return rotateOAuthAccountCandidates(Array.from(new Set(candidates)), requestId);
}
