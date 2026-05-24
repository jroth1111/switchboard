import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

type ProbeStatus = "pass" | "fail" | "skip";

interface ProbeResult {
  name: string;
  status: ProbeStatus;
  method: string;
  url: string;
  startedAt: string;
  durationMs: number;
  httpStatus?: number;
  requestId?: string;
  selectedGroup?: string;
  attemptCount?: number;
  streamEventCount?: number;
  stream?: boolean;
  healthBefore?: unknown;
  healthAfter?: unknown;
  detail?: unknown;
  error?: string;
}

interface SmokeReport {
  startedAt: string;
  finishedAt: string;
  baseUrl: string;
  mode: string;
  model: string;
  passed: number;
  failed: number;
  skipped: number;
  probes: ProbeResult[];
}

const args = new Set(process.argv.slice(2));
if (args.has("--help") || args.has("-h")) {
  console.log(`Usage: CONTROL_PLANE_URL=https://... [PROXY_API_KEY=...] [ADMIN_API_KEY=...] npm run live:smoke

Environment:
  CONTROL_PLANE_URL or LIVE_BASE_URL   Deployed control-plane Worker URL.
  LIVE_SMOKE_MODE                      surface | provider | fixture. Default: surface.
  LIVE_SMOKE_MODEL                     Model alias to exercise. Default: nim-primary.
  PROXY_API_KEY                        Required for provider/fixture chat probes.
  ADMIN_API_KEY or NIM_HEALTH_TOKEN     Enables authorized health, receipts, and cooldown cleanup.
  LIVE_SMOKE_REPORT                    Optional JSON report path.
  FIXTURE_WORKER_URL                   Optional fixture worker URL for subscription format probes.

Fixture mode expects the target Worker to route provider calls to the fixture endpoint,
usually via PROVIDER_API_BASE_* vars in its staging Worker configuration.`);
  process.exit(0);
}

const baseUrl = trimTrailingSlash(requiredEnv("CONTROL_PLANE_URL", "LIVE_BASE_URL"));
const mode = (process.env.LIVE_SMOKE_MODE ?? "surface").trim().toLowerCase();
const model = process.env.LIVE_SMOKE_MODEL ?? "nim-primary";
const proxyKey = process.env.PROXY_API_KEY;
const adminKey = process.env.ADMIN_API_KEY ?? process.env.NIM_HEALTH_TOKEN;
const reportPath = process.env.LIVE_SMOKE_REPORT;
const fixtureWorkerUrl = process.env.FIXTURE_WORKER_URL?.trim() ? trimTrailingSlash(process.env.FIXTURE_WORKER_URL.trim()) : undefined;
const probeTimeoutMs = parsePositiveInt(process.env.LIVE_SMOKE_TIMEOUT_MS, 30_000);

if (!["surface", "provider", "fixture"].includes(mode)) {
  failSetup(`LIVE_SMOKE_MODE must be surface, provider, or fixture; got ${mode}`);
}

const probes: ProbeResult[] = [];
const startedAt = new Date().toISOString();

await run("ping", "GET", "/ping", undefined, async (resp, body) => {
  assertStatus(resp, 200);
  const data = expectJson(body) as Record<string, unknown>;
  if (data.status !== "ok") throw new Error(`expected status=ok body, got: ${body.slice(0, 200)}`);
});

await run("models list", "GET", "/models", undefined, async (resp, body) => {
  assertStatus(resp, 200);
  const data = expectJson(body) as Record<string, unknown>;
  if (!Array.isArray(data.data)) throw new Error("models response missing data array");
});

await run("admin health rejects missing auth", "GET", "/admin/health", undefined, async (resp) => {
  assertStatus(resp, 401);
});

await run("proxy rejects bad auth", "POST", "/v1/chat/completions", {
  headers: { Authorization: "Bearer live-smoke-wrong-key", "Content-Type": "application/json" },
  body: JSON.stringify(chatBody("fixture:success", false)),
}, async (resp) => {
  assertStatus(resp, 401);
});

if (adminKey) {
  await run("admin health authorized", "GET", "/admin/health", {
    headers: bearer(adminKey),
  }, async (resp, body) => {
    assertStatus(resp, 200);
    const data = expectJson(body) as Record<string, unknown>;
    if (!data.status) throw new Error("health response missing status");
  });
} else {
  skip("admin health authorized", "GET", "/admin/health", "ADMIN_API_KEY or NIM_HEALTH_TOKEN not set");
}

if (mode !== "surface") {
  if (!proxyKey) {
    skip("provider chat completion", "POST", "/v1/chat/completions", "PROXY_API_KEY not set");
    markRequiredProviderFailure();
  } else {
    const healthBefore = await fetchHealth();
    const successRequestId = await chatProbe("provider chat completion", "fixture:success", false, 200);
    await receiptProbe(successRequestId);
    await chatProbe("provider streaming completion", "fixture:stream", true, 200);
    const healthAfter = await fetchHealth();

    if (healthBefore && healthAfter) {
      await run("health telemetry recorded after probes", "GET", "/admin/health", {
        headers: bearer(adminKey),
      }, () => {
        const successBefore = recentSuccessCount(healthBefore);
        const successAfter = recentSuccessCount(healthAfter);
        if (successAfter <= successBefore && !hasScoredRouteGroup(healthAfter)) {
          throw new Error("expected recent success count or group avgHealthScore after successful probes");
        }
      });
    } else {
      skip("health telemetry recorded after probes", "GET", "/admin/health", "ADMIN_API_KEY not set or health fetch failed");
    }
  }
}

if (mode === "fixture") {
  if (!proxyKey) {
    skip("fixture failure classification", "POST", "/v1/chat/completions", "PROXY_API_KEY not set");
  } else {
    await chatProbe("fixture rate-limit classification", "fixture:rate_limit", false, 502, [429, 502]);
    await chatProbe("fixture empty-response handling", "fixture:empty", false, 502);
    await chatProbe("fixture server-500 handling", "fixture:server_500", false, 502, [500, 502]);
    await chatProbe("fixture auth-failure handling", "fixture:auth_failure", false, 502, [401, 502]);
    await chatProbe("fixture reasoning-leak stripping", "fixture:reasoning_leak", false, 200);
    await chatProbe("fixture tool-call handling", "fixture:tool_call", false, 200);
    await chatProbe("fixture slow-first-token streaming", "fixture:slow_first_token", true, 200);
    await chatProbe("fixture malformed-json classification", "fixture:malformed_json", false, 502);
    await chatProbe("fixture success-shaped-failure detection", "fixture:success_shaped_failure", false, 502);
    await chatProbe("fixture repetition-detected detection", "fixture:repetition_detected", false, 502);
    await chatProbe("fixture truncated-response handling", "fixture:truncated_response", false, 502);
    await cleanupCooldowns();

    if (fixtureWorkerUrl) {
      await subscriptionStreamProbe("anthropic stream format", `${fixtureWorkerUrl}/messages`);
      await subscriptionStreamProbe("responses stream format", `${fixtureWorkerUrl}/responses`);
    } else {
      skip("anthropic stream format", "POST", "/messages", "FIXTURE_WORKER_URL not set");
      skip("responses stream format", "POST", "/responses", "FIXTURE_WORKER_URL not set");
    }
  }
}

const report: SmokeReport = {
  startedAt,
  finishedAt: new Date().toISOString(),
  baseUrl,
  mode,
  model,
  passed: probes.filter((p) => p.status === "pass").length,
  failed: probes.filter((p) => p.status === "fail").length,
  skipped: probes.filter((p) => p.status === "skip").length,
  probes,
};

const rendered = `${JSON.stringify(report, null, 2)}\n`;
if (reportPath) {
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, rendered);
}
console.log(rendered);
process.exit(report.failed > 0 ? 1 : 0);

// ─── Chat probe ────────────────────────────────────────────────────

async function chatProbe(
  name: string,
  scenario: string,
  stream: boolean,
  expectedStatus: number,
  acceptedStatuses: number[] = [expectedStatus],
): Promise<string | undefined> {
  let capturedRequestId: string | undefined;
  let streamEventCount: number | undefined;
  await run(name, "POST", "/v1/chat/completions", {
    headers: { ...bearer(proxyKey!), "Content-Type": "application/json" },
    body: JSON.stringify(chatBody(scenario, stream)),
  }, async (resp, body) => {
    if (!acceptedStatuses.includes(resp.status)) {
      throw new Error(`expected HTTP ${acceptedStatuses.join(" or ")}, got ${resp.status}: ${body.slice(0, 300)}`);
    }
    capturedRequestId = resp.headers.get("X-Request-Id") ?? undefined;
    if (!capturedRequestId) throw new Error("missing X-Request-Id header");
    if (!capturedRequestId.startsWith("req_")) throw new Error(`X-Request-Id should start with req_, got: ${capturedRequestId}`);
    if (resp.status === 200) {
      if (stream) {
        const sseEvents = parseSSEEvents(body);
        if (sseEvents.length === 0) throw new Error("stream had no parseable SSE events (missing [DONE] or no data: lines)");
        for (let i = 0; i < sseEvents.length; i++) validateOpenAIChunkShape(sseEvents[i], i);
        streamEventCount = sseEvents.length;
      } else {
        const data = expectJson(body) as Record<string, unknown>;
        if (!Array.isArray(data.choices)) throw new Error("chat response missing choices array");
        if (JSON.stringify(data).toLowerCase().includes("hidden chain should be stripped")) {
          throw new Error("response leaked fixture reasoning content");
        }
        assertContractProperties(data, name);
      }
    }
  });
  if (streamEventCount !== undefined && probes.length > 0) {
    probes[probes.length - 1].streamEventCount = streamEventCount;
  }
  if (probes.length > 0) {
    probes[probes.length - 1].stream = stream;
  }
  return capturedRequestId;
}

// ─── Receipt probe ─────────────────────────────────────────────────

async function receiptProbe(requestId: string | undefined): Promise<void> {
  if (!adminKey) {
    skip("receipt lookup", "GET", "/admin/receipts", "ADMIN_API_KEY or NIM_HEALTH_TOKEN not set");
    return;
  }
  if (!requestId) {
    skip("receipt lookup", "GET", "/admin/receipts", "no request id from provider probe");
    return;
  }
  await run("receipt lookup", "GET", `/admin/receipts?id=${encodeURIComponent(requestId)}`, {
    headers: bearer(adminKey),
  }, async (resp, body) => {
    assertStatus(resp, 200);
    const data = expectJson(body) as Record<string, unknown>;
    if (data.requestId !== requestId) throw new Error(`receipt requestId mismatch: ${String(data.requestId)}`);
    if (!data.selectedGroup || typeof data.selectedGroup !== "string" || (data.selectedGroup as string).length === 0) {
      throw new Error(`receipt selectedGroup is missing or empty: ${String(data.selectedGroup)}`);
    }
    const attempts = data.attempts as Array<Record<string, unknown>> | undefined;
    if (!attempts || attempts.length === 0) throw new Error("receipt has no attempts");
    if (!attempts.some((a) => a.action === "accept" || a.action === "repair_accept")) {
      throw new Error(`receipt attempts have no accept action: ${attempts.map((a) => String(a.action)).join(", ")}`);
    }
    const totalDurationMs = data.totalDurationMs as number | undefined;
    if (totalDurationMs === undefined || totalDurationMs === null || totalDurationMs <= 0) {
      throw new Error(`receipt totalDurationMs should be positive, got: ${String(totalDurationMs)}`);
    }
    const chatProbeResult = probes.find((p) => p.requestId === requestId);
    if (chatProbeResult?.stream !== undefined && data.stream !== chatProbeResult.stream) {
      throw new Error(`receipt stream=${String(data.stream)} does not match request stream=${String(chatProbeResult.stream)}`);
    }
    const chatProbeIdx = probes.findIndex((p) => p.requestId === requestId);
    if (chatProbeIdx >= 0) {
      probes[chatProbeIdx].selectedGroup = data.selectedGroup as string | undefined;
      probes[chatProbeIdx].attemptCount = attempts.length;
    }
  });
}

// ─── Subscription stream probe (Gap 9) ─────────────────────────────

async function subscriptionStreamProbe(name: string, fixturePath: string): Promise<void> {
  if (!fixtureWorkerUrl) return;
  const url = fixturePath.startsWith("http") ? fixturePath : `${fixtureWorkerUrl}${fixturePath}`;
  await run(name, "POST", url, {
    headers: { ...bearer(proxyKey!), "Content-Type": "application/json" },
    body: JSON.stringify({ model, stream: true, messages: [{ role: "user", content: "fixture:stream" }], max_tokens: 16 }),
  }, async (resp, body) => {
    assertStatus(resp, 200);
    const events = parseSSEEvents(body);
    if (events.length === 0) throw new Error(`${name} produced no SSE events`);
    const firstEvent = JSON.parse(events[0]) as Record<string, unknown>;
    if (!firstEvent.type) throw new Error(`expected subscription event to have "type" field`);
  });
}

// ─── Cleanup ────────────────────────────────────────────────────────

async function cleanupCooldowns(): Promise<void> {
  if (!adminKey) {
    skip("fixture cooldown cleanup", "POST", "/admin/cooldowns/clear", "ADMIN_API_KEY or NIM_HEALTH_TOKEN not set");
    return;
  }
  await run("fixture cooldown cleanup", "POST", "/admin/cooldowns/clear", {
    headers: bearer(adminKey),
  }, async (resp) => {
    assertStatus(resp, 200);
  });
}

// ─── Health helper (Gap 4) ─────────────────────────────────────────

async function fetchHealth(): Promise<Record<string, unknown> | undefined> {
  if (!adminKey) return undefined;
  try {
    const resp = await fetch(`${baseUrl}/admin/health`, { headers: bearer(adminKey) });
    if (!resp.ok) return undefined;
    return (await resp.json()) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

// ─── SSE parsing (Gap 1) ───────────────────────────────────────────

function parseSSEEvents(body: string): string[] {
  const events: string[] = [];
  let hasDone = false;
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "data: [DONE]") {
      hasDone = true;
    } else if (trimmed.startsWith("data: ")) {
      events.push(trimmed.slice(6));
    } else if (trimmed.startsWith("data:") && trimmed.length > 5) {
      events.push(trimmed.slice(5));
    }
  }
  return hasDone ? events : [];
}

function validateOpenAIChunkShape(data: string, index: number): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    throw new Error(`SSE event ${index} is not valid JSON: ${data.slice(0, 100)}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (!obj.choices || !Array.isArray(obj.choices)) {
    if (!obj.usage) throw new Error(`SSE event ${index} missing choices array`);
    return;
  }
  if (obj.choices.length > 0) {
    const choice = obj.choices[0] as Record<string, unknown>;
    if (!("delta" in choice) && !("finish_reason" in choice)) {
      throw new Error(`SSE event ${index} choice missing delta or finish_reason`);
    }
  }
}

// ─── Contract property assertions (Gap 10) ─────────────────────────

function assertContractProperties(data: Record<string, unknown>, probeName: string): void {
  if (!data.model || typeof data.model !== "string") {
    throw new Error("response missing model field");
  }
  const choices = data.choices as Array<Record<string, unknown>> | undefined;
  if (choices && choices.length > 0) {
    const message = choices[0].message as Record<string, unknown> | undefined;
    if (message && ("reasoning" in message || "reasoning_content" in message)) {
      throw new Error(`response leaked reasoning/reasoning_content in message (${probeName})`);
    }
  }
  const usage = data.usage as Record<string, number> | undefined;
  if (usage) {
    if (typeof usage.prompt_tokens === "number" && usage.prompt_tokens < 0) {
      throw new Error(`usage.prompt_tokens should be non-negative, got: ${usage.prompt_tokens}`);
    }
    if (typeof usage.completion_tokens === "number" && usage.completion_tokens < 0) {
      throw new Error(`usage.completion_tokens should be non-negative, got: ${usage.completion_tokens}`);
    }
  }
}

// ─── Helpers ────────────────────────────────────────────────────────

function chatBody(content: string, stream: boolean): Record<string, unknown> {
  return {
    model,
    stream,
    messages: [{ role: "user", content }],
    max_tokens: 16,
  };
}

async function run(
  name: string,
  method: string,
  path: string,
  init: RequestInit | undefined,
  assertFn: (resp: Response, body: string) => Promise<void> | void,
): Promise<void> {
  const started = Date.now();
  const url = path.startsWith("http") ? path : `${baseUrl}${path}`;
  let lastError = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), probeTimeoutMs);
    try {
      const resp = await fetch(url, { method, ...init, signal: controller.signal });
      const body = await resp.text();
      if (isWranglerRestart(resp, body) && attempt < 3) {
        lastError = body;
        await sleep(250 * attempt);
        continue;
      }
      await assertFn(resp, body);
      probes.push({
        name,
        status: "pass",
        method,
        url,
        startedAt: new Date(started).toISOString(),
        durationMs: Date.now() - started,
        httpStatus: resp.status,
        requestId: resp.headers.get("X-Request-Id") ?? undefined,
        detail: attempt > 1 ? { attempts: attempt } : undefined,
      });
      return;
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      if (lastError === "fetch failed" && attempt < 3) {
        await sleep(250 * attempt);
        continue;
      }
      break;
    } finally {
      clearTimeout(timeout);
    }
  }
  probes.push({
    name,
    status: "fail",
    method,
    url,
    startedAt: new Date(started).toISOString(),
    durationMs: Date.now() - started,
    error: lastError,
  });
}

function isWranglerRestart(resp: Response, body: string): boolean {
  return resp.status === 503 && body.includes("Your worker restarted mid-request");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function skip(name: string, method: string, path: string, reason: string): void {
  probes.push({
    name,
    status: "skip",
    method,
    url: `${baseUrl}${path}`,
    startedAt: new Date().toISOString(),
    durationMs: 0,
    error: reason,
  });
}

function markRequiredProviderFailure(): void {
  if (mode === "provider" || mode === "fixture") {
    probes.push({
      name: "provider credentials required",
      status: "fail",
      method: "ENV",
      url: baseUrl,
      startedAt: new Date().toISOString(),
      durationMs: 0,
      error: "PROXY_API_KEY is required when LIVE_SMOKE_MODE is provider or fixture",
    });
  }
}

function assertStatus(resp: Response, expected: number): void {
  if (resp.status !== expected) throw new Error(`expected HTTP ${expected}, got ${resp.status}`);
}

function expectJson(body: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`expected JSON body, got: ${body.slice(0, 200)}`);
  }
}

function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

function recentSuccessCount(report: Record<string, unknown>): number {
  const recent = report.recentOutcomes as Record<string, unknown> | undefined;
  const value = recent?.success;
  return typeof value === "number" ? value : 0;
}

function hasScoredRouteGroup(report: Record<string, unknown>): boolean {
  const groups = report.routeGroups as Record<string, Record<string, unknown>> | undefined;
  return Object.values(groups ?? {}).some((group) => typeof group.avgHealthScore === "number");
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  if (!value?.trim()) return fallback;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function requiredEnv(...names: string[]): string {
  for (const name of names) {
    const value = process.env[name];
    if (value?.trim()) return value.trim();
  }
  failSetup(`missing required env var: ${names.join(" or ")}`);
}

function failSetup(message: string): never {
  console.error(message);
  process.exit(2);
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}
