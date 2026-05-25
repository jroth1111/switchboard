// Main Worker entrypoint.
// LLM Control Plane — Cloudflare Worker with NIM mitigation, account rotation,
// silent failover, and health scoring.

import { MANIFEST, ROUTE_MANIFEST_VERSION } from "./config/manifest";
import type { FailureClass } from "./config/schema";
import { validateManifest } from "./config/validate-manifest";
import { ControlPlaneStateDO } from "./state/control-plane-state";
import { OAuthAccountDO } from "./state/oauth-account";
import {
  handleChatCompletions,
  handleResponses,
  handleAdminHealth,
  handleAdminReceipts,
  handleAdminClientRequests,
  handleAdminClearCooldowns,
  handleAdminUsage,
  handlePing,
  verifyAdminAuth,
  handleNimHealth,
  handleNimFailures,
  handleAdminCanaryTrigger,
  handleAdminCanaryResults,
} from "./http/handler";
import { authenticateProxyClient, visibleModelsForClient, type ClientIdentity } from "./http/client-policy";
import { runCanaryProbes, reapAllLeases, type CanaryHealthSnapshot, type CanaryHistoryRow } from "./probes/canary";

export { ControlPlaneStateDO, OAuthAccountDO };

const CONTROL_PLANE_STATE_NAME = "control-plane";

// Validate manifest at module load time — catches misconfigurations early.
const manifestIssues = validateManifest(MANIFEST);
if (manifestIssues.some((i) => i.kind === "error")) {
  const msgs = manifestIssues.filter((i) => i.kind === "error").map((i) => i.message);
  throw new Error(`Manifest validation failed: ${msgs.join("; ")}`);
}

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": [
    "Authorization",
    "Content-Type",
    "X-Switchboard-User-Hash",
    "X-Switchboard-User-Signature",
  ].join(", "),
  "Access-Control-Expose-Headers": [
    "X-Request-Id",
    "X-Nim-Signature",
    "X-Policy-Id",
    "X-Policy-Version",
    "X-Route-Version",
  ].join(", "),
  "Access-Control-Max-Age": "86400",
};

function withCors(response: Response): Response {
  const headers = new Headers(response.headers);
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const path = url.pathname;

    // CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    let response: Response;

    // Health check (no auth)
    if (path === "/ping") {
      response = handlePing();
    } else if (path === "/nim/health" && request.method === "GET") {
      response = await handleNimHealth(request, env);
    } else if ((path === "/nim/failures" || path.startsWith("/nim/failures/")) && request.method === "GET") {
      response = await handleNimFailures(request, env);
    } else if (path.startsWith("/admin/")) {
      if (!verifyAdminAuth(request, env.ADMIN_API_KEY)) {
        response = new Response(JSON.stringify({ error: "unauthorized" }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      } else if (path === "/admin/health" && request.method === "GET") {
        response = await handleAdminHealth(request, env);
      } else if (path === "/admin/receipts" && request.method === "GET") {
        response = await handleAdminReceipts(request, env);
      } else if (path === "/admin/client-requests" && request.method === "GET") {
        response = await handleAdminClientRequests(request, env);
      } else if (path === "/admin/cooldowns/clear" && request.method === "POST") {
        response = await handleAdminClearCooldowns(request, env);
      } else if (path === "/admin/usage" && request.method === "GET") {
        response = await handleAdminUsage(request, env);
      } else if (path === "/admin/canary/trigger" && request.method === "POST") {
        response = await handleAdminCanaryTrigger(request, env);
      } else if (path === "/admin/canary/results" && request.method === "GET") {
        response = await handleAdminCanaryResults(request, env);
      } else {
        response = new Response(JSON.stringify({ error: "not found" }), {
          status: 404,
          headers: { "Content-Type": "application/json" },
        });
      }
    } else if ((path === "/models" || path === "/v1/models") && request.method === "GET") {
      const auth = await authenticateProxyClient(request, env);
      if (!auth.ok) {
        response = new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: { "Content-Type": "application/json" },
        });
      } else {
        response = handleModelsList(auth.client);
      }
    } else if (
      request.method === "POST" &&
      (path === "/chat/completions" || path === "/v1/chat/completions")
    ) {
      const auth = await authenticateProxyClient(request, env);
      if (!auth.ok) {
        return withCors(new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: { "Content-Type": "application/json" },
        }));
      }

      response = await handleChatCompletions(request, env, ctx, auth.client);
    } else if (request.method === "POST" && path === "/v1/responses") {
      const auth = await authenticateProxyClient(request, env);
      if (!auth.ok) {
        return withCors(new Response(JSON.stringify({ error: auth.error }), {
          status: auth.status,
          headers: { "Content-Type": "application/json" },
        }));
      }

      response = await handleResponses(request, env, ctx, auth.client);
    } else {
      response = new Response(JSON.stringify({ error: "not found" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    return withCors(response);
  },

  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const cron = controller.cron;

    if (cron === "*/2 * * * *") {
      // Canary probes — run one probe per visible group
      const defaultPolicy = MANIFEST.defaultPolicy;
      const stateStub = env.CONTROL_PLANE_STATE.get(
        env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME),
      );
      let canaryHealth: CanaryHealthSnapshot | null = null;
      let recentCanaryResults: CanaryHistoryRow[] = [];
      try { canaryHealth = await stateStub.getHealth() as CanaryHealthSnapshot; } catch {}
      try { recentCanaryResults = await stateStub.getCanaryResults(100) as CanaryHistoryRow[]; } catch {}
      const canaryContext = { health: canaryHealth, recentResults: recentCanaryResults };
      const results = await runCanaryProbes(
        env as unknown as Record<string, unknown>, // dynamic key lookup in canary probes
        {
          recordSuccess: async (deploymentId: string) => {
            await stateStub.recordSuccess(deploymentId, defaultPolicy.health.circuitSuccessThreshold);
          },
          recordFailure: async (
            deploymentId: string,
            failureClass: FailureClass,
            cooldownSeconds: number,
            circuitThreshold: number,
            circuitDurationSeconds: number,
          ) => {
            await stateStub.recordFailure(
              deploymentId,
              failureClass,
              cooldownSeconds,
              circuitThreshold,
              circuitDurationSeconds,
            );
          },
        },
        undefined,
        defaultPolicy.health.probeMaxInflight,
        canaryContext,
      );

      console.log(`[canary] ${results.length} probes: ${results.filter((r) => r.success).length} ok, ${results.filter((r) => !r.success).length} fail`);

      // Persist canary results to DO
      for (const r of results) {
        ctx.waitUntil(
          stateStub.storeCanaryResult({
            deploymentId: r.deploymentId,
            group: r.group,
            success: r.success,
            failureClass: r.failureClass,
            latencyMs: r.latencyMs,
            statusCode: r.status,
          }).catch((e) => console.error("canary_result_store_failed", String(e))),
        );
      }
    }

    if (cron === "*/5 * * * *") {
      // Reap expired leases
      const reaped = await reapAllLeases(() =>
        env.CONTROL_PLANE_STATE.get(env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME)),
      );
      console.log(`[reaper] reaped ${reaped} expired leases`);
    }

    if (cron === "0 * * * *") {
      // Hourly usage rollup computation
      const stub = env.CONTROL_PLANE_STATE.get(
        env.CONTROL_PLANE_STATE.idFromName(CONTROL_PLANE_STATE_NAME),
      ) as unknown as import("./state/control-plane-state").ControlPlaneStateDO;
      await stub.computeHourlyRollups();
      console.log("[rollup] hourly usage rollups computed");
    }
  },
} satisfies ExportedHandler<Env>;

function handleModelsList(client: ClientIdentity): Response {
  const models = visibleModelsForClient(client);
  return new Response(JSON.stringify({ object: "list", data: models }), {
    headers: {
      "Content-Type": "application/json",
      "X-Policy-Id": client.policyId,
      "X-Policy-Version": client.policyVersion,
      "X-Route-Version": ROUTE_MANIFEST_VERSION,
    },
  });
}
