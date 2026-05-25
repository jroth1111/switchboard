// Attempt loop: serial retry/fallback with silent non-streaming failover.
// Ports behavior from litellm_logic/routing/attempts.py.

import type { ExecutionPlan, RequestEnvelope } from "../planner/planner";
import type { Deployment, FailureClass, Policy } from "../config/schema";
import type { AdmissionRequest, AdmissionResponse } from "../state/control-plane-state";
import { MANIFEST } from "../config/manifest";
import { deploymentPenalty, computeAdaptiveDeadlineMs, type HealthSnapshot } from "../state/admission-engine";
import {
  executeProviderRequest, executeStreamingProviderRequest,
  type ProviderRequest,
} from "../providers/base";
import { getAdapter } from "../providers/registry";
import type { ProviderAdapter } from "../providers/adapter";
import type { OAuthAccountAccessor } from "../providers/anthropic-subscription";
import { isChatGPTSubscriptionAuthJsonText, resolveChatGPTSubscriptionAuth } from "../providers/chatgpt-responses";
import { evaluateResponse, type ResponseEvaluationConfig } from "../nim/evaluate/response";
import { classifyRateLimit } from "../nim/classify/rate-limit";
import { wrapSubscriptionStream, type SubscriptionStreamFormat } from "../streaming/format-converter";
import { classifyProviderFailure, classifyThrownError, SubscriptionTokenError, type ProviderFailureClassification } from "../nim/classify/provider-failure";
import { openAIErrorJson } from "../providers/openai-error-shape";
import { buildConfiguredPatterns } from "../nim/repair/aliases";
import { executeStreamWithPreBuffer, type PreBufferConfig, type StreamDone } from "../streaming/pre-buffer";
import { logInfo, logWarn } from "../observability/logging";
import { applyDeploymentRuntimeOverrides } from "../config/runtime-overrides";
import { applyPolicyCooldown } from "../config/policy-cooldown";
import { promoteProfileFallbacks } from "./fallback-sequence";
import {
  buildFilterStateFromHealth,
  filterCandidates,
  filterOptionsForPolicy,
} from "../planner/deployment-filter";
import type { TokenUsage, UsageEventPayload } from "../observability/token-usage";
import { normalizeProviderUsage, usageEventFromTokenUsage } from "../observability/token-usage";

const MAX_TOTAL_ATTEMPTS = 12;

export interface AttemptResult {
  success: boolean;
  response?: Response;
  failureClass?: FailureClass;
  failureMessage?: string;
  attempts: AttemptRecord[];
}

export interface AttemptRecord {
  group: string;
  deploymentId: string;
  model?: string;
  failureClass?: FailureClass;
  failureMessage?: string;
  durationMs: number;
  firstByteLatencyMs?: number;
  inflightAtDispatch?: number;
  action: "accept" | "repair_accept" | "retry_same" | "retry_fallback" | "fail_client" | "exhausted";
  attemptIndex: number;
  statusCode?: number;
  retryable: boolean;
  fallbackStoppedReason?: string;
  tokenUsage?: TokenUsage;
}

export interface SubscriptionContext {
  anthropicOAuth?: {
    accessor: OAuthAccountAccessor;
    clientId: string;
    clientSecret?: string;
    tokenUrl?: string;
  };
}

type AttemptSequenceEntry = { group: string; policy: Policy; deployments: Deployment[] };

interface DurableHealthSnapshot {
  healthScores?: Record<string, Partial<HealthSnapshot>>;
  circuits?: Record<string, { state?: string; halfOpenAfter?: number }>;
  cooldowns?: Record<string, { until?: number }>;
  inflight?: Record<string, { count?: number }>;
  learnedLimits?: Record<string, { maxParallel?: number; expiresAt?: number }>;
}

interface HedgeLane {
  group: string;
  policy: Policy;
  admission: AdmissionResponse;
  deployment: Deployment;
  apiKey: string;
  attemptIndex: number;
  attemptTimeoutMs: number;
  deploymentHealth?: Partial<HealthSnapshot>;
}

type HedgeLaneOutcome =
  | { kind: "success"; result: AttemptResult; lane: HedgeLane }
  | { kind: "client"; result: AttemptResult; lane: HedgeLane }
  | { kind: "failure"; lane: HedgeLane }
  | { kind: "canceled"; lane: HedgeLane };

type AttemptStateAccessor = {
  admit(req: AdmissionRequest): Promise<AdmissionResponse>;
  confirm?(reservationId: string): Promise<void>;
  recordSuccess(deploymentId: string, circuitSuccessThreshold?: number, durationMs?: number, latencyConfig?: { emaAlpha?: number; penaltyFactor?: number; warmupSamples?: number }, options?: { firstByteLatencyMs?: number; inflightAtDispatch?: number }): Promise<void>;
  recordFailure(deploymentId: string, failureClass: FailureClass, cooldownSeconds: number, circuitThreshold: number, circuitDurationSeconds: number, suspectThresholdFraction?: number, options?: { inflightAtDispatch?: number; maxParallelAtDispatch?: number; semanticSeverity?: "low" | "medium" | "high"; transportCooldownThreshold?: number }): Promise<void>;
  recordTokenUsage?(keyRef: string, promptTokens: number, completionTokens: number): Promise<void>;
  release(reservationId: string): Promise<void>;
  getHealth?(): Promise<DurableHealthSnapshot>;
  getRecentRouteDispatch?(canonicalTarget: string, requestClass: string, maxAgeSeconds: number): Promise<{ group?: string; dispatchedAt?: number } | null>;
  recordRouteDispatch?(canonicalTarget: string, requestClass: string, groupName: string): Promise<void>;
  storeUsageEvent?(event: UsageEventPayload): Promise<void>;
};

// ─── Main loop ─────────────────────────────────────────────────────

export async function executeAttemptLoop(
  envelope: RequestEnvelope,
  plan: ExecutionPlan,
  stateDo: AttemptStateAccessor,
  env: Record<string, unknown>,
  abortSignal: AbortSignal,
  subscriptionCtx?: SubscriptionContext,
): Promise<AttemptResult> {
  const attempts: AttemptRecord[] = [];
  const startTime = Date.now();
  let attemptIndex = 0;

  let { sequence: attemptSequence, health: durableHealth } = await orderAttemptSequenceWithHealth([
    { group: plan.selectedGroup, policy: plan.selectedPolicy, deployments: plan.selectedDeployments },
    ...plan.fallbackSequence,
  ], plan, envelope, stateDo);

  const modelCount = attemptSequence.length;
  const effectiveTotalTimeoutMs = Math.max(
    plan.selectedPolicy.deadline.totalTimeoutSeconds * 1000,
    plan.selectedPolicy.deadline.attemptTimeoutSeconds * 1000 * modelCount,
  );

  for (let modelIndex = 0; modelIndex < attemptSequence.length; modelIndex++) {
    const entry = attemptSequence[modelIndex];
    if (attempts.length >= MAX_TOTAL_ATTEMPTS) break;
    if (abortSignal.aborted) break;

    const { group, policy, deployments } = entry;
    let transportRetriesLeft = policy.retry.transportRetries;
    let semanticRetriesLeft = policy.retry.semanticRetries;

    if (isHedgeEligible(entry, envelope, durableHealth)) {
      const totalDeadline = startTime + effectiveTotalTimeoutMs;
      if (attemptIndex > 0) {
        const backoffMs = computeBackoff(attemptIndex, policy.retry.backoffBaseMs, policy.retry.backoffMaxMs);
        const remainingBeforeSleep = totalDeadline - Date.now();
        if (remainingBeforeSleep <= 0) break;
        await sleep(Math.min(backoffMs, remainingBeforeSleep), abortSignal);
        if (abortSignal.aborted) break;
      }

      const hedge = await executeHedgedNonStreamingAttempt(
        envelope, plan, entry, durableHealth, stateDo, env, abortSignal,
        attempts, attemptIndex, totalDeadline, subscriptionCtx,
      );
      if (hedge) {
        attemptIndex += hedge.attemptsUsed;
        if (hedge.result) return hedge.result;
        continue;
      }
    }

    for (let deploymentRound = 0; deploymentRound < deployments.length + transportRetriesLeft + semanticRetriesLeft; deploymentRound++) {
      if (attempts.length >= MAX_TOTAL_ATTEMPTS) break;
      if (abortSignal.aborted) break;

      const totalDeadline = startTime + effectiveTotalTimeoutMs;
      if (Date.now() > totalDeadline) break;

      if (attemptIndex > 0) {
        const backoffMs = computeBackoff(attemptIndex, policy.retry.backoffBaseMs, policy.retry.backoffMaxMs);
        const remainingBeforeSleep = totalDeadline - Date.now();
        if (remainingBeforeSleep <= 0) break;
        await sleep(Math.min(backoffMs, remainingBeforeSleep), abortSignal);
        if (abortSignal.aborted) break;
      }

      const routable = filterDeploymentsForAttempt(deployments, durableHealth, policy);
      if (routable.length === 0) break;

      const shuffled = shuffleArray([...routable]);
      const admissionCandidates = shuffled.map((d) => ({
        deploymentId: d.id, keyRef: d.keyRef, rpm: d.rpm,
        maxParallel: d.maxParallelRequests, group: d.group,
      }));

      const admission = await stateDo.admit({
        requestId: envelope.requestId,
        candidates: admissionCandidates,
        rpmLimit: policy.budget.rpmLimit,
        staleInflightSeconds: policy.budget.staleInflightSeconds,
        halfOpenPenalty: policy.health.halfOpenPenalty,
        maxParallelOverride: policy.budget.maxParallelRequests,
        scopeMode: policy.budget.scopeMode,
        learnedConcurrencyEnabled: policy.budget.learnedConcurrencyEnabled,
        learnedConcurrencyTtlSeconds: policy.budget.learnedConcurrencyTtlSeconds,
        quarantineFailureThreshold: policy.health.circuitFailureThreshold,
        suspectThresholdFraction: policy.health.suspectThresholdFraction,
        suspectMaxParallelDivisor: policy.health.suspectMaxParallelDivisor,
        tokenBudgetPerMinute: policy.budget.tokenBudgetPerMinute,
      });

      if (!admission.admitted) break;

      const admittedDeployment = shuffled.find((d) => d.id === admission.deploymentId);
      if (!admittedDeployment) {
        await stateDo.release(admission.reservationId!);
        break;
      }
      const deployment = applyDeploymentRuntimeOverrides(admittedDeployment, env);
      const attemptStart = Date.now();
      let releaseInFinally = true;

      const remainingTotal = totalDeadline - attemptStart;
      const deploymentHealth = durableHealth?.healthScores?.[deployment.id];
      const adaptiveTimeoutMs = resolveAdaptiveAttemptTimeoutMs(policy, deployment, deploymentHealth, envelope.stream);
      const attemptTimeoutMs = resolveAttemptTimeoutMs(adaptiveTimeoutMs, remainingTotal);
      if (attemptTimeoutMs <= 0) break;

      const adapter = getAdapter(deployment.provider, deployment.mode);

      try {
        const apiKey = resolveKey(env, admission.keyRef!, deployment);
        const providerReq = await adapter.buildRequest({
          deployment, body: envelope.body, apiKey,
          requestId: envelope.requestId, subscriptionCtx,
        });

        await stateDo.confirm?.(admission.reservationId!);

        if (envelope.stream) {
          const result = await handleStreamingAttempt(
            envelope, plan, providerReq, policy, admission, deployment,
            group, stateDo, abortSignal, attemptStart, attempts, attemptIndex, adapter,
            attemptTimeoutMs, deploymentHealth,
          );
          if (result !== null) { releaseInFinally = false; return result; }
          break;
        }

        const result = await handleNonStreamingAttempt(
          envelope, plan, providerReq, policy, admission, deployment,
          group, stateDo, abortSignal, attemptStart, attempts, attemptIndex, adapter, attemptTimeoutMs,
        );
        if (result !== null) return result;

        const lastAttempt = attempts[attempts.length - 1];
        if (lastAttempt?.retryable) {
          if (lastAttempt.action === "retry_same" && semanticRetriesLeft > 0) { semanticRetriesLeft--; continue; }
          if (transportRetriesLeft > 0) { transportRetriesLeft--; continue; }
        }
        if (lastAttempt?.failureClass) {
          attemptSequence = promoteProfileFallbacks(
            attemptSequence, modelIndex + 1, lastAttempt.failureClass, plan.selectedGroup,
          );
        }
        break;
      } catch (err) {
        const failure = classifyThrownError(err);
        const cooldownSec = applyPolicyCooldown(failure.failureClass, failure.cooldownSeconds, policy);
        await stateDo.recordFailure(
          admission.deploymentId!, failure.failureClass, cooldownSec,
          policy.health.circuitFailureThreshold, policy.health.circuitDurationSeconds,
          undefined, failureRecordOptions(admission, undefined, policy),
        );
        const isRetryable = policy.retry.retryableFailureClasses.includes(failure.failureClass);
        attempts.push({
          group, deploymentId: admission.deploymentId!, model: deployment.providerModel,
          failureClass: failure.failureClass, failureMessage: failure.details,
          durationMs: Date.now() - attemptStart, inflightAtDispatch: admission.inflightAtDispatch,
          action: "retry_fallback", attemptIndex, retryable: isRetryable,
        });
        emitUnknownUsage(stateDo, {
          requestId: envelope.requestId, attemptIndex, canonicalTarget: plan.canonicalTarget,
          clientId: envelope.clientId, appId: envelope.appId,
          userHash: envelope.userHash, policyId: envelope.policyId,
          policyVersion: envelope.policyVersion, routeVersion: envelope.routeVersion,
          selectedGroup: group, deploymentId: admission.deploymentId!, provider: deployment.provider,
          model: deployment.providerModel, stream: false, finalOutcome: "retry_fallback", usageSource: deployment.provider,
        });
        if (isRetryable && transportRetriesLeft > 0) { transportRetriesLeft--; continue; }
        attemptSequence = promoteProfileFallbacks(
          attemptSequence, modelIndex + 1, failure.failureClass, plan.selectedGroup,
        );
        break;
      } finally {
        if (releaseInFinally) await stateDo.release(admission.reservationId!);
        attemptIndex++;
      }
    }
  }

  if (attempts.length > 0) attempts[attempts.length - 1].fallbackStoppedReason = "all_groups_exhausted";
  return { success: false, failureClass: "unknown_failure", failureMessage: "all attempts exhausted", attempts };
}

// ─── Hedged non-streaming attempt ─────────────────────────────────

async function executeHedgedNonStreamingAttempt(
  envelope: RequestEnvelope,
  plan: ExecutionPlan,
  entry: AttemptSequenceEntry,
  durableHealth: DurableHealthSnapshot | null,
  stateDo: AttemptStateAccessor,
  env: Record<string, unknown>,
  abortSignal: AbortSignal,
  attempts: AttemptRecord[],
  baseAttemptIndex: number,
  totalDeadline: number,
  subscriptionCtx?: SubscriptionContext,
): Promise<{ result: AttemptResult | null; attemptsUsed: number } | null> {
  const lanes = await admitHedgeLanes(
    envelope, entry, durableHealth, stateDo, env, baseAttemptIndex, totalDeadline,
  );
  if (lanes.length < 2) {
    for (const lane of lanes) await stateDo.release(lane.admission.reservationId!);
    return null;
  }

  const hedgeDelayMs = entry.policy.retry.hedge?.hedgeDelayMs ?? 0;
  const controllers = new Map<number, AbortController>();
  const pending = new Map<number, Promise<HedgeLaneOutcome>>();
  let winnerFound = false;

  const launchLane = (lane: HedgeLane) => {
    const controller = linkedAbortController(abortSignal);
    controllers.set(lane.attemptIndex, controller);
    // Cleanup: only remove from controllers map. Do NOT abort the lane's controller
    // here — for streaming winners that abort would terminate the upstream connection
    // while the user is still reading the response. Loser controllers are aborted
    // explicitly in the race loop below.
    const p = runHedgeLane(
      envelope, plan, lane, stateDo, attempts, controller.signal, subscriptionCtx,
    ).finally(() => {
      controllers.delete(lane.attemptIndex);
    });
    pending.set(lane.attemptIndex, p);
    p.then((outcome) => {
      if (outcome.kind === "success" || outcome.kind === "client") winnerFound = true;
    }).catch((e) => logWarn("fire_forget_failed", { error: String(e) }));
  };

  // Launch lanes with optional stagger: after hedgeDelayMs, if a winner is already found
  // skip remaining lanes and release their reservations.
  let launched = 0;
  for (let i = 0; i < lanes.length; i++) {
    if (i > 0 && hedgeDelayMs > 0 && !abortSignal.aborted) {
      await sleep(hedgeDelayMs, abortSignal);
    }
    if (abortSignal.aborted || winnerFound) {
      for (let j = i; j < lanes.length; j++) {
        await stateDo.release(lanes[j].admission.reservationId!);
      }
      break;
    }
    launchLane(lanes[i]);
    launched++;
  }

  let result: AttemptResult | null = null;
  let winnerReservationId: string | null = null;
  while (pending.size > 0 && !abortSignal.aborted) {
    const outcome = await Promise.race(pending.values());
    pending.delete(outcome.lane.attemptIndex);
    if (outcome.kind === "success" || outcome.kind === "client") {
      result = outcome.result;
      winnerReservationId = outcome.lane.admission.reservationId!;
      for (const [attemptIdx, controller] of controllers.entries()) {
        if (attemptIdx !== outcome.lane.attemptIndex) {
          controller.abort();
          const loser = lanes.find((lane) => lane.attemptIndex === attemptIdx);
          if (loser) await stateDo.release(loser.admission.reservationId!);
        }
      }
      break;
    }
  }

  if (result) {
    await Promise.allSettled([...pending.values()]);
  } else if (abortSignal.aborted) {
    for (const controller of controllers.values()) controller.abort();
    await Promise.allSettled([...pending.values()]);
  }

  // Non-streaming winners are complete here. Streaming winners release after
  // the response body finishes so long streams do not lose their inflight slot
  // immediately after pre-buffer commit.
  if (winnerReservationId && !envelope.stream) {
    await stateDo.release(winnerReservationId);
  }

  return { result, attemptsUsed: launched };
}

async function admitHedgeLanes(
  envelope: RequestEnvelope,
  entry: AttemptSequenceEntry,
  durableHealth: DurableHealthSnapshot | null,
  stateDo: AttemptStateAccessor,
  env: Record<string, unknown>,
  baseAttemptIndex: number,
  totalDeadline: number,
): Promise<HedgeLane[]> {
  const maxCandidates = Math.max(2, entry.policy.retry.hedge?.maxCandidates ?? 2);
  const remaining = filterDeploymentsForAttempt([...entry.deployments], durableHealth, entry.policy);
  const lanes: HedgeLane[] = [];

  while (lanes.length < maxCandidates && remaining.length > 0) {
    const admission = await stateDo.admit({
      requestId: envelope.requestId,
      candidates: remaining.map((d) => ({
        deploymentId: d.id, keyRef: d.keyRef, rpm: d.rpm,
        maxParallel: d.maxParallelRequests, group: d.group,
      })),
      rpmLimit: entry.policy.budget.rpmLimit,
      staleInflightSeconds: entry.policy.budget.staleInflightSeconds,
      halfOpenPenalty: entry.policy.health.halfOpenPenalty,
      maxParallelOverride: entry.policy.budget.maxParallelRequests,
      scopeMode: entry.policy.budget.scopeMode,
      learnedConcurrencyEnabled: entry.policy.budget.learnedConcurrencyEnabled,
      learnedConcurrencyTtlSeconds: entry.policy.budget.learnedConcurrencyTtlSeconds,
      quarantineFailureThreshold: entry.policy.health.circuitFailureThreshold,
      suspectThresholdFraction: entry.policy.health.suspectThresholdFraction,
      suspectMaxParallelDivisor: entry.policy.health.suspectMaxParallelDivisor,
      tokenBudgetPerMinute: entry.policy.budget.tokenBudgetPerMinute,
    });
    if (!admission.admitted || !admission.deploymentId) break;

    const idx = remaining.findIndex((d) => d.id === admission.deploymentId);
    if (idx < 0) {
      await stateDo.release(admission.reservationId!);
      break;
    }
    const [selected] = remaining.splice(idx, 1);
    const deployment = applyDeploymentRuntimeOverrides(selected, env);
    const remainingTotal = totalDeadline - Date.now();
    if (remainingTotal <= 0) {
      await stateDo.release(admission.reservationId!);
      break;
    }
    const deploymentHealth = durableHealth?.healthScores?.[deployment.id];
    const attemptTimeoutMs = resolveAttemptTimeoutMs(
      resolveAdaptiveAttemptTimeoutMs(entry.policy, deployment, deploymentHealth, envelope.stream),
      remainingTotal,
    );
    if (attemptTimeoutMs <= 0) {
      await stateDo.release(admission.reservationId!);
      break;
    }
    lanes.push({
      group: entry.group,
      policy: entry.policy,
      admission,
      deployment,
      apiKey: resolveKey(env, admission.keyRef!, deployment),
      attemptIndex: baseAttemptIndex + lanes.length,
      attemptTimeoutMs,
      deploymentHealth,
    });
  }

  return lanes;
}

async function runHedgeLane(
  envelope: RequestEnvelope,
  plan: ExecutionPlan,
  lane: HedgeLane,
  stateDo: AttemptStateAccessor,
  attempts: AttemptRecord[],
  signal: AbortSignal,
  subscriptionCtx?: SubscriptionContext,
): Promise<HedgeLaneOutcome> {
  let releaseInFinally = true;
  const adapter = getAdapter(lane.deployment.provider, lane.deployment.mode);
  const attemptStart = Date.now();
  try {
    const providerReq: ProviderRequest = await adapter.buildRequest({
      deployment: lane.deployment, body: envelope.body, apiKey: lane.apiKey,
      requestId: envelope.requestId, subscriptionCtx,
    });
    await stateDo.confirm?.(lane.admission.reservationId!);
    const result = envelope.stream
      ? await handleStreamingAttempt(
          envelope, plan, providerReq, lane.policy, lane.admission, lane.deployment,
          lane.group, stateDo, signal, attemptStart, attempts, lane.attemptIndex,
          adapter, lane.attemptTimeoutMs, lane.deploymentHealth,
        )
      : await handleNonStreamingAttempt(
          envelope, plan, providerReq, lane.policy, lane.admission, lane.deployment,
          lane.group, stateDo, signal, attemptStart, attempts, lane.attemptIndex,
          adapter, lane.attemptTimeoutMs,
        );
    if (result) {
      releaseInFinally = false;
      return { kind: result.success ? "success" : "client", result, lane };
    }
    return { kind: "failure", lane };
  } catch (err) {
    if (signal.aborted) return { kind: "canceled", lane };
    const failure = classifyThrownError(err);
    const cooldownSec = applyPolicyCooldown(failure.failureClass, failure.cooldownSeconds, lane.policy);
    await stateDo.recordFailure(
      lane.admission.deploymentId!, failure.failureClass, cooldownSec,
      lane.policy.health.circuitFailureThreshold, lane.policy.health.circuitDurationSeconds,
      undefined, failureRecordOptions(lane.admission, undefined, lane.policy),
    );
    attempts.push({
      group: lane.group, deploymentId: lane.admission.deploymentId!, model: lane.deployment.providerModel,
      failureClass: failure.failureClass, failureMessage: failure.details,
      durationMs: Date.now() - attemptStart, inflightAtDispatch: lane.admission.inflightAtDispatch,
      action: "retry_fallback", attemptIndex: lane.attemptIndex,
      retryable: lane.policy.retry.retryableFailureClasses.includes(failure.failureClass),
    });
    emitUnknownUsage(stateDo, {
      requestId: envelope.requestId, attemptIndex: lane.attemptIndex, canonicalTarget: plan.canonicalTarget,
      clientId: envelope.clientId, appId: envelope.appId,
      userHash: envelope.userHash, policyId: envelope.policyId,
          policyVersion: envelope.policyVersion, routeVersion: envelope.routeVersion,
      selectedGroup: lane.group, deploymentId: lane.admission.deploymentId!, provider: lane.deployment.provider,
      model: lane.deployment.providerModel, stream: false, finalOutcome: "retry_fallback", usageSource: lane.deployment.provider,
    });
    return { kind: "failure", lane };
  } finally {
    if (releaseInFinally) await stateDo.release(lane.admission.reservationId!);
  }
}

function isHedgeEligible(
  entry: AttemptSequenceEntry,
  envelope: RequestEnvelope,
  durableHealth: DurableHealthSnapshot | null,
): boolean {
  const hedge = entry.policy.retry.hedge;
  if (!hedge?.enabled || hedge.maxCandidates < 2) return false;
  if (envelope.hasTools || envelope.hasStrictTools) return false;
  const nvidiaDeployments = entry.deployments.filter((d) => d.provider === "nvidia_nim" && !d.hidden);
  if (nvidiaDeployments.length < 2) return false;
  if (!hedge.onlyWhenSuspect) return true;
  return nvidiaDeployments.some((d) => isDeploymentSuspectForHedge(d.id, durableHealth));
}

function isDeploymentSuspectForHedge(deploymentId: string, durableHealth: DurableHealthSnapshot | null): boolean {
  const circuitState = durableHealth?.circuits?.[deploymentId]?.state;
  if (circuitState === "suspect" || circuitState === "half_open" || circuitState === "open") return true;
  const metrics = durableHealth?.healthScores?.[deploymentId]?.rollingMetrics;
  if ((metrics?.timeoutRate ?? 0) >= 0.5 || (metrics?.invalidSuccessRate ?? 0) >= 0.5) return true;
  if ((metrics?.p95FirstByteLatencyMs ?? 0) >= 20_000) return true;
  return false;
}

function linkedAbortController(parent: AbortSignal): AbortController {
  const controller = new AbortController();
  if (parent.aborted) {
    controller.abort();
    return controller;
  }
  parent.addEventListener("abort", () => controller.abort(), { once: true });
  return controller;
}

// ─── Non-streaming attempt handler ────────────────────────────────

async function handleNonStreamingAttempt(
  envelope: RequestEnvelope,
  plan: ExecutionPlan,
  providerReq: { url: string; method: string; headers: Record<string, string>; body: string },
  policy: Policy,
  admission: AdmissionResponse,
  deployment: Deployment,
  group: string,
  stateDo: AttemptStateAccessor,
  abortSignal: AbortSignal,
  attemptStart: number,
  attempts: AttemptRecord[],
  currentAttemptIndex: number,
  adapter: ProviderAdapter,
  attemptTimeoutMs: number,
): Promise<AttemptResult | null> {
  const providerResp = await executeProviderRequest(providerReq, {
    signal: abortSignal, timeoutMs: attemptTimeoutMs,
  });
  const durationMs = Date.now() - attemptStart;

  // HTTP error from provider
  if (providerResp.status >= 400) {
    return handleProviderHttpError(
      providerResp, durationMs, envelope, plan, policy, admission,
      deployment, group, stateDo, attempts, currentAttemptIndex, adapter, false,
    );
  }

  if (!providerResp.json) {
    await stateDo.recordFailure(
      admission.deploymentId!, "malformed_response", 0,
      policy.health.circuitFailureThreshold, policy.health.circuitDurationSeconds,
      undefined, failureRecordOptions(admission, "high", policy),
    );
    attempts.push({
      group, deploymentId: admission.deploymentId!, model: deployment.providerModel,
      failureClass: "malformed_response", failureMessage: "provider returned non-json success body",
      durationMs, inflightAtDispatch: admission.inflightAtDispatch,
      action: "retry_fallback", attemptIndex: currentAttemptIndex,
      statusCode: providerResp.status, retryable: policy.retry.retryableFailureClasses.includes("malformed_response"),
    });
    emitUnknownUsage(stateDo, {
      requestId: envelope.requestId, attemptIndex: currentAttemptIndex, canonicalTarget: plan.canonicalTarget,
      clientId: envelope.clientId, appId: envelope.appId,
      userHash: envelope.userHash, policyId: envelope.policyId,
          policyVersion: envelope.policyVersion, routeVersion: envelope.routeVersion,
      selectedGroup: group, deploymentId: admission.deploymentId!, provider: deployment.provider,
      model: deployment.providerModel, stream: false, finalOutcome: "retry_fallback", usageSource: deployment.provider,
    });
    return null;
  }

  // Evaluate response quality
  const evalConfig: ResponseEvaluationConfig = {
    enableSemanticValidation: policy.response.enableSemanticValidation,
    enableToolRepair: policy.response.enableToolRepair,
    enableSpecialTokenDetection: policy.response.enableSpecialTokenDetection,
    enableRepetitionDetection: policy.response.enableRepetitionDetection,
    semanticMinChars: policy.response.semanticMinChars,
    semanticMinEntropy: policy.response.semanticMinEntropy,
    semanticMinPrintableRatio: policy.response.semanticMinPrintableRatio,
    repetitionMaxRatio: policy.response.repetitionMaxRatio,
    stripReasoningFromSuccess: policy.request.stripReasoningFromSuccess,
    enableSchemaAwareRepair: policy.response.enableSchemaAwareRepair,
    repairPolicy: buildRepairPolicy(policy),
  };

  const normalizedJson = adapter.needsStreamWrapping
    ? adapter.normalizeResponse(providerResp.json, envelope.requestId)
    : providerResp.json;

  const evaluation = evaluateResponse(envelope.body, normalizedJson, evalConfig);

  if (evaluation.action === "accept" || evaluation.action === "repair_accept") {
    await stateDo.recordSuccess(admission.deploymentId!, policy.health.circuitSuccessThreshold, durationMs, {
      emaAlpha: policy.health.latencyEmaAlpha,
      penaltyFactor: policy.health.latencyPenaltyFactor,
      warmupSamples: policy.health.latencyWarmupSamples,
    }, { inflightAtDispatch: admission.inflightAtDispatch });
    await stateDo.recordRouteDispatch?.(plan.canonicalTarget, dispatchRequestClass(envelope), group).catch((e) => logWarn("fire_forget_failed", { error: String(e) }));

    const responseBody = evaluation.repairedResponse ?? normalizedJson;
    const headers = forwardUpstreamHeaders(providerResp.headers);
    headers["Content-Type"] = "application/json";
    headers["X-Request-Id"] = envelope.requestId;
    for (const key of Object.keys(headers)) {
      const lower = key.toLowerCase();
      if (lower === "content-length" || lower === "content-encoding" || lower === "transfer-encoding") {
        delete headers[key];
      }
    }

    if (evaluation.repairRecords && evaluation.repairRecords.length > 0) {
      headers["X-Tool-Input-Repaired"] = "true";
      headers["X-Tool-Input-Repaired-Count"] = String(evaluation.repairRecords.length);
      const kinds = [...new Set(evaluation.repairRecords.map((r) => r.repairKind))];
      headers["X-Tool-Input-Repaired-Kinds"] = kinds.join(",");
      logInfo("tool_input_repaired", {
        requestId: envelope.requestId, model: deployment.providerModel,
        deploymentId: admission.deploymentId, repairCount: evaluation.repairRecords.length,
        repairKinds: kinds, repairs: evaluation.repairRecords.map((r) => ({
          tool: r.toolName, field: r.fieldPath, kind: r.repairKind,
        })),
      });
    }

    const resp = new Response(JSON.stringify(responseBody), { status: 200, headers });
    const usage = (responseBody as Record<string, unknown>).usage as Record<string, number> | undefined;
    const tokenUsage = normalizeProviderUsage(usage, deployment.provider);

    if (tokenUsage.kind !== "unknown" && admission.keyRef) {
      stateDo.recordTokenUsage?.(
        admission.keyRef,
        tokenUsage.promptTokens,
        tokenUsage.completionTokens,
      ).catch((e) => logWarn("fire_forget_failed", { error: String(e) }));
    }

    attempts.push({
      group, deploymentId: admission.deploymentId!, model: deployment.providerModel,
      durationMs, inflightAtDispatch: admission.inflightAtDispatch,
      action: evaluation.action, attemptIndex: currentAttemptIndex,
      statusCode: providerResp.status, retryable: false, tokenUsage,
    });

    emitUsageEvent(stateDo, {
      requestId: envelope.requestId, attemptIndex: currentAttemptIndex, timestamp: Date.now(),
      clientId: envelope.clientId, appId: envelope.appId,
      userHash: envelope.userHash, policyId: envelope.policyId,
          policyVersion: envelope.policyVersion, routeVersion: envelope.routeVersion,
      canonicalTarget: plan.canonicalTarget, selectedGroup: group,
      deploymentId: admission.deploymentId!, provider: deployment.provider,
      model: deployment.providerModel, stream: false, finalOutcome: evaluation.action,
      ...usageEventFromTokenUsage(tokenUsage),
    });

    return { success: true, response: resp, attempts };
  }

  if (evaluation.action === "fail_client") {
    const clientUsage = normalizeProviderUsage(
      (normalizedJson as Record<string, unknown>).usage as Record<string, number> | undefined,
      deployment.provider,
    );
    attempts.push({
      group, deploymentId: admission.deploymentId!, model: deployment.providerModel,
      failureClass: evaluation.failureClass, failureMessage: evaluation.failureMessage,
      durationMs, inflightAtDispatch: admission.inflightAtDispatch,
      action: "fail_client", attemptIndex: currentAttemptIndex,
      statusCode: providerResp.status, retryable: false,
      fallbackStoppedReason: "client_error", tokenUsage: clientUsage,
    });
    emitUsageEvent(stateDo, {
      requestId: envelope.requestId, attemptIndex: currentAttemptIndex, timestamp: Date.now(),
      clientId: envelope.clientId, appId: envelope.appId,
      userHash: envelope.userHash, policyId: envelope.policyId,
          policyVersion: envelope.policyVersion, routeVersion: envelope.routeVersion,
      canonicalTarget: plan.canonicalTarget, selectedGroup: group,
      deploymentId: admission.deploymentId!, provider: deployment.provider,
      model: deployment.providerModel, stream: false, finalOutcome: "fail_client",
      ...usageEventFromTokenUsage(clientUsage),
    });
    const errResp = new Response(
      openAIErrorJson(evaluation.failureClass, evaluation.failureMessage ?? "request failed", envelope.requestId),
      { status: 400, headers: { "Content-Type": "application/json" } },
    );
    return { success: false, response: errResp, failureClass: evaluation.failureClass, attempts };
  }

  // Semantic retry
  const retryUsage = normalizeProviderUsage(
    (normalizedJson as Record<string, unknown>).usage as Record<string, number> | undefined,
    deployment.provider,
  );
  logInfo("evaluation_retry", {
    requestId: envelope.requestId, model: deployment.providerModel,
    deploymentId: admission.deploymentId, action: evaluation.action,
    failureClass: evaluation.failureClass, failureMessage: evaluation.failureMessage, durationMs,
  });
  await stateDo.recordFailure(
    admission.deploymentId!, evaluation.failureClass!, 0,
    policy.health.circuitFailureThreshold, policy.health.circuitDurationSeconds,
    policy.health.suspectThresholdFraction, failureRecordOptions(admission, evaluation.semanticSeverity, policy),
  );
  const isRetryable = evaluation.action === "retry_same";
  attempts.push({
    group, deploymentId: admission.deploymentId!, model: deployment.providerModel,
    failureClass: evaluation.failureClass, failureMessage: evaluation.failureMessage,
    durationMs, inflightAtDispatch: admission.inflightAtDispatch,
    action: evaluation.action, attemptIndex: currentAttemptIndex,
    statusCode: providerResp.status, retryable: isRetryable, tokenUsage: retryUsage,
  });
  emitUsageEvent(stateDo, {
    requestId: envelope.requestId, attemptIndex: currentAttemptIndex, timestamp: Date.now(),
    clientId: envelope.clientId, appId: envelope.appId,
    userHash: envelope.userHash, policyId: envelope.policyId,
          policyVersion: envelope.policyVersion, routeVersion: envelope.routeVersion,
    canonicalTarget: plan.canonicalTarget, selectedGroup: group,
    deploymentId: admission.deploymentId!, provider: deployment.provider,
    model: deployment.providerModel, stream: false, finalOutcome: evaluation.action,
    ...usageEventFromTokenUsage(retryUsage),
  });
  return null;
}

// ─── Streaming attempt handler ────────────────────────────────────

async function handleStreamingAttempt(
  envelope: RequestEnvelope,
  plan: ExecutionPlan,
  providerReq: { url: string; method: string; headers: Record<string, string>; body: string },
  policy: Policy,
  admission: AdmissionResponse,
  deployment: Deployment,
  group: string,
  stateDo: AttemptStateAccessor,
  abortSignal: AbortSignal,
  attemptStart: number,
  attempts: AttemptRecord[],
  currentAttemptIndex: number,
  adapter: ProviderAdapter,
  attemptTimeoutMs: number,
  deploymentHealth?: Partial<HealthSnapshot>,
): Promise<AttemptResult | null> {
  try {
    const streamResult = await executeStreamingProviderRequest(providerReq, {
      signal: abortSignal,
      timeoutMs: attemptTimeoutMs,
      streaming: true,
    });

    if (streamResult.status >= 400) {
      const errorBody = await streamResult.response.text();
      const respHeaders = headersToRecord(streamResult.headers);
      return handleProviderHttpError(
        { status: streamResult.status, body: errorBody, headers: respHeaders, json: null },
        Date.now() - attemptStart, envelope, plan, policy, admission,
        deployment, group, stateDo, attempts, currentAttemptIndex, adapter, true,
      );
    }

    let upstreamBody: ReadableStream<Uint8Array> | null = streamResult.response.body;
    if (adapter.needsStreamWrapping && adapter.streamFormat && upstreamBody) {
      upstreamBody = wrapSubscriptionStream(
        upstreamBody, adapter.streamFormat as SubscriptionStreamFormat,
        envelope.requestId, deployment.providerModel,
      );
    }

    const preBufferConfig: PreBufferConfig = {
      preBufferChunks: 4,
      enableThinkingLeakStripping: policy.request.stripReasoningFromSuccess,
      enableSpecialTokenRepair: policy.response.enableSpecialTokenDetection,
      heartbeatIntervalMs: 15000,
      maxSilenceMs: policy.deadline.streamIdleTimeoutSeconds * 1000,
      firstTokenTimeoutMs: resolveAdaptiveFirstTokenTimeoutMs(policy, deploymentHealth),
      hardTimeoutMs: Math.min(resolveAdaptiveStreamHardTimeoutMs(policy, deploymentHealth), attemptTimeoutMs),
      signal: abortSignal,
    };

    const { readable, ready, done } = executeStreamWithPreBuffer(
      { body: upstreamBody, status: streamResult.status, headers: streamResult.headers },
      preBufferConfig,
    );

    const preBufferReady = await ready;
    const firstByteLatencyMs = preBufferReady.committed ? Date.now() - attemptStart : undefined;
    if (!preBufferReady.committed) {
      await stateDo.recordFailure(
        admission.deploymentId!, "stream_interruption", 5,
        policy.health.circuitFailureThreshold, policy.health.circuitDurationSeconds,
        undefined, failureRecordOptions(admission, undefined, policy),
      );
      attempts.push({
        group, deploymentId: admission.deploymentId!, model: deployment.providerModel,
        failureClass: "stream_interruption", failureMessage: preBufferReady.abortReason ?? "stream_aborted_before_commit",
        durationMs: Date.now() - attemptStart, inflightAtDispatch: admission.inflightAtDispatch,
        action: "retry_fallback",
        attemptIndex: currentAttemptIndex, statusCode: streamResult.status, retryable: true,
      });
      emitUnknownUsage(stateDo, {
        requestId: envelope.requestId, attemptIndex: currentAttemptIndex, canonicalTarget: plan.canonicalTarget,
        clientId: envelope.clientId, appId: envelope.appId,
        userHash: envelope.userHash, policyId: envelope.policyId,
          policyVersion: envelope.policyVersion, routeVersion: envelope.routeVersion,
        selectedGroup: group, deploymentId: admission.deploymentId!, provider: deployment.provider,
        model: deployment.providerModel, stream: true, finalOutcome: "stream_abort", usageSource: deployment.provider,
      });
      return null;
    }

    const streamHeaders: Record<string, string> = {
      ...forwardUpstreamHeaders(headersToRecord(streamResult.headers)),
    };
    streamHeaders["Content-Type"] = "text/event-stream";
    streamHeaders["Cache-Control"] = "no-cache";
    streamHeaders["Connection"] = "keep-alive";
    streamHeaders["X-Request-Id"] = envelope.requestId;
    streamHeaders["X-Accel-Buffering"] = "no";

    const resp = new Response(readable, { status: 200, headers: streamHeaders });

    let streamReservationReleased = false;
    const releaseStreamReservation = () => {
      if (streamReservationReleased) return;
      streamReservationReleased = true;
      stateDo.release(admission.reservationId!).catch((e) => logWarn("fire_forget_failed", { error: String(e) }));
    };

    const streamReleaseDeadlineMs = preBufferConfig.hardTimeoutMs + 30_000;
    const releaseDeadlineTimer = setTimeout(releaseStreamReservation, streamReleaseDeadlineMs);

    done.then((streamDone: StreamDone) => {
      if (streamDone.wasAborted) {
        stateDo.recordFailure(
          admission.deploymentId!, "stream_interruption", 5,
          policy.health.circuitFailureThreshold, policy.health.circuitDurationSeconds,
          undefined, failureRecordOptions(admission, undefined, policy),
        ).catch((e) => logWarn("fire_forget_failed", { error: String(e) }));
      } else {
        const streamDurationMs = Date.now() - attemptStart;
        stateDo.recordSuccess(admission.deploymentId!, policy.health.circuitSuccessThreshold, streamDurationMs, {
          emaAlpha: policy.health.latencyEmaAlpha,
          penaltyFactor: policy.health.latencyPenaltyFactor,
          warmupSamples: policy.health.latencyWarmupSamples,
        }, { firstByteLatencyMs, inflightAtDispatch: admission.inflightAtDispatch }).catch((e) => logWarn("fire_forget_failed", { error: String(e) }));
        stateDo.recordRouteDispatch?.(plan.canonicalTarget, dispatchRequestClass(envelope), group).catch((e) => logWarn("fire_forget_failed", { error: String(e) }));
      }
      const streamUsage = streamDone.usage ?? { kind: "unknown" as const, source: "streaming" };
      if (streamUsage.kind !== "unknown" && admission.keyRef) {
        stateDo.recordTokenUsage?.(
          admission.keyRef,
          streamUsage.promptTokens,
          streamUsage.completionTokens,
        ).catch((e) => logWarn("fire_forget_failed", { error: String(e) }));
      }
      const attempt = attempts.find((a) => a.attemptIndex === currentAttemptIndex);
      if (attempt) attempt.tokenUsage = streamUsage;
      stateDo.storeUsageEvent?.({
        requestId: envelope.requestId, attemptIndex: currentAttemptIndex, timestamp: Date.now(),
        clientId: envelope.clientId, appId: envelope.appId,
        userHash: envelope.userHash, policyId: envelope.policyId,
          policyVersion: envelope.policyVersion, routeVersion: envelope.routeVersion,
        canonicalTarget: plan.canonicalTarget, selectedGroup: group,
        deploymentId: admission.deploymentId!, provider: deployment.provider,
        model: deployment.providerModel, stream: true,
        finalOutcome: streamDone.wasAborted ? "stream_abort" : "success",
        ...usageEventFromTokenUsage(streamUsage),
      }).catch((e) => logWarn("fire_forget_failed", { error: String(e) }));
    }).finally(() => {
      clearTimeout(releaseDeadlineTimer);
      releaseStreamReservation();
    }).catch((e) => logWarn("fire_forget_failed", { error: String(e) }));

    attempts.push({
      group, deploymentId: admission.deploymentId!, model: deployment.providerModel,
      durationMs: Date.now() - attemptStart, firstByteLatencyMs, inflightAtDispatch: admission.inflightAtDispatch,
      action: "accept",
      attemptIndex: currentAttemptIndex, statusCode: streamResult.status, retryable: false,
    });

    return { success: true, response: resp, attempts };
  } catch (err) {
    const failure = classifyThrownError(err);
    const cooldownSec = applyPolicyCooldown(failure.failureClass, failure.cooldownSeconds, policy);
    await stateDo.recordFailure(
      admission.deploymentId!, failure.failureClass, cooldownSec,
      policy.health.circuitFailureThreshold, policy.health.circuitDurationSeconds,
      undefined, failureRecordOptions(admission, undefined, policy),
    );
    attempts.push({
      group, deploymentId: admission.deploymentId!, model: deployment.providerModel,
      failureClass: failure.failureClass, failureMessage: failure.details,
      durationMs: Date.now() - attemptStart, inflightAtDispatch: admission.inflightAtDispatch,
      action: "retry_fallback",
      attemptIndex: currentAttemptIndex, retryable: policy.retry.retryableFailureClasses.includes(failure.failureClass),
    });
    emitUnknownUsage(stateDo, {
      requestId: envelope.requestId, attemptIndex: currentAttemptIndex, canonicalTarget: plan.canonicalTarget,
      clientId: envelope.clientId, appId: envelope.appId,
      userHash: envelope.userHash, policyId: envelope.policyId,
          policyVersion: envelope.policyVersion, routeVersion: envelope.routeVersion,
      selectedGroup: group, deploymentId: admission.deploymentId!, provider: deployment.provider,
      model: deployment.providerModel, stream: true, finalOutcome: "retry_fallback", usageSource: deployment.provider,
    });
    return null;
  }
}

// ─── Shared HTTP error handling ───────────────────────────────────

interface HttpErrorInput {
  status: number;
  body: string;
  headers: Record<string, string>;
  json: Record<string, unknown> | null;
}

function handleProviderHttpError(
  providerResp: HttpErrorInput,
  durationMs: number,
  envelope: RequestEnvelope,
  plan: ExecutionPlan,
  policy: Policy,
  admission: AdmissionResponse,
  deployment: Deployment,
  group: string,
  stateDo: AttemptStateAccessor,
  attempts: AttemptRecord[],
  currentAttemptIndex: number,
  adapter: ProviderAdapter,
  isStream: boolean,
): null {
  let failureClass: FailureClass;
  let cooldownSec: number;

  let providerResult: ProviderFailureClassification | null = adapter.classifyFailure(providerResp.status, providerResp.body);
  if (providerResult && providerResult.failureClass === "unknown_failure") providerResult = null;

  if (providerResp.status === 429 && providerResult) {
    failureClass = providerResult.failureClass;
    const rl = classifyRateLimit(providerResp.status, providerResp.body, providerResp.headers);
    cooldownSec = rl?.cooldownSeconds ?? providerResult.cooldownSeconds;
  } else if (providerResp.status === 429) {
    const rl = classifyRateLimit(providerResp.status, providerResp.body, providerResp.headers);
    if (rl) { failureClass = rl.failureClass; cooldownSec = rl.cooldownSeconds; }
    else { failureClass = "rate_limit_overload"; cooldownSec = 60; }
  } else {
    let pf = providerResult;
    if (!pf) pf = classifyProviderFailure(providerResp.status, providerResp.body, deployment.provider);
    failureClass = pf.failureClass;
    cooldownSec = pf.cooldownSeconds;
  }

  cooldownSec = applyPolicyCooldown(failureClass, cooldownSec, policy);

  stateDo.recordFailure(
    admission.deploymentId!, failureClass, cooldownSec,
    policy.health.circuitFailureThreshold, policy.health.circuitDurationSeconds,
    policy.health.suspectThresholdFraction, failureRecordOptions(admission, undefined, policy),
  ).catch((e) => logWarn("fire_forget_failed", { error: String(e) }));

  const isRetryable = policy.retry.retryableFailureClasses.includes(failureClass);
  attempts.push({
    group, deploymentId: admission.deploymentId!, model: deployment.providerModel,
    failureClass, failureMessage: (providerResp.body ?? "").slice(0, 200),
    durationMs, inflightAtDispatch: admission.inflightAtDispatch,
    action: "retry_fallback", attemptIndex: currentAttemptIndex,
    statusCode: providerResp.status, retryable: isRetryable,
  });

  emitUnknownUsage(stateDo, {
    requestId: envelope.requestId, attemptIndex: currentAttemptIndex, canonicalTarget: plan.canonicalTarget,
    clientId: envelope.clientId, appId: envelope.appId,
    userHash: envelope.userHash, policyId: envelope.policyId,
          policyVersion: envelope.policyVersion, routeVersion: envelope.routeVersion,
    selectedGroup: group, deploymentId: admission.deploymentId!, provider: deployment.provider,
    model: deployment.providerModel, stream: isStream, finalOutcome: "retry_fallback", usageSource: deployment.provider,
  });

  return null;
}

// ─── Health ordering ──────────────────────────────────────────────

async function orderAttemptSequenceWithHealth(
  entries: AttemptSequenceEntry[],
  plan: Pick<ExecutionPlan, "canonicalTarget">,
  envelope: RequestEnvelope,
  stateDo: Pick<AttemptStateAccessor, "getHealth" | "getRecentRouteDispatch">,
): Promise<{ sequence: AttemptSequenceEntry[]; health: DurableHealthSnapshot | null }> {
  if (!stateDo.getHealth) return { sequence: entries, health: null };

  let health: DurableHealthSnapshot;
  try { health = await stateDo.getHealth(); } catch { return { sequence: entries, health: null }; }
  if (entries.length <= 1) return { sequence: entries, health };

  const now = Date.now();
  const requestClass = dispatchRequestClass(envelope);
  const requestShape = toRequestShape(envelope);
  const indexed = entries.map((entry, index) => {
    const groupHealth = scoreGroupForOrdering(entry, health, now, requestShape);
    return { entry, index, score: groupHealth.score, available: groupHealth.available };
  });

  const available = indexed.filter((item) => item.available && Number.isFinite(item.score));
  if (available.length === 0) return { sequence: entries, health };

  let recentGroup: string | undefined;
  if (stateDo.getRecentRouteDispatch) {
    try {
      const recent = await stateDo.getRecentRouteDispatch(
        plan.canonicalTarget, requestClass, MANIFEST.plannerSettings.recentDispatchTtlSeconds,
      );
      if (recent?.group) recentGroup = recent.group;
    } catch { recentGroup = undefined; }
  }

  const withEffectiveScores = available.map((item) => ({
    ...item,
    effectiveScore: item.entry.group === recentGroup
      ? Math.max(0, item.score - MANIFEST.plannerSettings.recentDispatchBonus)
      : item.score,
  }));
  const primary = indexed[0];
  const best = withEffectiveScores.reduce((current, item) => {
    if (item.effectiveScore !== current.effectiveScore) return item.effectiveScore < current.effectiveScore ? item : current;
    return item.index < current.index ? item : current;
  });

  let selected = best;
  if (primary?.available && Number.isFinite(primary.score)) {
    const primaryEffectiveScore = primary.entry.group === recentGroup
      ? Math.max(0, primary.score - MANIFEST.plannerSettings.recentDispatchBonus)
      : primary.score;
    if (primary.entry.group === best.entry.group || primaryEffectiveScore <= best.effectiveScore + MANIFEST.plannerSettings.healthFallbackMargin) {
      selected = { ...primary, effectiveScore: primaryEffectiveScore };
    }
  }

  const selectedGroup = selected.entry.group;
  const sortedRest = withEffectiveScores.filter((item) => item.entry.group !== selectedGroup).sort((a, b) => {
    if (a.effectiveScore !== b.effectiveScore) return a.effectiveScore - b.effectiveScore;
    return a.index - b.index;
  });
  const unavailableRest = indexed.filter((item) => (!item.available || !Number.isFinite(item.score)) && item.entry.group !== selectedGroup).sort((a, b) => a.index - b.index);

  return {
    sequence: [selected.entry, ...sortedRest.map((item) => item.entry), ...unavailableRest.map((item) => item.entry)],
    health,
  };
}

export async function orderAttemptSequenceByDurableHealth(
  entries: AttemptSequenceEntry[],
  plan: Pick<ExecutionPlan, "canonicalTarget">,
  envelope: RequestEnvelope,
  stateDo: Pick<AttemptStateAccessor, "getHealth" | "getRecentRouteDispatch">,
): Promise<AttemptSequenceEntry[]> {
  return (await orderAttemptSequenceWithHealth(entries, plan, envelope, stateDo)).sequence;
}

function scoreGroupForOrdering(entry: AttemptSequenceEntry, health: DurableHealthSnapshot, now: number, requestShape: "chat" | "tool" | "multi_tool"): { available: boolean; score: number } {
  const scores = entry.deployments.map((d) => scoreDeploymentForOrdering(d, entry.policy, health, now, requestShape)).filter((s): s is number => s !== null);
  if (scores.length === 0) return { available: false, score: Number.POSITIVE_INFINITY };
  return { available: true, score: Math.min(...scores) };
}

function scoreDeploymentForOrdering(deployment: Deployment, policy: Policy, health: DurableHealthSnapshot, now: number, requestShape: "chat" | "tool" | "multi_tool"): number | null {
  const cooldown = health.cooldowns?.[deployment.id];
  if (typeof cooldown?.until === "number" && cooldown.until > now) return null;

  const circuit = health.circuits?.[deployment.id];
  const isOpen = circuit?.state === "open";
  const halfOpenAfter = circuit?.halfOpenAfter;
  const isHalfOpen = circuit?.state === "half_open" || (isOpen && typeof halfOpenAfter === "number" && halfOpenAfter <= now);
  if (isOpen && !isHalfOpen) return null;

  const learned = health.learnedLimits?.[deployment.id];
  const learnedActive = learned && (!learned.expiresAt || learned.expiresAt > now);
  let effectiveMaxParallel = learnedActive && typeof learned.maxParallel === "number"
    ? Math.min(learned.maxParallel, deployment.maxParallelRequests) : deployment.maxParallelRequests;
  if (policy.budget.maxParallelRequests && policy.budget.maxParallelRequests > 0)
    effectiveMaxParallel = Math.min(effectiveMaxParallel, policy.budget.maxParallelRequests);
  if (isHalfOpen)
    effectiveMaxParallel = 1;
  const inflightCount = health.inflight?.[deployment.id]?.count ?? 0;
  if (inflightCount >= effectiveMaxParallel) return null;

  const snapshot = coerceHealthSnapshot(health.healthScores?.[deployment.id], now);
  const baseScore = deploymentPenalty(snapshot, now, requestShape !== "chat", requestShape);
  return isHalfOpen ? baseScore + policy.health.halfOpenPenalty : baseScore;
}

function coerceHealthSnapshot(snapshot: Partial<HealthSnapshot> | undefined, now: number): HealthSnapshot | undefined {
  if (!snapshot || typeof snapshot.score !== "number") return undefined;
  return {
    score: snapshot.score,
    lastSuccessAt: typeof snapshot.lastSuccessAt === "number" ? snapshot.lastSuccessAt : undefined,
    lastFailureAt: typeof snapshot.lastFailureAt === "number" ? snapshot.lastFailureAt : undefined,
    failureClass: typeof snapshot.failureClass === "string" ? snapshot.failureClass : undefined,
    updatedAt: typeof snapshot.updatedAt === "number" ? snapshot.updatedAt : now,
    successCount: typeof snapshot.successCount === "number" ? snapshot.successCount : 0,
    failureCount: typeof snapshot.failureCount === "number" ? snapshot.failureCount : 0,
    consecutiveFailureCount: typeof snapshot.consecutiveFailureCount === "number" ? snapshot.consecutiveFailureCount : 0,
    latencyEmaMs: typeof snapshot.latencyEmaMs === "number" ? snapshot.latencyEmaMs : null,
    latencySampleCount: typeof snapshot.latencySampleCount === "number" ? snapshot.latencySampleCount : 0,
    rollingMetrics: snapshot.rollingMetrics,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Caps per-attempt timeout by remaining total deadline budget (no artificial floor past budget). */
export function resolveAttemptTimeoutMs(adaptiveTimeoutMs: number, remainingTotalMs: number): number {
  const remaining = Math.max(0, remainingTotalMs);
  if (remaining === 0) return 0;
  return Math.min(adaptiveTimeoutMs, remaining);
}

export function resolveAdaptiveAttemptTimeoutMs(
  policy: Policy,
  deployment: Deployment,
  snapshot: Partial<HealthSnapshot> | undefined,
  stream: boolean,
): number {
  const deploymentTimeoutMs = (stream ? deployment.streamTimeout : deployment.timeout) * 1000;
  const baseTimeoutMs = deploymentTimeoutMs || policy.deadline.attemptTimeoutSeconds * 1000;
  const p95Total = snapshot?.rollingMetrics?.p95TotalLatencyMs;
  if (typeof p95Total === "number" && p95Total > 0 && (snapshot?.rollingMetrics?.recentOutcomeCount ?? 0) >= policy.health.latencyWarmupSamples) {
    return clampDeadline(p95Total * 3, baseTimeoutMs);
  }
  return computeAdaptiveDeadlineMs(
    typeof snapshot?.latencyEmaMs === "number" ? snapshot.latencyEmaMs : null,
    typeof snapshot?.latencySampleCount === "number" ? snapshot.latencySampleCount : 0,
    policy.health.latencyWarmupSamples,
    baseTimeoutMs,
  );
}

export function resolveAdaptiveFirstTokenTimeoutMs(
  policy: Policy,
  snapshot: Partial<HealthSnapshot> | undefined,
): number {
  const baseTimeoutMs = policy.deadline.firstTokenTimeoutSeconds * 1000;
  const p95FirstByte = snapshot?.rollingMetrics?.p95FirstByteLatencyMs;
  if (typeof p95FirstByte !== "number" || p95FirstByte <= 0) return baseTimeoutMs;
  return clampDeadline(p95FirstByte * 2, baseTimeoutMs, 1_000);
}

export function resolveAdaptiveStreamHardTimeoutMs(
  policy: Policy,
  snapshot: Partial<HealthSnapshot> | undefined,
): number {
  const baseTimeoutMs = (policy.deadline.streamHardTimeoutSeconds ?? policy.deadline.attemptTimeoutSeconds) * 1000;
  const p95Total = snapshot?.rollingMetrics?.p95TotalLatencyMs;
  if (typeof p95Total !== "number" || p95Total <= 0) return baseTimeoutMs;
  return clampDeadline(p95Total * 3, baseTimeoutMs);
}

function clampDeadline(candidateMs: number, baseTimeoutMs: number, minimumMs = 5_000): number {
  return Math.round(Math.min(Math.max(candidateMs, minimumMs), baseTimeoutMs * 3.0));
}

function dispatchRequestClass(envelope: RequestEnvelope): string {
  if (envelope.surface === "responses") {
    return envelope.stream ? "responses_stream" : "responses";
  }
  if (envelope.stream) {
    if (envelope.hasStrictTools) return "strict_tool_stream";
    if (envelope.hasTools) return "tool_stream";
    return "chat_stream";
  }
  if (envelope.hasStrictTools) return "strict_tool";
  if (envelope.hasTools) return "tool";
  return "chat";
}

function toRequestShape(envelope: RequestEnvelope): "chat" | "tool" | "multi_tool" {
  if (envelope.isMultiTool) return "multi_tool";
  if (envelope.hasTools || envelope.hasStrictTools) return "tool";
  return "chat";
}

function failureRecordOptions(
  admission: AdmissionResponse,
  semanticSeverity?: "low" | "medium" | "high",
  policy?: Policy,
) {
  return {
    inflightAtDispatch: admission.inflightAtDispatch,
    maxParallelAtDispatch: admission.effectiveMaxParallel,
    semanticSeverity,
    transportCooldownThreshold: policy?.health.transportCooldownThreshold,
  };
}

function filterDeploymentsForAttempt(
  deployments: Deployment[],
  durableHealth: DurableHealthSnapshot | null,
  policy: Policy,
): Deployment[] {
  const filterState = buildFilterStateFromHealth(durableHealth);
  const result = filterCandidates(
    deployments,
    filterState,
    Date.now(),
    policy.budget.scopeMode,
    filterOptionsForPolicy(policy),
  );
  return result.passed.map((entry) => entry.deployment);
}

function resolveKey(env: Record<string, unknown>, keyRef: string, deployment?: Deployment): string {
  if (deployment?.provider === "chatgpt" && deployment.mode === "responses") {
    return resolveChatGPTSubscriptionAuthMaterial(env);
  }
  return (env[keyRef] as string) ?? "";
}

function resolveChatGPTSubscriptionAuthMaterial(env: Record<string, unknown>): string {
  const authJson = envString(env, "CHATGPT_AUTH_JSON");
  if (authJson) {
    return requireStructuredChatGPTAuthMaterial(authJson, "CHATGPT_AUTH_JSON");
  }

  const authFileContent = envString(env, "CHATGPT_AUTH_FILE");
  if (authFileContent) {
    return requireStructuredChatGPTAuthMaterial(
      authFileContent,
      "CHATGPT_AUTH_FILE",
      "CHATGPT_AUTH_FILE must contain structured ChatGPT subscription auth JSON in the Worker runtime; "
      + "filesystem paths must be resolved before deployment",
    );
  }

  throw new SubscriptionTokenError(
    "ChatGPT Responses subscription auth requires structured CHATGPT_AUTH_JSON or CHATGPT_AUTH_FILE material",
    "oauth_session_failure",
  );
}

function requireStructuredChatGPTAuthMaterial(
  authMaterial: string,
  credentialName: string,
  nonJsonMessage?: string,
): string {
  if (!isChatGPTSubscriptionAuthJsonText(authMaterial)) {
    throw new SubscriptionTokenError(
      nonJsonMessage ?? `${credentialName} must contain structured ChatGPT subscription auth JSON`,
      "oauth_session_failure",
    );
  }
  resolveChatGPTSubscriptionAuth(authMaterial, { credentialName });
  return authMaterial;
}

function envString(env: Record<string, unknown>, key: string): string {
  const value = env[key];
  return typeof value === "string" ? value.trim() : "";
}

const FORWARDABLE_UPSTREAM_HEADERS = [
  "x-ratelimit-remaining-requests", "x-ratelimit-remaining-tokens",
  "x-ratelimit-limit-requests", "x-ratelimit-limit-tokens",
  "x-ratelimit-reset-requests", "x-ratelimit-reset-tokens",
  "ratelimit-remaining", "ratelimit-limit", "ratelimit-reset",
];

function forwardUpstreamHeaders(headers: Record<string, string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (FORWARDABLE_UPSTREAM_HEADERS.includes(key.toLowerCase())) result[key] = value;
  }
  return result;
}

function shuffleArray<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

function computeBackoff(attemptIndex: number, baseMs: number, maxMs: number): number {
  const exp = Math.min(attemptIndex - 1, 6);
  const rawBackoff = baseMs * Math.pow(2, exp);
  const capped = Math.min(rawBackoff, maxMs);
  const jitter = capped * 0.25 * (Math.random() * 2 - 1);
  return Math.max(baseMs, Math.round(capped + jitter));
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

function headersToRecord(headers: Headers): Record<string, string> {
  const result: Record<string, string> = {};
  headers.forEach((value, key) => { result[key.toLowerCase()] = value; });
  return result;
}

function emitUsageEvent(stateObj: AttemptStateAccessor, event: UsageEventPayload): void {
  stateObj.storeUsageEvent?.(event).catch((e) => logWarn("fire_forget_failed", { error: String(e) }));
}

function emitUnknownUsage(stateObj: AttemptStateAccessor, params: {
  requestId: string; attemptIndex: number; canonicalTarget: string;
  clientId?: string; appId?: string; userHash?: string; policyId?: string;
  policyVersion?: string; routeVersion?: string;
  selectedGroup: string; deploymentId: string; provider: string;
  model: string | undefined; stream: boolean; finalOutcome: string; usageSource: string;
}): void {
  emitUsageEvent(stateObj, {
    requestId: params.requestId, attemptIndex: params.attemptIndex, timestamp: Date.now(),
    clientId: params.clientId, appId: params.appId,
    userHash: params.userHash, policyId: params.policyId,
    policyVersion: params.policyVersion, routeVersion: params.routeVersion,
    canonicalTarget: params.canonicalTarget, selectedGroup: params.selectedGroup,
    deploymentId: params.deploymentId, provider: params.provider, model: params.model ?? "",
    stream: params.stream, finalOutcome: params.finalOutcome, usageKind: "unknown",
    promptTokens: null, completionTokens: null, totalTokens: null, usageSource: params.usageSource,
  });
}

function buildRepairPolicy(policy: Policy): import("../nim/repair/schema-aware").RepairPolicyConfig {
  const rp = policy.response.repairPolicy;
  return {
    allowDestructive: rp.allowDestructiveByDefault,
    enumAliases: rp.enumAliases,
    toolNameAliases: rp.toolNameAliases,
    relationalDefaults: rp.relationalDefaults,
    configuredPatterns: buildConfiguredPatterns(rp.conservativeToolPatterns ?? []),
  };
}
