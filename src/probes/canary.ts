// Canary probe system: periodic lightweight health checks on deployments.
// Runs via Cron trigger to warm health scores and detect issues early.

import { MANIFEST } from "../config/manifest";
import type { Deployment, FailureClass } from "../config/schema";
import { applyDeploymentRuntimeOverrides } from "../config/runtime-overrides";

export interface ProbeConfig {
  timeoutMs: number;
  maxConcurrentProbes: number;
  probeModel: string;
  probePrompt: string;
  expectedMinLength: number;
  healthyIntervalMs: number;
  suspectIntervalMs: number;
  halfOpenIntervalMs: number;
  unhealthyIntervalMs: number;
  failureBackoffBaseMs: number;
  failureBackoffMaxMs: number;
}

const DEFAULT_PROBE_CONFIG: ProbeConfig = {
  timeoutMs: 15000,
  maxConcurrentProbes: 3,
  probeModel: "probe",
  probePrompt: "Reply with exactly: OK",
  expectedMinLength: 1,
  healthyIntervalMs: 15 * 60 * 1000,
  suspectIntervalMs: 60 * 1000,
  halfOpenIntervalMs: 30 * 1000,
  unhealthyIntervalMs: 2 * 60 * 1000,
  failureBackoffBaseMs: 2 * 60 * 1000,
  failureBackoffMaxMs: 30 * 60 * 1000,
};

export interface ProbeResult {
  deploymentId: string;
  group: string;
  success: boolean;
  failureClass?: FailureClass;
  latencyMs: number;
  status?: number;
  timestamp: number;
}

export interface SubscriptionTokenProvider {
  getAccessToken(accountId: string): Promise<string | null>;
}

export interface ProbeRecorder {
  recordSuccess(deploymentId: string): Promise<void>;
  recordFailure(
    deploymentId: string,
    failureClass: FailureClass,
    cooldownSeconds: number,
    circuitThreshold: number,
    circuitDurationSeconds: number,
  ): Promise<void>;
}

export interface CanaryCircuitSnapshot {
  state?: string;
  halfOpenAfter?: number | null;
  failureCount?: number;
}

export interface CanaryHealthScoreSnapshot {
  rollingMetrics?: {
    timeoutRate?: number;
    invalidSuccessRate?: number;
    p95FirstByteLatencyMs?: number | null;
  };
  consecutiveFailureCount?: number;
}

export interface CanaryHealthSnapshot {
  circuits?: Record<string, CanaryCircuitSnapshot>;
  cooldowns?: Record<string, { until?: number; reason?: string }>;
  healthScores?: Record<string, CanaryHealthScoreSnapshot>;
}

export interface CanaryHistoryRow {
  deploymentId?: string;
  deployment_id?: string;
  timestamp?: number;
  success?: boolean | number;
}

export interface CanaryRunContext {
  now?: number;
  force?: boolean;
  health?: CanaryHealthSnapshot | null;
  recentResults?: CanaryHistoryRow[];
}

interface CanaryDecision {
  due: boolean;
  intervalMs: number;
  priority: number;
  lastProbeAt?: number;
  consecutiveFailures: number;
  reason: string;
}

// ─── Probe a single deployment ────────────────────────────────────

export async function probeDeployment(
  deployment: Deployment,
  apiKey: string,
  config: ProbeConfig = DEFAULT_PROBE_CONFIG,
  accessToken?: string,
): Promise<ProbeResult> {
  const start = Date.now();
  const base = deployment.apiBase ?? "https://api.openai.com/v1";
  const url = deployment.provider === "anthropic_subscription"
    ? `${base}/v1/messages`
    : `${base}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (deployment.provider === "anthropic_subscription") {
    if (accessToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    } else {
      headers["x-api-key"] = apiKey;
    }
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["Authorization"] = `Bearer ${apiKey}`;
  }

  let body: string;
  if (deployment.provider === "anthropic_subscription") {
    body = JSON.stringify({
      model: deployment.providerModel,
      max_tokens: 16,
      messages: [{ role: "user", content: config.probePrompt }],
    });
  } else {
    body = JSON.stringify({
      model: deployment.providerModel,
      max_tokens: 16,
      messages: [{ role: "user", content: config.probePrompt }],
    });
  }

  try {
    const response = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    const latencyMs = Date.now() - start;

    if (response.status >= 400) {
      let failureClass: FailureClass;
      if (response.status === 401 || response.status === 403) {
        failureClass = "auth_failure";
      } else if (response.status === 429) {
        failureClass = "rate_limit_overload";
      } else if (response.status >= 500) {
        failureClass = "server_5xx";
      } else {
        failureClass = "client_4xx";
      }
      return {
        deploymentId: deployment.id,
        group: deployment.group,
        success: false,
        failureClass,
        latencyMs,
        status: response.status,
        timestamp: Date.now(),
      };
    }

    // Verify response has content
    const respBody = await response.text();
    const hasContent = respBody.length >= config.expectedMinLength;

    return {
      deploymentId: deployment.id,
      group: deployment.group,
      success: hasContent,
      failureClass: hasContent ? undefined : "empty_response",
      latencyMs,
      status: response.status,
      timestamp: Date.now(),
    };
  } catch (err) {
    const latencyMs = Date.now() - start;
    const failureClass: FailureClass = err instanceof DOMException && ["AbortError", "TimeoutError"].includes(err.name)
      ? "transport_timeout"
      : "transport_error";

    return {
      deploymentId: deployment.id,
      group: deployment.group,
      success: false,
      failureClass,
      latencyMs,
      timestamp: Date.now(),
    };
  }
}

// ─── Run probes for all active deployments ────────────────────────

export async function runCanaryProbes(
  env: Record<string, unknown>,
  recorder: ProbeRecorder,
  config: ProbeConfig = DEFAULT_PROBE_CONFIG,
  probeMaxInflight?: number,
  context: CanaryRunContext = {},
  subscriptionTokens?: SubscriptionTokenProvider,
): Promise<ProbeResult[]> {
  const results: ProbeResult[] = [];
  const effectiveMaxConcurrent = probeMaxInflight ?? config.maxConcurrentProbes;

  const candidates = selectCanaryCandidates(MANIFEST.deployments, env, config, context);

  // Run probes with bounded concurrency
  const inFlight: Promise<ProbeResult>[] = [];

  for (const deployment of candidates) {
    const apiKey = (env[deployment.keyRef] as string) ?? "";
    if (!apiKey) continue;
    const effectiveDeployment = applyDeploymentRuntimeOverrides(deployment, env);

    // Resolve OAuth access token for subscription providers
    let accessToken: string | undefined;
    if (effectiveDeployment.provider === "anthropic_subscription" && subscriptionTokens) {
      accessToken = await subscriptionTokens.getAccessToken(apiKey) ?? undefined;
    }

    const probe = probeDeployment(effectiveDeployment, apiKey, config, accessToken).then(async (result) => {
      if (result.success) {
        await recorder.recordSuccess(result.deploymentId);
      } else if (result.failureClass) {
        await recorder.recordFailure(
          result.deploymentId,
          result.failureClass,
          result.failureClass === "rate_limit_overload" ? 30 : 0,
          5,
          300,
        );
      }
      return result;
    });

    inFlight.push(probe);

    if (inFlight.length >= effectiveMaxConcurrent) {
      const settled = await Promise.allSettled(inFlight);
      for (const r of settled) {
        if (r.status === "fulfilled") results.push(r.value);
      }
      inFlight.length = 0;
    }
  }

  // Drain remaining
  if (inFlight.length > 0) {
    const settled = await Promise.allSettled(inFlight);
    for (const r of settled) {
      if (r.status === "fulfilled") results.push(r.value);
    }
  }

  return results;
}

export function selectCanaryCandidates(
  deployments: Deployment[],
  env: Record<string, unknown>,
  config: ProbeConfig = DEFAULT_PROBE_CONFIG,
  context: CanaryRunContext = {},
): Deployment[] {
  const now = context.now ?? Date.now();
  const byDeployment = buildCanaryHistory(context.recentResults ?? []);
  const byGroup = new Map<string, Array<{ deployment: Deployment; decision: CanaryDecision; index: number }>>();

  deployments.forEach((deployment, index) => {
    if (deployment.hidden) return;
    const apiKey = (env[deployment.keyRef] as string) ?? "";
    if (!apiKey) return;
    const decision = canaryProbeDecision(deployment.id, now, config, context, byDeployment.get(deployment.id) ?? []);
    if (!decision.due) return;
    const group = byGroup.get(deployment.group) ?? [];
    group.push({ deployment, decision, index });
    byGroup.set(deployment.group, group);
  });

  const selected: Deployment[] = [];
  for (const group of byGroup.values()) {
    if (group.length === 0) continue;
    group.sort((a, b) =>
      a.decision.priority - b.decision.priority
      || (a.decision.lastProbeAt ?? 0) - (b.decision.lastProbeAt ?? 0)
      || a.index - b.index,
    );
    selected.push(group[0].deployment);
  }
  return selected;
}

export function canaryProbeDecision(
  deploymentId: string,
  now: number,
  config: ProbeConfig,
  context: CanaryRunContext,
  history: CanaryHistoryRow[],
): CanaryDecision {
  const normalizedHistory = history
    .filter((row) => typeof row.timestamp === "number")
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  const lastProbeAt = normalizedHistory[0]?.timestamp;
  const consecutiveFailures = countConsecutiveCanaryFailures(normalizedHistory);

  if (context.force) {
    return { due: true, intervalMs: 0, priority: 0, lastProbeAt, consecutiveFailures, reason: "forced" };
  }

  const circuit = context.health?.circuits?.[deploymentId];
  const cooldown = context.health?.cooldowns?.[deploymentId];
  if (typeof cooldown?.until === "number" && cooldown.until > now && circuit?.state !== "half_open") {
    return {
      due: false,
      intervalMs: Math.max(0, cooldown.until - now),
      priority: 9,
      lastProbeAt,
      consecutiveFailures,
      reason: "cooldown_active",
    };
  }

  const base = baseCanaryInterval(deploymentId, now, config, context);
  const failureBackoffMs = canaryFailureBackoffMs(consecutiveFailures, config);
  const intervalMs = consecutiveFailures > 0
    ? (base.reason === "half_open" ? base.intervalMs : Math.max(base.reason === "healthy" ? 0 : base.intervalMs, failureBackoffMs))
    : base.intervalMs;
  const due = (lastProbeAt === null || lastProbeAt === undefined) || now - lastProbeAt >= intervalMs;
  return {
    due,
    intervalMs,
    priority: base.priority,
    lastProbeAt,
    consecutiveFailures,
    reason: base.reason,
  };
}

function baseCanaryInterval(
  deploymentId: string,
  now: number,
  config: ProbeConfig,
  context: CanaryRunContext,
): { intervalMs: number; priority: number; reason: string } {
  const circuit = context.health?.circuits?.[deploymentId];
  if (circuit?.state === "half_open" || (circuit?.state === "open" && typeof circuit.halfOpenAfter === "number" && circuit.halfOpenAfter <= now)) {
    return { intervalMs: config.halfOpenIntervalMs, priority: 0, reason: "half_open" };
  }
  if (circuit?.state === "suspect") {
    return { intervalMs: config.suspectIntervalMs, priority: 1, reason: "suspect" };
  }
  if (circuit?.state === "open") {
    return { intervalMs: config.failureBackoffBaseMs, priority: 4, reason: "open_backoff" };
  }

  const metrics = context.health?.healthScores?.[deploymentId]?.rollingMetrics;
  if (
    (metrics?.timeoutRate ?? 0) >= 0.5
    || (metrics?.invalidSuccessRate ?? 0) >= 0.5
    || (metrics?.p95FirstByteLatencyMs ?? 0) >= 4_000
  ) {
    return { intervalMs: config.unhealthyIntervalMs, priority: 2, reason: "rolling_unhealthy" };
  }

  return { intervalMs: config.healthyIntervalMs, priority: 8, reason: "healthy" };
}

function canaryFailureBackoffMs(consecutiveFailures: number, config: ProbeConfig): number {
  if (consecutiveFailures <= 0) return 0;
  const multiplier = Math.min(2 ** (consecutiveFailures - 1), config.failureBackoffMaxMs / config.failureBackoffBaseMs);
  return Math.min(config.failureBackoffMaxMs, Math.round(config.failureBackoffBaseMs * multiplier));
}

function buildCanaryHistory(rows: CanaryHistoryRow[]): Map<string, CanaryHistoryRow[]> {
  const byDeployment = new Map<string, CanaryHistoryRow[]>();
  for (const row of rows) {
    const deploymentId = row.deploymentId ?? row.deployment_id;
    if (!deploymentId) continue;
    const existing = byDeployment.get(deploymentId) ?? [];
    existing.push(row);
    byDeployment.set(deploymentId, existing);
  }
  return byDeployment;
}

function countConsecutiveCanaryFailures(rows: CanaryHistoryRow[]): number {
  const MAX_COUNTED_FAILURES = 20;
  let failures = 0;
  for (const row of rows) {
    if (row.success === true || row.success === 1) break;
    failures += 1;
    if (failures >= MAX_COUNTED_FAILURES) break;
  }
  return failures;
}

// ─── Reap expired leases across all DO shards ─────────────────────

export async function reapAllLeases(
  getDoStub: (name: string) => { reapExpired(): Promise<number> },
): Promise<number> {
  try {
    return await getDoStub("control-plane").reapExpired();
  } catch {
    return 0;
  }
}
