// HTTP request handler and router.

import { MANIFEST } from "../config/manifest";
import type { FailureClass } from "../config/schema";
import { planRequest, applyTransforms, type RequestEnvelope } from "../planner/planner";
import { executeAttemptLoop } from "../attempts/attempt-loop";
import { sanitizeClientMetadata, signMetadata } from "../security/internal-metadata";
import { recordReceipt, type RouteReceipt } from "../observability/receipt";
import { readJsonBodyWithLimit, validateBodySize, validateChatRequest, validateContentType } from "./validation";
export { verifyProxyAuth, verifyAdminAuth } from "./auth";
import { checkRateLimit, extractClientIp } from "../security/rate-limit";
import { logInfo, logWarn } from "../observability/logging";
import { buildHealthReport, verifyHealthAuth } from "../probes/health-endpoint";
import { finalizeFailedRequest } from "../observability/failed-request-finalizer";
import { runCanaryProbes, type CanaryHealthSnapshot, type CanaryHistoryRow } from "../probes/canary";
import { hasHiddenOnlyTypedContent } from "../nim/repair/content-parts";
import type { OAuthAccountAccessor } from "../providers/anthropic-subscription";
import type { ControlPlaneStateDO } from "../state/control-plane-state";

const CONTROL_PLANE_STATE_NAME = "control-plane";
const HOUR_MS = 3600000;
const MAX_USAGE_ROLLUP_HOURS_PER_REQUEST = 24 * 31;

function generateRequestId(): string {
  return `req_${crypto.randomUUID().replace(/-/g, "")}`;
}

export function migrateFunctionsToTools(body: Record<string, unknown>): void {
  if (!body.functions || !Array.isArray(body.functions)) return;
  if (body.tools && Array.isArray(body.tools)) return;
  const functions = body.functions as Array<Record<string, unknown>>;
  body.tools = functions.map((fn) => ({
    type: "function",
    function: fn,
  }));
  if (body.function_call && !body.tool_choice) {
    if (typeof body.function_call === "string") {
      body.tool_choice = body.function_call;
    } else if (typeof body.function_call === "object") {
      const fc = body.function_call as Record<string, unknown>;
      if (fc.name) body.tool_choice = { type: "function", function: { name: fc.name } };
    }
  }
  delete body.functions;
  delete body.function_call;
}

export async function handleChatCompletions(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
): Promise<Response> {
  const requestId = generateRequestId();

  // Content-Type check
  const ctCheck = validateContentType(request);
  if (!ctCheck.valid) {
    return errorResponse(ctCheck.error!, 415, requestId);
  }

  // Body size check — guard against NaN from malformed Content-Length
  const clRaw = request.headers.get("Content-Length");
  const clNum = clRaw ? parseInt(clRaw, 10) : null;
  const sizeCheck = validateBodySize(clNum !== null && Number.isFinite(clNum) ? clNum : null);
  if (!sizeCheck.valid) {
    return errorResponse(sizeCheck.error!, 413, requestId);
  }

  // Parse request
  const parsedBody = await readJsonBodyWithLimit(request);
  if (!parsedBody.ok) {
    return errorResponse(parsedBody.error, parsedBody.status, requestId);
  }
  let body = parsedBody.value;

  // Migrate legacy functions → tools before validation so tool limits apply uniformly
  migrateFunctionsToTools(body);

  // Input validation
  const validation = validateChatRequest(body);
  if (!validation.valid) {
    return errorResponse(validation.error!, 400, requestId);
  }

  // Sanitize client metadata
  body = sanitizeClientMetadata(body);
  if (hasHiddenOnlyTypedContent(body)) {
    return errorResponse({
      message: "typed content contains only hidden reasoning or metadata",
      type: "invalid_request",
      code: "hidden_only_typed_content",
    }, 400, requestId);
  }

  const model = body.model as string;

  // Build envelope
  const envelope: RequestEnvelope = {
    requestId,
    originalModel: model,
    body,
    stream: body.stream === true,
    hasTools: !!(body.tools && (body.tools as unknown[]).length > 0),
    hasStrictTools: body.tool_choice === "required" || body.tool_choice === "any",
    isMultiTool: Array.isArray(body.tools) && (body.tools as unknown[]).length >= 2,
    hasTypedContent: detectTypedContent(body),
    requiresJsonMode: body.response_format !== undefined,
    requiresReasoning: !!(body.reasoning_effort || (body.extra_body as Record<string, unknown>)?.reasoning_effort),
  };

  logInfo("request_start", { requestId, model, stream: envelope.stream, hasTools: envelope.hasTools });

  // Plan from static manifest and durable state effects only. Process-local
  // recovery memory is not authoritative in Workers.
  const plan = planRequest(envelope);
  if (!plan) {
    return errorResponse({
      message: `Unknown model: ${model}`,
      type: "invalid_request",
      code: "unknown_model",
    }, 400, requestId);
  }

  // Apply transforms (strip unsupported params, clamp tokens, strip reasoning, etc.)
  envelope.body = applyTransforms(envelope.body, plan.transforms);

  // Sign internal metadata for response integrity
  const signingKey = env.METADATA_SIGNING_KEY;
  const metaPayload = { requestId, canonicalTarget: plan.canonicalTarget, selectedGroup: plan.selectedGroup, originalModel: envelope.originalModel };
  const metaSignature = signingKey ? await signMetadata(metaPayload, signingKey) : undefined;

  // Get state DO (shard by selected group for balance)
  const stateId = env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME);
  const stateDo = env.CONTROL_PLANE_STATE.get(stateId);
  const subscriptionCtx = buildSubscriptionContext(env);

  // Execute attempt loop
  const result = await executeAttemptLoop(
    envelope,
    plan,
    stateDo as unknown as Parameters<typeof executeAttemptLoop>[2],
    env as unknown as Record<string, unknown>, // dynamic key lookup in resolveKey
    AbortSignal.timeout(plan.selectedPolicy.deadline.totalTimeoutSeconds * 1000),
    subscriptionCtx,
  );

  // Record receipt
  const finalOutcome: RouteReceipt["finalOutcome"] =
    result.success && result.attempts[result.attempts.length - 1]?.action === "repair_accept"
      ? "repaired_success"
      : result.success
        ? "success"
        : result.attempts.some((a) => a.action === "fail_client")
          ? "client_error"
          : "exhausted";

  const receipt: RouteReceipt = {
    requestId: envelope.requestId,
    timestamp: Date.now(),
    originalModel: envelope.originalModel,
    canonicalTarget: plan.canonicalTarget,
    selectedGroup: plan.selectedGroup,
    fallbackGroups: plan.fallbackSequence.map((f) => f.group),
    attempts: result.attempts,
    finalOutcome,
    stream: envelope.stream,
    totalDurationMs: result.attempts.reduce((sum, a) => sum + a.durationMs, 0),
  };

  recordReceipt(receipt);

  // Persist to DO (fire-and-forget for latency)
  const receiptDo = env.CONTROL_PLANE_STATE.get(
    env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME),
  );
  receiptDo.storeReceipt(receipt).catch((e) => logWarn("receipt_store_failed", { error: String(e) }));

  // Finalize failed requests (exhausted / client_error)
  const finalized = finalizeFailedRequest(receipt);
  if (finalized) {
    const stateDo = env.CONTROL_PLANE_STATE.get(
      env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME),
    );
    stateDo.storeFailedRequest({
      requestId: finalized.summary.requestId,
      timestamp: finalized.summary.timestamp,
      originalModel: finalized.summary.originalModel,
      canonicalTarget: finalized.summary.canonicalTarget,
      selectedGroup: finalized.summary.selectedGroup,
      finalOutcome: finalized.summary.finalOutcome,
      failureClass: finalized.summary.failureClass,
      attemptsCount: finalized.summary.attemptsCount,
      summaryJson: JSON.stringify(finalized.summary),
      receiptJson: JSON.stringify(finalized.sanitizedReceipt),
    }).catch((e) => logWarn("failed_request_store_failed", { error: String(e) }));
  }

  logInfo("request_end", {
    requestId,
    outcome: finalOutcome,
    attempts: result.attempts.length,
    totalDurationMs: result.attempts.reduce((sum, a) => sum + a.durationMs, 0),
  });

  if (result.response) {
    // Inject request ID header into the response
    const respHeaders = new Headers(result.response.headers);
    respHeaders.set("X-Request-Id", requestId);
    if (metaSignature) respHeaders.set("X-Nim-Signature", metaSignature);
    return new Response(result.response.body, {
      status: result.response.status,
      statusText: result.response.statusText,
      headers: respHeaders,
    });
  }

  // Exhausted
  logWarn("request_exhausted", { requestId, failureClass: result.failureClass, attempts: result.attempts.length });
  return errorResponse({
    message: result.failureMessage ?? "all attempts exhausted",
    type: result.failureClass ?? "exhausted",
    code: "exhausted",
  }, 502, requestId);
}

export async function handleAdminHealth(
  request: Request,
  env: Env,
): Promise<Response> {
  // Auth check
  const healthToken = healthAuthToken(env);
  if (!healthToken || !verifyHealthAuth(request, healthToken)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const stateId = env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME);
  const stateDo = env.CONTROL_PLANE_STATE.get(stateId);
  const report = await buildHealthReport(stateDo);
  return jsonResponse(report);
}

export async function handleAdminReceipts(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const receiptDo = env.CONTROL_PLANE_STATE.get(
    env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME),
  );

  if (id) {
    const receipt = await receiptDo.getReceipt(id);
    if (!receipt) return jsonResponse({ error: "not found" }, 404);
    return jsonResponse(receipt);
  }
  return jsonResponse(await receiptDo.getRecentReceipts());
}

export async function handleAdminClearCooldowns(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const deploymentId = url.searchParams.get("deployment_id") ?? undefined;

  if (deploymentId) {
    const allDeployments = Object.values(MANIFEST.deploymentsByGroup).flat();
    if (!allDeployments.some((d) => d.id === deploymentId)) {
      return jsonResponse({ error: "unknown deployment_id" }, 400);
    }
  }

  const stateId = env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME);
  const stateDo = env.CONTROL_PLANE_STATE.get(stateId);
  await stateDo.clearCooldowns(deploymentId);
  return jsonResponse({ ok: true });
}

export async function handleAdminCanaryTrigger(
  request: Request,
  env: Env,
): Promise<Response> {
  const defaultPolicy = MANIFEST.defaultPolicy;
  const stateId = env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME);
  const stateDo = env.CONTROL_PLANE_STATE.get(stateId);
  let canaryHealth: CanaryHealthSnapshot | null = null;
  let recentCanaryResults: CanaryHistoryRow[] = [];
  try { canaryHealth = await stateDo.getHealth() as CanaryHealthSnapshot; } catch {}
  try { recentCanaryResults = await stateDo.getCanaryResults(100) as CanaryHistoryRow[]; } catch {}
  const canaryContext = {
    force: true,
    health: canaryHealth,
    recentResults: recentCanaryResults,
  };

  const results = await runCanaryProbes(
    env as unknown as Record<string, unknown>,
    {
      recordSuccess: async (deploymentId: string) => {
        await stateDo.recordSuccess(deploymentId, defaultPolicy.health.circuitSuccessThreshold);
      },
      recordFailure: async (
        deploymentId: string,
        failureClass: FailureClass,
        cooldownSeconds: number,
        circuitThreshold: number,
        circuitDurationSeconds: number,
      ) => {
        await stateDo.recordFailure(
          deploymentId, failureClass, cooldownSeconds, circuitThreshold, circuitDurationSeconds,
        );
      },
    },
    undefined,
    defaultPolicy.health.probeMaxInflight,
    canaryContext,
  );

  // Persist results to DO
  for (const r of results) {
    stateDo.storeCanaryResult({
      deploymentId: r.deploymentId,
      group: r.group,
      success: r.success,
      failureClass: r.failureClass,
      latencyMs: r.latencyMs,
      statusCode: r.status,
    }).catch((e) => logWarn("canary_result_store_failed", { error: String(e) }));
  }

  return jsonResponse({
    triggeredAt: new Date().toISOString(),
    total: results.length,
    passed: results.filter((r) => r.success).length,
    failed: results.filter((r) => !r.success).length,
    results,
  });
}

export async function handleAdminCanaryResults(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Math.min(100, Math.max(1, Number.isFinite(limitParam) ? limitParam : 50));
  const stateDo = env.CONTROL_PLANE_STATE.get(
    env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME),
  ) as unknown as ControlPlaneStateDO;
  const results = await stateDo.getCanaryResults(limit);
  return jsonResponse({ results, total: results.length });
}

export async function handleAdminUsage(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const windowParam = url.searchParams.get("window") ?? "1h";
  const group = url.searchParams.get("group") ?? undefined;
  const deploymentId = url.searchParams.get("deployment_id") ?? undefined;
  const granularity = url.searchParams.get("granularity") ?? "rollup";

  const stateDo = env.CONTROL_PLANE_STATE.get(
    env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME),
  ) as unknown as ControlPlaneStateDO;

  const windowMs = parseWindow(windowParam);
  const since = Date.now() - windowMs;

  if (granularity === "raw") {
    const events = await stateDo.queryUsageEvents({
      group,
      deploymentId,
      since,
      limit: 1000,
    });
    return jsonResponse({ events, total: events.length });
  }

  const until = Date.now();
  const rollupSince = Math.floor(since / HOUR_MS) * HOUR_MS;
  await computeUsageRollupsForWindow(stateDo, rollupSince, until);

  const rollups = await stateDo.queryRollups({
    group,
    deploymentId,
    since: rollupSince,
  });

  const totals = rollups.reduce<Record<string, number>>((acc, r) => ({
    requests: acc.requests + Number(r.requests ?? 0),
    knownRequests: acc.knownRequests + Number(r.knownRequests ?? 0),
    unknownRequests: acc.unknownRequests + Number(r.unknownRequests ?? 0),
    promptTokens: acc.promptTokens + Number(r.promptTokens ?? 0),
    completionTokens: acc.completionTokens + Number(r.completionTokens ?? 0),
    totalTokens: acc.totalTokens + Number(r.totalTokens ?? 0),
  }), {
    requests: 0, knownRequests: 0, unknownRequests: 0,
    promptTokens: 0, completionTokens: 0, totalTokens: 0,
  });

  return jsonResponse({
    window: windowParam,
    since,
    rollupSince,
    until,
    totals,
    byGroup: rollups,
  });
}

async function computeUsageRollupsForWindow(
  stateDo: ControlPlaneStateDO,
  since: number,
  until: number,
): Promise<void> {
  const lastHour = Math.floor(until / HOUR_MS) * HOUR_MS;
  const requestedHours = Math.max(1, Math.floor((lastHour - since) / HOUR_MS) + 1);
  const boundedHours = Math.min(requestedHours, MAX_USAGE_ROLLUP_HOURS_PER_REQUEST);
  const firstHour = lastHour - (boundedHours - 1) * HOUR_MS;

  for (let hour = firstHour; hour <= lastHour; hour += HOUR_MS) {
    await stateDo.computeHourlyRollups(hour);
  }
}

function parseWindow(window: string): number {
  const match = window.match(/^(\d+)(h|d|m)$/);
  if (!match) return 3600000;
  const value = parseInt(match[1]);
  if (value <= 0) return 3600000;
  switch (match[2]) {
    case "m": return value * 60000;
    case "h": return value * 3600000;
    case "d": return value * 86400000;
    default: return 3600000;
  }
}

export async function handleNimHealth(
  request: Request,
  env: Env,
): Promise<Response> {
  const healthToken = healthAuthToken(env);
  if (!healthToken || !verifyHealthAuth(request, healthToken)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const stateId = env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME);
  const stateDo = env.CONTROL_PLANE_STATE.get(stateId);
  const report = await buildHealthReport(stateDo);
  return jsonResponse(report);
}

export async function handleNimFailures(
  request: Request,
  env: Env,
): Promise<Response> {
  const healthToken = healthAuthToken(env);
  if (!healthToken || !verifyHealthAuth(request, healthToken)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }

  const url = new URL(request.url);
  const requestId = url.searchParams.get("request_id");
  const group = url.searchParams.get("group");
  const failureClass = url.searchParams.get("failure_class");

  const stateDo = env.CONTROL_PLANE_STATE.get(
    env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME),
  );

  if (requestId) {
    const rows = await (stateDo as unknown as ControlPlaneStateDO).queryFailedRequests({ requestId, limit: 1 });
    if (rows.length === 0) return jsonResponse({ error: "not found" }, 404);
    return jsonResponse(rows[0]);
  }

  const failures = await (stateDo as unknown as ControlPlaneStateDO).queryFailedRequests({
    group: group ?? undefined,
    failureClass: failureClass ?? undefined,
    limit: 100,
  });
  return jsonResponse({ failures, total: failures.length });
}

export function handlePing(): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ─── Rate limiting ────────────────────────────────────────────────

export function checkRequestRateLimit(request: Request): Response | null {
  const clientIp = extractClientIp(request);
  const result = checkRateLimit(clientIp);
  if (!result.allowed) {
    return new Response(JSON.stringify({
      error: {
        message: "Rate limit exceeded",
        type: "rate_limit",
        code: "rate_limit_exceeded",
      },
    }), {
      status: 429,
      headers: {
        "Content-Type": "application/json",
        "Retry-After": String(Math.ceil((result.resetAt - Date.now()) / 1000)),
        "X-RateLimit-Remaining": "0",
        "X-RateLimit-Reset": String(Math.ceil(result.resetAt / 1000)),
      },
    });
  }
  return null;
}

// ─── Auth middleware ──────────────────────────────────────────────


function healthAuthToken(env: Env): string | undefined {
  return env.NIM_HEALTH_TOKEN
    || env.ADMIN_API_KEY
    || env.LITELLM_MASTER_KEY
    || undefined;
}

function buildSubscriptionContext(env: Env) {
  const anthropicClientId = env.ANTHROPIC_CLIENT_ID;
  if (!anthropicClientId) return undefined;
  const oauthDo = env.OAUTH_ACCOUNT.get(
    env.OAUTH_ACCOUNT.idFromName("anthropic-subscription"),
  ) as unknown as OAuthAccountAccessor;
  return {
    anthropicOAuth: {
      accessor: oauthDo,
      clientId: anthropicClientId,
      clientSecret: env.ANTHROPIC_CLIENT_SECRET,
    },
  };
}

// ─── Helpers ──────────────────────────────────────────────────────

function detectTypedContent(body: Record<string, unknown>): boolean {
  const messages = body.messages as Array<Record<string, unknown>> | undefined;
  if (!messages?.length) return false;
  for (const msg of messages) {
    if (Array.isArray(msg.content)) {
      for (const part of msg.content) {
        if (typeof part === "object" && part !== null) {
          const type = (part as Record<string, unknown>).type;
          if (type === "image_url" || type === "input_image" || type === "image" || type === "audio" || type === "input_audio") return true;
        }
      }
    }
  }
  return false;
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function errorResponse(
  error: { message: string; type: string; code: string },
  status: number,
  requestId: string,
): Response {
  return new Response(JSON.stringify({
    error: {
      message: error.message,
      type: error.type,
      code: error.code,
    },
    request_id: requestId,
  }), {
    status,
    headers: {
      "Content-Type": "application/json",
      "X-Request-Id": requestId,
    },
  });
}
