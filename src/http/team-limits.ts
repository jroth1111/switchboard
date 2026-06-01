export interface TeamLimits {
  rpmLimit?: number;
  maxConcurrency?: number;
  tokenBudgetPerMinute?: number;
}

export interface ClientAdmissionLimits {
  rpmLimit: number | null;
  maxConcurrency: number | null;
  tokenBudgetPerMinute: number | null;
  teamId?: string;
  teamRpmLimit: number | null;
  teamMaxConcurrency: number | null;
  teamTokenBudgetPerMinute: number | null;
}

export function parseSegmentAliases(raw: string | undefined): Map<string, string> {
  const aliases = new Map<string, string>();
  if (!raw?.trim()) return aliases;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return aliases;
  }
  const rawAliases = (parsed as { segmentAliases?: unknown }).segmentAliases;
  if (!rawAliases || typeof rawAliases !== "object" || Array.isArray(rawAliases)) return aliases;
  for (const [alias, teamId] of Object.entries(rawAliases as Record<string, unknown>)) {
    const normalizedAlias = alias.trim();
    const normalizedTeamId = typeof teamId === "string" ? teamId.trim() : "";
    if (normalizedAlias && normalizedTeamId) {
      aliases.set(normalizedAlias, normalizedTeamId);
    }
  }
  return aliases;
}

export function validateSegmentAliases(
  raw: string | undefined,
  teams: Map<string, TeamLimits>,
): Array<{ code: string; message: string }> {
  const issues: Array<{ code: string; message: string }> = [];
  for (const [alias, teamId] of parseSegmentAliases(raw)) {
    if (!teams.has(teamId)) {
      issues.push({
        code: "client_keys_segment_alias_orphan",
        message: `segmentAliases.${alias} maps to unknown team "${teamId}"`,
      });
    }
  }
  return issues;
}

export function resolveRateLimitTeamSegment(
  rawSegment: string | undefined,
  teams: Map<string, TeamLimits>,
  aliases: Map<string, string>,
): string | undefined {
  if (!rawSegment?.trim()) return undefined;
  const resolvedId = aliases.get(rawSegment.trim()) ?? rawSegment.trim();
  return teams.has(resolvedId) ? resolvedId : undefined;
}

export function parseTeamLimits(raw: string | undefined): Map<string, TeamLimits> {
  const teams = new Map<string, TeamLimits>();
  if (!raw?.trim()) return teams;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return teams;
  }
  const rawTeams = (parsed as { teams?: unknown }).teams;
  if (!rawTeams || typeof rawTeams !== "object" || Array.isArray(rawTeams)) return teams;
  for (const [id, cfg] of Object.entries(rawTeams as Record<string, unknown>)) {
    if (!id.trim() || !cfg || typeof cfg !== "object") continue;
    const entry = cfg as Record<string, unknown>;
    const limits: TeamLimits = {};
    const rpm = positiveInteger(entry.rpmLimit);
    const concurrency = positiveInteger(entry.maxConcurrency);
    const tokenBudget = positiveInteger(entry.tokenBudgetPerMinute);
    if (rpm) limits.rpmLimit = rpm;
    if (concurrency) limits.maxConcurrency = concurrency;
    if (tokenBudget) limits.tokenBudgetPerMinute = tokenBudget;
    if (limits.rpmLimit || limits.maxConcurrency || limits.tokenBudgetPerMinute) {
      teams.set(id.trim(), limits);
    }
  }
  return teams;
}

export function resolveClientAdmissionLimits(
  policy: {
    teamId?: string;
    rpmLimit?: number;
    maxConcurrency?: number;
    tokenBudgetPerMinute?: number;
  },
  teams: Map<string, TeamLimits>,
): ClientAdmissionLimits {
  const team = policy.teamId ? teams.get(policy.teamId) : undefined;
  return {
    rpmLimit: policy.rpmLimit ?? null,
    maxConcurrency: policy.maxConcurrency ?? null,
    tokenBudgetPerMinute: policy.tokenBudgetPerMinute ?? null,
    teamId: policy.teamId,
    teamRpmLimit: team?.rpmLimit ?? null,
    teamMaxConcurrency: team?.maxConcurrency ?? null,
    teamTokenBudgetPerMinute: team?.tokenBudgetPerMinute ?? null,
  };
}

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return undefined;
  return Math.trunc(value);
}
