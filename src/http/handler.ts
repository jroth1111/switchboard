// HTTP request handler and router.

import { MANIFEST, ROUTE_MANIFEST_VERSION } from "../config/manifest";
import type { FailureClass, Surface } from "../config/schema";
import { planRequest, applyTransforms, type RequestEnvelope } from "../planner/planner";
import { executeAttemptLoop } from "../attempts/attempt-loop";
import { sanitizeClientMetadata, signMetadata } from "../security/internal-metadata";
import { recordReceipt, sanitizeReceipt, type RouteReceipt } from "../observability/receipt";
import { readJsonBodyWithLimit, validateBodySize, validateChatRequest, validateContentType, validateResponsesRequest } from "./validation";
export { verifyProxyAuth, verifyAdminAuth } from "./auth";
import { logInfo, logWarn } from "../observability/logging";
import { buildHealthReport, verifyHealthAuth } from "../probes/health-endpoint";
import { finalizeFailedRequest } from "../observability/failed-request-finalizer";
import { runCanaryProbes, type CanaryHealthSnapshot, type CanaryHistoryRow } from "../probes/canary";
import { hasHiddenOnlyTypedContent } from "../nim/repair/content-parts";
import type { OAuthAccountAccessor } from "../providers/anthropic-subscription";
import type { ControlPlaneStateDO } from "../state/control-plane-state";
import { applyClientPolicyToPlan, authorizeModelForClient, type ClientIdentity } from "./client-policy";

const CONTROL_PLANE_STATE_NAME = "control-plane";
const HOUR_MS = 3600000;
const MAX_USAGE_ROLLUP_HOURS_PER_REQUEST = 24 * 31;
const DEFAULT_FAILED_REQUEST_LIMIT = 100;
const MAX_FAILED_REQUEST_LIMIT = 500;

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
  client: ClientIdentity,
): Promise<Response> {
  const requestId = generateRequestId();

  // Content-Type check
  const ctCheck = validateContentType(request);
  if (!ctCheck.valid) {
    return errorResponse(ctCheck.error!, 415, requestId, client);
  }

  // Body size check — guard against NaN from malformed Content-Length
  const clRaw = request.headers.get("Content-Length");
  const clNum = clRaw ? parseInt(clRaw, 10) : null;
  const sizeCheck = validateBodySize(clNum !== null && Number.isFinite(clNum) ? clNum : null);
  if (!sizeCheck.valid) {
    return errorResponse(sizeCheck.error!, 413, requestId, client);
  }

  // Parse request
  const parsedBody = await readJsonBodyWithLimit(request);
  if (!parsedBody.ok) {
    return errorResponse(parsedBody.error, parsedBody.status, requestId, client);
  }
  let body = parsedBody.value;

  // Migrate legacy functions → tools before validation so tool limits apply uniformly
  migrateFunctionsToTools(body);

  // Input validation
  const validation = validateChatRequest(body);
  if (!validation.valid) {
    return errorResponse(validation.error!, 400, requestId, client);
  }

  // Sanitize client metadata
  body = sanitizeClientMetadata(body);
  if (hasHiddenOnlyTypedContent(body)) {
    return errorResponse({
      message: "typed content contains only hidden reasoning or metadata",
      type: "invalid_request",
      code: "hidden_only_typed_content",
    }, 400, requestId, client);
  }

  return handlePreparedModelRequest({ body, env, client, requestId, surface: "chat_completions" });
}

export async function handleResponses(
  request: Request,
  env: Env,
  _ctx: ExecutionContext,
  client: ClientIdentity,
): Promise<Response> {
  const requestId = generateRequestId();

  const ctCheck = validateContentType(request);
  if (!ctCheck.valid) {
    return errorResponse(ctCheck.error!, 415, requestId, client);
  }

  const clRaw = request.headers.get("Content-Length");
  const clNum = clRaw ? parseInt(clRaw, 10) : null;
  const sizeCheck = validateBodySize(clNum !== null && Number.isFinite(clNum) ? clNum : null);
  if (!sizeCheck.valid) {
    return errorResponse(sizeCheck.error!, 413, requestId, client);
  }

  const parsedBody = await readJsonBodyWithLimit(request);
  if (!parsedBody.ok) {
    return errorResponse(parsedBody.error, parsedBody.status, requestId, client);
  }

  let body = parsedBody.value;
  const validation = validateResponsesRequest(body);
  if (!validation.valid) {
    return errorResponse(validation.error!, 400, requestId, client);
  }

  body = sanitizeClientMetadata(body);
  return handlePreparedModelRequest({ body, env, client, requestId, surface: "responses" });
}

async function handlePreparedModelRequest(params: {
  body: Record<string, unknown>;
  env: Env;
  client: ClientIdentity;
  requestId: string;
  surface: Surface;
}): Promise<Response> {
  const { body, env, client, requestId, surface } = params;
  const model = body.model as string;
  const modelAuth = authorizeModelForClient(model, client);
  if (!modelAuth.allowed) {
    const denialReceipt: RouteReceipt = {
      requestId,
      timestamp: Date.now(),
      originalModel: model,
      clientId: client.clientId,
      appId: client.appId,
      userHash: client.userHash,
      policyId: client.policyId,
      policyVersion: client.policyVersion,
      routeVersion: ROUTE_MANIFEST_VERSION,
      denialReason: modelAuth.reason,
      routeDecision: {
        canonicalization: {
          requestedModel: model,
          canonicalTarget: "denied",
          reason: modelAuth.reason,
        },
        requestClass: { authorization: "denied_before_planning" },
        selectedGroup: "denied",
        selectedReason: modelAuth.reason,
        fallbackGroups: [],
        candidates: [],
        transforms: [],
      },
      canonicalTarget: "denied",
      selectedGroup: "denied",
      fallbackGroups: [],
      attempts: [],
      finalOutcome: "client_error",
      stream: body.stream === true,
      totalDurationMs: 0,
    };
    recordReceipt(denialReceipt);
    persistDenialReceipt(env, denialReceipt);
    return errorResponse({
      message: `Model is not allowed for client: ${model}`,
      type: "invalid_request",
      code: modelAuth.reason,
    }, 403, requestId, client);
  }

  if (surface === "chat_completions" && isChatGPTResponsesModel(model)) {
    return errorResponse({
      message: "ChatGPT subscription models require the /v1/responses surface",
      type: "invalid_request",
      code: "unsupported_surface",
    }, 400, requestId, client);
  }

  // Build envelope
  const envelope: RequestEnvelope = {
    requestId,
    originalModel: model,
    surface,
    clientId: client.clientId,
    appId: client.appId,
    userHash: client.userHash,
    policyId: client.policyId,
    policyVersion: client.policyVersion,
    routeVersion: ROUTE_MANIFEST_VERSION,
    body,
    stream: body.stream === true,
    hasTools: !!(body.tools && (body.tools as unknown[]).length > 0),
    hasStrictTools: body.tool_choice === "required" || body.tool_choice === "any",
    isMultiTool: Array.isArray(body.tools) && (body.tools as unknown[]).length >= 2,
    hasTypedContent: surface === "responses" ? detectResponsesTypedContent(body) : detectTypedContent(body),
    requiresJsonMode: surface === "chat_completions" ? body.response_format !== undefined : body.text !== undefined,
    requiresReasoning: !!(body.reasoning || body.reasoning_effort || (body.extra_body as Record<string, unknown>)?.reasoning_effort),
  };

  logInfo("request_start", {
    requestId, model, stream: envelope.stream, hasTools: envelope.hasTools,
    clientId: client.clientId, appId: client.appId, policyId: client.policyId,
  });

  // Plan from static manifest and durable state effects only. Process-local
  // recovery memory is not authoritative in Workers.
  let plan = planRequest(envelope);
  if (!plan) {
    return errorResponse({
      message: surface === "responses" ? `Model does not support /v1/responses: ${model}` : `Unknown model: ${model}`,
      type: "invalid_request",
      code: surface === "responses" ? "unsupported_surface" : "unknown_model",
    }, 400, requestId, client);
  }
  plan = applyClientPolicyToPlan(plan, client);

  // Apply transforms (strip unsupported params, clamp tokens, strip reasoning, etc.)
  envelope.body = applyTransforms(envelope.body, plan.transforms);

  // Sign internal metadata for response integrity
  const signingKey = env.METADATA_SIGNING_KEY;
  const metaPayload = {
    requestId,
    canonicalTarget: plan.canonicalTarget,
    selectedGroup: plan.selectedGroup,
    originalModel: envelope.originalModel,
    clientId: client.clientId,
    appId: client.appId,
    policyId: client.policyId,
    policyVersion: client.policyVersion,
    routeVersion: ROUTE_MANIFEST_VERSION,
  };
  const metaSignature = signingKey ? await signMetadata(metaPayload, signingKey) : undefined;

  // Get state DO (shard by selected group for balance)
  const stateId = env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME);
  const stateDo = env.CONTROL_PLANE_STATE.get(stateId);
  const subscriptionCtx = buildSubscriptionContext(env);
  const clientAdmission = await (stateDo as unknown as ControlPlaneStateDO).admitClientRequest({
    requestId,
    clientId: client.clientId,
    appId: client.appId,
    userHash: client.userHash,
    rpmLimit: client.policy.rpmLimit ?? null,
    maxConcurrency: client.policy.maxConcurrency ?? null,
    tokenBudgetPerMinute: client.policy.tokenBudgetPerMinute ?? null,
    estimatedTokens: estimateClientTokenCost(envelope.body, client.policy.tokenBudgetPerMinute),
  });
  if (!clientAdmission.admitted) {
    const reason = clientAdmission.reason ?? "client_limit_exceeded";
    const denialReceipt: RouteReceipt = {
      requestId,
      timestamp: Date.now(),
      originalModel: model,
      clientId: client.clientId,
      appId: client.appId,
      userHash: client.userHash,
      policyId: client.policyId,
      policyVersion: client.policyVersion,
      routeVersion: ROUTE_MANIFEST_VERSION,
      denialReason: reason,
      routeDecision: plan.routeDecision,
      canonicalTarget: plan.canonicalTarget,
      selectedGroup: plan.selectedGroup,
      fallbackGroups: plan.fallbackSequence.map((f) => f.group),
      attempts: [],
      finalOutcome: "client_error",
      stream: envelope.stream,
      totalDurationMs: 0,
    };
    recordReceipt(denialReceipt);
    persistDenialReceipt(env, denialReceipt);
    return errorResponse({
      message: clientAdmission.message ?? "client limit exceeded",
      type: "rate_limit",
      code: reason,
    }, 429, requestId, client);
  }

  let admissionReleased = false;
  const releaseAdmission = () => {
    if (admissionReleased) return;
    admissionReleased = true;
    (stateDo as unknown as ControlPlaneStateDO).releaseClientRequest(clientAdmission.reservationId)
      .catch((e) => logWarn("client_limit_release_failed", { error: String(e) }));
  };

  // Execute attempt loop
  let result: Awaited<ReturnType<typeof executeAttemptLoop>>;
  try {
    result = await executeAttemptLoop(
      envelope,
      plan,
      stateDo as unknown as Parameters<typeof executeAttemptLoop>[2],
      env as unknown as Record<string, unknown>, // dynamic key lookup in resolveKey
      AbortSignal.timeout(plan.selectedPolicy.deadline.totalTimeoutSeconds * 1000),
      subscriptionCtx,
    );
  } catch (e) {
    releaseAdmission();
    throw e;
  } finally {
    if (!envelope.stream) {
      releaseAdmission();
    }
  }

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
    clientId: client.clientId,
    appId: client.appId,
    userHash: client.userHash,
    policyId: client.policyId,
    policyVersion: client.policyVersion,
    routeVersion: ROUTE_MANIFEST_VERSION,
    routeDecision: plan.routeDecision,
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
  receiptDo.storeClientRequest?.({
    requestId: receipt.requestId,
    timestamp: receipt.timestamp,
    clientId: client.clientId,
    appId: client.appId,
    userHash: client.userHash,
    policyId: client.policyId,
    policyVersion: client.policyVersion,
    routeVersion: ROUTE_MANIFEST_VERSION,
    routeDecision: receipt.routeDecision,
    originalModel: receipt.originalModel,
    canonicalTarget: receipt.canonicalTarget,
    selectedGroup: receipt.selectedGroup,
    finalOutcome: receipt.finalOutcome,
    stream: receipt.stream,
    totalDurationMs: receipt.totalDurationMs,
  }).catch((e) => logWarn("client_request_store_failed", { error: String(e) }));

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
      route: finalized.summary.route,
      canonicalTarget: finalized.summary.canonicalTarget,
      selectedGroup: finalized.summary.selectedGroup,
      selectedModel: finalized.summary.selectedModel,
      finalOutcome: finalized.summary.finalOutcome,
      failureClass: finalized.summary.failureClass,
      issueCode: finalized.summary.issueCode,
      requestSource: finalized.summary.requestSource,
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
    clientId: client.clientId,
    appId: client.appId,
    policyId: client.policyId,
  });

  if (result.response) {
    // Inject request ID header into the response
    const respHeaders = new Headers(result.response.headers);
    respHeaders.set("X-Request-Id", requestId);
    addVersionHeaders(respHeaders, client);
    if (metaSignature) respHeaders.set("X-Nim-Signature", metaSignature);
    const body = envelope.stream
      ? releaseClientOnStreamEnd(result.response.body, stateDo as unknown as ControlPlaneStateDO, clientAdmission.reservationId)
      : result.response.body;
    return new Response(body, {
      status: result.response.status,
      statusText: result.response.statusText,
      headers: respHeaders,
    });
  }

  // Exhausted
  if (envelope.stream) {
    (stateDo as unknown as ControlPlaneStateDO).releaseClientRequest(clientAdmission.reservationId)
      .catch((e) => logWarn("client_limit_release_failed", { error: String(e) }));
  }
  logWarn("request_exhausted", { requestId, failureClass: result.failureClass, attempts: result.attempts.length });
  return errorResponse({
    message: result.failureMessage ?? "all attempts exhausted",
    type: result.failureClass ?? "exhausted",
    code: "exhausted",
  }, 502, requestId, client);
}

function persistDenialReceipt(env: Env, receipt: RouteReceipt): void {
  const receiptDo = env.CONTROL_PLANE_STATE.get(
    env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME),
  );
  receiptDo.storeReceipt(receipt).catch((e) => logWarn("receipt_store_failed", { error: String(e) }));
  receiptDo.storeClientRequest?.({
    requestId: receipt.requestId,
    timestamp: receipt.timestamp,
    clientId: receipt.clientId ?? "unknown",
    appId: receipt.appId,
    userHash: receipt.userHash,
    policyId: receipt.policyId,
    policyVersion: receipt.policyVersion,
    routeVersion: receipt.routeVersion,
    denialReason: receipt.denialReason,
    routeDecision: receipt.routeDecision,
    originalModel: receipt.originalModel,
    canonicalTarget: receipt.canonicalTarget,
    selectedGroup: receipt.selectedGroup,
    finalOutcome: receipt.finalOutcome,
    stream: receipt.stream,
    totalDurationMs: receipt.totalDurationMs,
  }).catch((e) => logWarn("client_request_store_failed", { error: String(e) }));
}

export function releaseClientOnStreamEnd(
  body: ReadableStream<Uint8Array> | null,
  stateDo: ControlPlaneStateDO,
  reservationId: string,
): ReadableStream<Uint8Array> | null {
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    stateDo.releaseClientRequest(reservationId)
      .catch((e) => logWarn("client_limit_release_failed", { error: String(e) }));
  };

  if (!body) {
    release();
    return body;
  }

  const reader = body.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) {
          release();
          controller.close();
          return;
        }
        controller.enqueue(value);
      } catch (e) {
        release();
        controller.error(e);
      }
    },
    async cancel(reason) {
      try {
        await reader.cancel(reason);
      } finally {
        release();
      }
    },
  });
}

function addVersionHeaders(headers: Headers, client: ClientIdentity): void {
  headers.set("X-Policy-Id", client.policyId);
  headers.set("X-Policy-Version", client.policyVersion);
  headers.set("X-Route-Version", ROUTE_MANIFEST_VERSION);
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

export async function handleAdminClientRequests(
  request: Request,
  env: Env,
): Promise<Response> {
  const url = new URL(request.url);
  const clientId = url.searchParams.get("client_id") ?? undefined;
  const appId = url.searchParams.get("app_id") ?? undefined;
  const sinceParam = Number(url.searchParams.get("since"));
  const untilParam = Number(url.searchParams.get("until"));
  const limitParam = Number(url.searchParams.get("limit"));
  const limit = Math.min(1000, Math.max(1, Number.isFinite(limitParam) ? limitParam : 100));

  const stateDo = env.CONTROL_PLANE_STATE.get(
    env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME),
  ) as unknown as ControlPlaneStateDO;
  const requests = await stateDo.queryClientRequests({
    clientId,
    appId,
    since: Number.isFinite(sinceParam) ? sinceParam : undefined,
    until: Number.isFinite(untilParam) ? untilParam : undefined,
    limit,
  });
  return jsonResponse({ requests, total: requests.length });
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
  const clientId = url.searchParams.get("client_id") ?? undefined;
  const appId = url.searchParams.get("app_id") ?? undefined;
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
      clientId,
      appId,
      since,
      limit: 1000,
    });
    return jsonResponse({ events, total: events.length });
  }

  const until = Date.now();
  const rollupSince = Math.floor(since / HOUR_MS) * HOUR_MS;
  await computeUsageRollupsForWindow(stateDo, rollupSince, until);

  const rollups = clientId || appId
    ? await stateDo.queryClientRollups({
      clientId,
      appId,
      group,
      deploymentId,
      since: rollupSince,
    })
    : await stateDo.queryRollups({
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

  const parsed = parseFailedRequestQuery(request);
  if (!parsed.ok) {
    return jsonResponse({ error: parsed.error }, 422);
  }

  const stateDo = env.CONTROL_PLANE_STATE.get(
    env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME),
  );

  if (parsed.receiptId) {
    const rows = await (stateDo as unknown as ControlPlaneStateDO).queryFailedRequests({
      requestId: parsed.receiptId,
      includeReceipt: parsed.includeReceipt,
      limit: 1,
    });
    if (rows.length === 0) return jsonResponse({ error: "not found" }, 404);
    return jsonResponse(safeFailedRequestRow(rows[0], parsed.includeReceipt));
  }

  const failures = await (stateDo as unknown as ControlPlaneStateDO).queryFailedRequests({
    route: parsed.filters.route,
    selectedGroup: parsed.filters.selectedGroup,
    selectedModel: parsed.filters.selectedModel,
    failureClass: parsed.filters.failureClass,
    issueCode: parsed.filters.issueCode,
    requestSource: parsed.filters.requestSource,
    since: parsed.filters.since,
    until: parsed.filters.until,
    limit: parsed.filters.limit,
  });
  return jsonResponse({
    failures: failures.map((failure) => safeFailedRequestRow(failure, false)),
    total: failures.length,
  });
}

type FailedRequestQueryResult =
  | {
      ok: true;
      receiptId?: string;
      includeReceipt: boolean;
      filters: {
        route?: string;
        selectedGroup?: string;
        selectedModel?: string;
        failureClass?: string;
        issueCode?: string;
        requestSource?: string;
        since?: number;
        until?: number;
        limit: number;
      };
    }
  | { ok: false; error: string };

function parseFailedRequestQuery(request: Request): FailedRequestQueryResult {
  const url = new URL(request.url);
  const detailPrefix = "/nim/failures/";
  const pathReceiptId = url.pathname.startsWith(detailPrefix)
    ? decodeURIComponent(url.pathname.slice(detailPrefix.length))
    : undefined;
  const legacyRequestId = url.searchParams.get("request_id") ?? undefined;
  const receiptId = normalizeOptionalText(pathReceiptId || legacyRequestId, "receipt_id");
  if (receiptId.error) return { ok: false, error: receiptId.error };

  const includeReceipt = parseBooleanParam(url.searchParams.get("include_receipt"), "include_receipt");
  if (!includeReceipt.ok) return { ok: false, error: includeReceipt.error };

  if (receiptId.value) {
    const allowedDetailParams = new Set(pathReceiptId ? ["include_receipt"] : ["request_id", "include_receipt"]);
    const invalid = firstUnknownParam(url.searchParams, allowedDetailParams);
    if (invalid) return { ok: false, error: `unsupported filter: ${invalid}` };
    return { ok: true, receiptId: receiptId.value, includeReceipt: includeReceipt.value, filters: { limit: 1 } };
  }

  const allowedListParams = new Set([
    "route", "selected_group", "selected_model", "failure_class", "issue_code",
    "request_source", "since", "until", "limit", "include_receipt",
  ]);
  const invalid = firstUnknownParam(url.searchParams, allowedListParams);
  if (invalid) return { ok: false, error: `unsupported filter: ${invalid}` };
  if (includeReceipt.value) {
    return { ok: false, error: "include_receipt is only supported on /nim/failures/{receipt_id}" };
  }

  const route = normalizeOptionalText(url.searchParams.get("route"), "route");
  const selectedGroup = normalizeOptionalText(url.searchParams.get("selected_group"), "selected_group");
  const selectedModel = normalizeOptionalText(url.searchParams.get("selected_model"), "selected_model");
  const failureClass = normalizeOptionalText(url.searchParams.get("failure_class"), "failure_class");
  const issueCode = normalizeOptionalText(url.searchParams.get("issue_code"), "issue_code");
  const requestSource = normalizeOptionalText(url.searchParams.get("request_source"), "request_source");
  for (const item of [route, selectedGroup, selectedModel, failureClass, issueCode, requestSource]) {
    if (item.error) return { ok: false, error: item.error };
  }

  const since = parseTimeFilter(url.searchParams.get("since"), "since");
  if (!since.ok) return { ok: false, error: since.error };
  const until = parseTimeFilter(url.searchParams.get("until"), "until");
  if (!until.ok) return { ok: false, error: until.error };
  if (since.value !== undefined && until.value !== undefined && since.value > until.value) {
    return { ok: false, error: "since must be less than or equal to until" };
  }

  const limit = parseLimit(url.searchParams.get("limit"));
  if (!limit.ok) return { ok: false, error: limit.error };

  return {
    ok: true,
    includeReceipt: false,
    filters: {
      route: route.value,
      selectedGroup: selectedGroup.value,
      selectedModel: selectedModel.value,
      failureClass: failureClass.value,
      issueCode: issueCode.value,
      requestSource: requestSource.value,
      since: since.value,
      until: until.value,
      limit: limit.value,
    },
  };
}

function firstUnknownParam(params: URLSearchParams, allowed: Set<string>): string | undefined {
  let unknown: string | undefined;
  params.forEach((_value, key) => {
    if (unknown === undefined && !allowed.has(key)) unknown = key;
  });
  return unknown;
}

function normalizeOptionalText(value: string | null | undefined, name: string): { value?: string; error?: string } {
  if (value === null || value === undefined) return {};
  const normalized = value.trim();
  if (!normalized) return { error: `${name} cannot be blank` };
  return { value: normalized };
}

function parseBooleanParam(value: string | null, name: string): { ok: true; value: boolean } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: false };
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1") return { ok: true, value: true };
  if (normalized === "false" || normalized === "0") return { ok: true, value: false };
  return { ok: false, error: `${name} must be true or false` };
}

function parseLimit(value: string | null): { ok: true; value: number } | { ok: false; error: string } {
  if (value === null) return { ok: true, value: DEFAULT_FAILED_REQUEST_LIMIT };
  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return { ok: false, error: "limit must be an integer" };
  const parsed = Number.parseInt(normalized, 10);
  if (parsed < 1 || parsed > MAX_FAILED_REQUEST_LIMIT) {
    return { ok: false, error: `limit must be between 1 and ${MAX_FAILED_REQUEST_LIMIT}` };
  }
  return { ok: true, value: parsed };
}

function parseTimeFilter(value: string | null, name: string): { ok: true; value?: number } | { ok: false; error: string } {
  if (value === null) return { ok: true };
  const normalized = value.trim().toLowerCase();
  if (!normalized) return { ok: false, error: `${name} cannot be blank` };
  const duration = normalized.match(/^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/);
  if (duration) {
    const amount = Number.parseFloat(duration[1]);
    const unit = duration[2];
    const multiplier = unit === "ms" ? 1 : unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : 86_400_000;
    return { ok: true, value: Date.now() - amount * multiplier };
  }
  if (/^\d+(?:\.\d+)?$/.test(normalized)) {
    const numeric = Number.parseFloat(normalized);
    if (numeric < 0) return { ok: false, error: `${name} must be >= 0` };
    return { ok: true, value: numeric >= 1_000_000_000_000 ? numeric : numeric * 1000 };
  }
  const parsedDate = Date.parse(value);
  if (Number.isFinite(parsedDate)) return { ok: true, value: parsedDate };
  return { ok: false, error: `${name} must be a Unix timestamp, ISO timestamp, or duration` };
}

function safeFailedRequestRow(row: Record<string, unknown>, includeReceipt: boolean): Record<string, unknown> {
  const sanitized: Record<string, unknown> = { ...row };
  if ("summary" in sanitized) sanitized.summary = sanitizeReceipt(sanitized.summary);
  if (includeReceipt) {
    sanitized.receipt = sanitizeReceipt(sanitized.receipt ?? null);
  } else {
    delete sanitized.receipt;
  }
  return sanitized;
}

export function handlePing(): Response {
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

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

function isChatGPTResponsesModel(model: string): boolean {
  const target = MANIFEST.aliases[model] ?? (MANIFEST.routeGroups[model] ? model : undefined);
  if (!target) return false;
  return (MANIFEST.deploymentsByGroup[target] ?? []).some((deployment) =>
    deployment.provider === "chatgpt" && deployment.mode === "responses"
  );
}

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

function detectResponsesTypedContent(body: Record<string, unknown>): boolean {
  const input = body.input;
  if (!Array.isArray(input)) return false;
  for (const item of input) {
    if (!item || typeof item !== "object") continue;
    const content = (item as Record<string, unknown>).content;
    if (!Array.isArray(content)) continue;
    for (const part of content) {
      if (typeof part === "object" && part !== null) {
        const type = (part as Record<string, unknown>).type;
        if (type === "image_url" || type === "input_image" || type === "image" || type === "audio" || type === "input_audio") return true;
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
  client?: ClientIdentity,
): Response {
  const headers = new Headers({
    "Content-Type": "application/json",
    "X-Request-Id": requestId,
  });
  if (client) addVersionHeaders(headers, client);
  return new Response(JSON.stringify({
    error: {
      message: error.message,
      type: error.type,
      code: error.code,
    },
    request_id: requestId,
  }), {
    status,
    headers,
  });
}

function estimateClientTokenCost(body: Record<string, unknown>, tokenBudgetPerMinute?: number): number {
  const explicit = positiveNumber(body.max_completion_tokens) ?? positiveNumber(body.max_tokens) ?? positiveNumber(body.max_output_tokens);
  const promptEstimate = estimatePromptTokens(body.messages ?? body.input);
  if (!explicit && tokenBudgetPerMinute) return tokenBudgetPerMinute + 1;
  return Math.max(0, promptEstimate + (explicit ?? 0));
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}

function estimatePromptTokens(messages: unknown): number {
  if (!Array.isArray(messages)) return 0;
  return Math.ceil(JSON.stringify(messages).length / 4);
}
