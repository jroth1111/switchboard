// Operator health endpoint with auth.
// Ports litellm_logic/obs/health_endpoint.py.

import { MANIFEST } from "../config/manifest";
import { getAllReceipts, type RouteReceipt } from "../observability/receipt";
import { verifyBearerToken } from "../http/auth";

type HealthProvider = {
  getHealth(): Promise<unknown>;
  getRecentReceipts?(limit?: number): Promise<Record<string, unknown>[]>;
};

export interface HealthReport {
  status: "healthy" | "degraded" | "unhealthy";
  timestamp: number;
  routeGroups: Record<string, GroupHealth>;
  plannerSettings: {
    healthFallbackMargin: number;
    halfOpenPenalty: number;
    recentDispatchBonus: number;
    recentDispatchTtlSeconds: number;
  };
  recentOutcomes: {
    total: number;
    success: number;
    exhausted: number;
    clientError: number;
  };
  circuitBreakers: Record<string, CircuitState>;
  cooldowns: Record<string, { reason: string; until: number }>;
}

export interface GroupHealth {
  available: boolean;
  deployments: number;
  availableDeployments: number;
  blockedDeployments: number;
  circuitState?: string;
  avgHealthScore?: number;
}

export interface CircuitState {
  state: string;
  failureCount: number;
  successCount: number;
  openedAt?: number;
  halfOpenAfter?: number;
}

export async function buildHealthReport(stateDo: HealthProvider): Promise<HealthReport> {
  const health = await stateDo.getHealth();
  const now = Date.now();

  const circuits = (health as Record<string, unknown>).circuits as Record<string, CircuitState> | undefined;
  const healthScores = (health as Record<string, unknown>).healthScores as Record<string, { score: number }> | undefined;
  const cooldownsMap = (health as Record<string, unknown>).cooldowns as Record<string, { reason: string; until: number }> | undefined;

  // Build per-group health
  const routeGroups: Record<string, GroupHealth> = {};
  for (const [groupName, rg] of Object.entries(MANIFEST.routeGroups)) {
    if (rg.hidden) continue;

    const deployments = MANIFEST.deploymentsByGroup[groupName] ?? [];
    let totalScore = 0;
    let scoreCount = 0;
    let blocked = 0;

    for (const d of deployments) {
      const circuit = circuits?.[d.id];
      const onCooldown = cooldownsMap?.[d.id] && cooldownsMap[d.id].until > now;
      const isCircuitBlocked = circuit?.state === "open" && (!circuit.halfOpenAfter || now < circuit.halfOpenAfter);
      const isBlocked = isCircuitBlocked || onCooldown;
      if (isBlocked) blocked++;

      const hs = healthScores?.[d.id];
      if (hs) {
        totalScore += hs.score;
        scoreCount++;
      }
    }

    const available = deployments.length - blocked;
    const hasOpenCircuit = deployments.some((d) => circuits?.[d.id]?.state === "open");

    routeGroups[groupName] = {
      available: available > 0,
      deployments: deployments.length,
      availableDeployments: available,
      blockedDeployments: blocked,
      circuitState: hasOpenCircuit ? "open" : "closed",
      avgHealthScore: scoreCount > 0 ? totalScore / scoreCount : undefined,
    };
  }

  // Recent outcomes from receipts
  const receipts = stateDo.getRecentReceipts
    ? await stateDo.getRecentReceipts(200) as unknown as RouteReceipt[]
    : getAllReceipts();
  const recentReceipts = receipts.filter((r) => now - r.timestamp < 300_000); // last 5 min
  const recentOutcomes = {
    total: recentReceipts.length,
    success: recentReceipts.filter((r) => r.finalOutcome === "success" || r.finalOutcome === "repaired_success").length,
    exhausted: recentReceipts.filter((r) => r.finalOutcome === "exhausted").length,
    clientError: recentReceipts.filter((r) => r.finalOutcome === "client_error").length,
  };

  // Overall status
  const availableGroups = Object.values(routeGroups).filter((g) => g.available).length;
  const totalGroups = Object.keys(routeGroups).length;
  let status: HealthReport["status"] = "healthy";
  if (availableGroups === 0) {
    status = "unhealthy";
  } else if (availableGroups < totalGroups) {
    status = "degraded";
  }

  return {
    status,
    timestamp: now,
    routeGroups,
    plannerSettings: { ...MANIFEST.plannerSettings },
    recentOutcomes,
    circuitBreakers: circuits ?? {},
    cooldowns: cooldownsMap ?? {},
  };
}

export function verifyHealthAuth(request: Request, healthToken?: string): boolean {
  if (!healthToken) return false;
  return verifyBearerToken(request, healthToken);
}

export function buildFailureSummary(
  receipt: RouteReceipt,
): Record<string, unknown> {
  return {
    requestId: receipt.requestId,
    timestamp: receipt.timestamp,
    model: receipt.originalModel,
    target: receipt.canonicalTarget,
    group: receipt.selectedGroup,
    outcome: receipt.finalOutcome,
    attempts: receipt.attempts.map((a) => ({
      group: a.group,
      deploymentId: a.deploymentId,
      failureClass: a.failureClass,
      action: a.action,
      durationMs: a.durationMs,
    })),
    stream: receipt.stream,
  };
}
