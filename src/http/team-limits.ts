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
