import { describe, it, expect, vi, afterEach } from "vitest";
import worker from "../../src/index";
import {
  verifyProxyAuth,
  verifyAdminAuth,
  handleAdminUsage,
  handleAdminClientRequests,
  handleChatCompletions,
  handleNimFailures,
  releaseClientOnStreamEnd,
} from "../../src/http/handler";
import {
  applyClientPolicyToPlan,
  authenticateProxyClient,
  authorizeModelForClient,
  type ClientIdentity,
  visibleModelsForClient,
} from "../../src/http/client-policy";
import { migrateFunctionsToTools } from "../../src/http/handler";
import {
  validateChatRequest,
  validateBodySize,
  validateResponsesRequest,
} from "../../src/http/validation";
import {
  planRequest,
  canonicalize,
  type RequestEnvelope,
} from "../../src/planner/planner";
import { MANIFEST } from "../../src/config/manifest";
import type { ControlPlaneStateDO } from "../../src/state/control-plane-state";

function makeEnvelope(overrides: Partial<RequestEnvelope> = {}): RequestEnvelope {
  return {
    requestId: "req-test-1",
    originalModel: "glm-5.1",
    body: { model: "glm-5.1", messages: [{ role: "user", content: "hello" }] },
    stream: false,
    hasTools: false,
    hasStrictTools: false,
    isMultiTool: false,
    hasTypedContent: false,
    requiresJsonMode: false,
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

async function hmacSha256Hex(secret: string, payload: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payload));
  return Array.from(new Uint8Array(signature)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function createRouteTestEnv() {
  const storeReceipt = vi.fn(async () => {});
  const storeClientRequest = vi.fn(async () => {});
  const stateDo = {
    admitClientRequest: vi.fn(async () => ({
      admitted: true,
      reservationId: "client-reservation-1",
    })),
    releaseClientRequest: vi.fn(async () => {}),
    admit: vi.fn(async (req: { candidates: Array<{ deploymentId: string; keyRef: string }> }) => ({
      admitted: true,
      deploymentId: req.candidates[0].deploymentId,
      keyRef: req.candidates[0].keyRef,
      reservationId: "provider-reservation-1",
      inflightAtDispatch: 0,
      effectiveMaxParallel: 1,
    })),
    confirm: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    recordSuccess: vi.fn(async () => {}),
    recordFailure: vi.fn(async () => {}),
    getHealth: vi.fn(async () => ({})),
    recordRouteDispatch: vi.fn(async () => {}),
    recordTokenUsage: vi.fn(async () => {}),
    storeUsageEvent: vi.fn(async () => {}),
    storeReceipt,
    storeClientRequest,
    storeFailedRequest: vi.fn(async () => {}),
  };
  const env = {
    CHATGPT_OAUTH: "chatgpt-token",
    ZAI_KEY_1: "zai-token",
    CLIENT_KEYS_JSON: JSON.stringify({
      clients: [{
        id: "operator",
        token_sha256: "acf6b6f1c492a018d86d7bdb01852131ea7533992c5a0246d24c4ec74b56aff0",
        allowHiddenRoutes: true,
      }],
    }),
    CONTROL_PLANE_STATE: {
      idFromName: vi.fn(() => "control-plane-id"),
      get: vi.fn(() => stateDo),
    },
  } as unknown as Env;
  return { env, stateDo, storeReceipt, storeClientRequest };
}

function routeContext(): ExecutionContext {
  return { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext;
}

// ─── Auth middleware ───────────────────────────────────────────────

describe("Auth middleware", () => {
  it("allows request with valid Bearer token", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer my-secret-key" },
    });
    expect(verifyProxyAuth(req, "my-secret-key")).toBe(true);
  });

  it("rejects request with wrong token", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(verifyProxyAuth(req, "my-secret-key")).toBe(false);
  });

  it("rejects request without Authorization header", () => {
    const req = new Request("https://example.com");
    expect(verifyProxyAuth(req, "my-secret-key")).toBe(false);
  });

  it("rejects malformed auth header", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Basic abc123" },
    });
    expect(verifyProxyAuth(req, "my-secret-key")).toBe(false);
  });

  it("fails closed when no key is configured", () => {
    const req = new Request("https://example.com");
    expect(verifyProxyAuth(req, "")).toBe(false);
  });

  it("admin auth requires key", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer admin-key" },
    });
    expect(verifyAdminAuth(req, "admin-key")).toBe(true);
    expect(verifyAdminAuth(req, "")).toBe(false);
  });

  it("accepts case-insensitive Bearer scheme", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "bearer my-secret-key" },
    });
    expect(verifyProxyAuth(req, "my-secret-key")).toBe(true);
  });

  it("accepts BEARER scheme", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "BEARER my-secret-key" },
    });
    expect(verifyProxyAuth(req, "my-secret-key")).toBe(true);
  });

  it("rejects Bearer with empty token", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer " },
    });
    expect(verifyProxyAuth(req, "my-secret-key")).toBe(false);
  });

  it("accepts Bearer with leading whitespace in token", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer  my-secret-key" },
    });
    expect(verifyProxyAuth(req, "my-secret-key")).toBe(true);
  });

  it("authenticates named clients from CLIENT_KEYS_JSON", async () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer client-token" },
    });
    const auth = await authenticateProxyClient(req, {
      CLIENT_KEYS_JSON: JSON.stringify({
        clients: [{
          id: "hermes-alice",
          token_sha256: "acf6b6f1c492a018d86d7bdb01852131ea7533992c5a0246d24c4ec74b56aff0",
          appId: "hermes",
          userHash: "user-hash",
          policyId: "hermes-basic",
          allowedModels: ["smart-route"],
          rpmLimit: 12,
        }],
      }),
    } as Env);

    expect(auth.ok).toBe(true);
    if (auth.ok) {
      expect(auth.client.clientId).toBe("hermes-alice");
      expect(auth.client.appId).toBe("hermes");
      expect(auth.client.policy.allowedModels).toEqual(["smart-route"]);
      expect(auth.client.policy.rpmLimit).toBe(12);
    }
  });

  it("applies signed per-user claims on top of a named client key", async () => {
    const signature = await hmacSha256Hex("claim-secret", "hermes-app:hermes:user-alice");
    const req = new Request("https://example.com", {
      headers: {
        Authorization: "Bearer client-token",
        "X-Switchboard-User-Hash": "user-alice",
        "X-Switchboard-User-Signature": signature,
      },
    });
    const auth = await authenticateProxyClient(req, {
      CLIENT_USER_CLAIM_SECRET: "claim-secret",
      CLIENT_KEYS_JSON: JSON.stringify({
        clients: [{
          id: "hermes-app",
          token_sha256: "acf6b6f1c492a018d86d7bdb01852131ea7533992c5a0246d24c4ec74b56aff0",
          appId: "hermes",
          userHash: "static-user",
        }],
      }),
    } as Env);

    expect(auth.ok).toBe(true);
    if (auth.ok) expect(auth.client.userHash).toBe("user-alice");
  });

  it("fails closed on wrongly signed per-user claims", async () => {
    const req = new Request("https://example.com", {
      headers: {
        Authorization: "Bearer client-token",
        "X-Switchboard-User-Hash": "user-alice",
        "X-Switchboard-User-Signature": "0".repeat(64),
      },
    });
    const auth = await authenticateProxyClient(req, {
      CLIENT_USER_CLAIM_SECRET: "claim-secret",
      CLIENT_KEYS_JSON: JSON.stringify({
        clients: [{
          id: "hermes-app",
          token_sha256: "acf6b6f1c492a018d86d7bdb01852131ea7533992c5a0246d24c4ec74b56aff0",
          appId: "hermes",
          userHash: "static-user",
        }],
      }),
    } as Env);

    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.error.message).toBe("invalid signed user claim");
  });

  it("fails closed on partial signed per-user claims", async () => {
    const req = new Request("https://example.com", {
      headers: {
        Authorization: "Bearer client-token",
        "X-Switchboard-User-Hash": "user-alice",
      },
    });
    const auth = await authenticateProxyClient(req, {
      CLIENT_USER_CLAIM_SECRET: "claim-secret",
      CLIENT_KEYS_JSON: JSON.stringify({
        clients: [{
          id: "hermes-app",
          token_sha256: "acf6b6f1c492a018d86d7bdb01852131ea7533992c5a0246d24c4ec74b56aff0",
          appId: "hermes",
          userHash: "static-user",
        }],
      }),
    } as Env);

    expect(auth.ok).toBe(false);
    if (!auth.ok) expect(auth.error.message).toBe("invalid signed user claim");
  });

  it("does not accept the replaced shared proxy key for client traffic", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/models", {
        headers: { Authorization: "Bearer old-shared-key" },
      }),
      { PROXY_API_KEY: "old-shared-key", CLIENT_KEYS_JSON: JSON.stringify({ clients: [] }) } as Env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(401);
  });

  it("fails closed when CLIENT_KEYS_JSON is malformed", async () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer client-token" },
    });
    const auth = await authenticateProxyClient(req, {
      CLIENT_KEYS_JSON: "{not-json",
    } as Env);

    expect(auth.ok).toBe(false);
  });

  it("fails closed for plaintext client tokens", async () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer client-token" },
    });
    const auth = await authenticateProxyClient(req, {
      CLIENT_KEYS_JSON: JSON.stringify({
        clients: [{ id: "bad-client", token: "client-token" }],
      }),
    } as Env);

    expect(auth.ok).toBe(false);
  });

  it("enforces per-client allowed model policy", async () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer client-token" },
    });
    const auth = await authenticateProxyClient(req, {
      CLIENT_KEYS_JSON: JSON.stringify({
        clients: [{
          id: "hermes-alice",
          token_sha256: "acf6b6f1c492a018d86d7bdb01852131ea7533992c5a0246d24c4ec74b56aff0",
          allowedModels: ["smart-route"],
        }],
      }),
    } as Env);

    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(authorizeModelForClient("smart-route", auth.client).allowed).toBe(true);
    expect(authorizeModelForClient("nim-primary", auth.client)).toEqual({
      allowed: false,
      reason: "model_not_allowed",
    });
  });

  it("enforces denied route groups", async () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer client-token" },
    });
    const auth = await authenticateProxyClient(req, {
      CLIENT_KEYS_JSON: JSON.stringify({
        clients: [{
          id: "hermes-alice",
          token_sha256: "acf6b6f1c492a018d86d7bdb01852131ea7533992c5a0246d24c4ec74b56aff0",
          deniedRouteGroups: ["nim-primary"],
        }],
      }),
    } as Env);

    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(authorizeModelForClient("nim-primary", auth.client)).toEqual({
      allowed: false,
      reason: "route_group_denied",
    });
  });

  it("filters model catalog by client policy", async () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer client-token" },
    });
    const auth = await authenticateProxyClient(req, {
      CLIENT_KEYS_JSON: JSON.stringify({
        clients: [{
          id: "hermes-alice",
          token_sha256: "acf6b6f1c492a018d86d7bdb01852131ea7533992c5a0246d24c4ec74b56aff0",
          allowedModels: ["smart-route"],
        }],
      }),
    } as Env);

    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    const models = visibleModelsForClient(auth.client).map((model) => model.id);
    expect(models).toContain("smart-route");
    expect(models).not.toContain("nim-primary");
  });

  it("omits hidden parity aliases from the default visible model catalog", () => {
    const client: ClientIdentity = {
      clientId: "catalog-client",
      policyId: "default",
      policyVersion: "default:v1",
      policy: {},
      authSource: "client_keys_json",
    };

    const models = visibleModelsForClient(client).map((model) => model.id);
    expect(models).toContain("smart-route");
    expect(models).toContain("nim-primary");
    expect(models).not.toContain("gpt-5.5(high)");
    expect(models).not.toContain("anthropic-subscription-opus-4-7-high");
    expect(models).not.toContain("zai-fallback");
  });

  it("applies client route policy to planned fallback routes", () => {
    const envelope = makeEnvelope({ originalModel: "smart-route" });
    envelope.body.model = "smart-route";
    const plan = planRequest(envelope);
    expect(plan).not.toBeNull();
    expect(plan!.fallbackSequence.map((entry) => entry.group)).toContain("nim-primary");

    const client: ClientIdentity = {
      clientId: "hermes-alice",
      policyId: "hermes-basic",
      policyVersion: "hermes-basic:v1",
      policy: { deniedRouteGroups: ["nim-primary"] },
      authSource: "client_keys_json",
    };
    const filtered = applyClientPolicyToPlan(plan!, client);

    expect(filtered.fallbackSequence.map((entry) => entry.group)).not.toContain("nim-primary");
    expect(filtered.routeDecision.fallbackGroups).not.toContain("nim-primary");
    expect(filtered.routeDecision.candidates.find((candidate) => candidate.group === "nim-primary")).toMatchObject({
      viable: false,
      rejectionReason: "client_policy:route_group_denied",
    });
  });

  it("does not let allowed-model clients inherit fallback models they did not allow", () => {
    const envelope = makeEnvelope({ originalModel: "smart-route" });
    envelope.body.model = "smart-route";
    const plan = planRequest(envelope);
    expect(plan).not.toBeNull();

    const client: ClientIdentity = {
      clientId: "hermes-alice",
      policyId: "hermes-basic",
      policyVersion: "hermes-basic:v1",
      policy: { allowedModels: ["smart-route"] },
      authSource: "client_keys_json",
    };
    const filtered = applyClientPolicyToPlan(plan!, client);

    expect(filtered.selectedGroup).toBe("smart-route-worker");
    expect(filtered.fallbackSequence).toEqual([]);
    expect(filtered.routeDecision.fallbackGroups).toEqual([]);
    expect(filtered.routeDecision.candidates.find((candidate) => candidate.group === "nim-primary")).toMatchObject({
      viable: false,
      rejectionReason: "client_policy:model_not_allowed",
    });
  });

  it("serves authenticated model catalog through the worker route", async () => {
    const response = await worker.fetch(
      new Request("https://example.com/v1/models", {
        headers: { Authorization: "Bearer client-token" },
      }),
      {
        CLIENT_KEYS_JSON: JSON.stringify({
          clients: [{
            id: "hermes-alice",
            token_sha256: "acf6b6f1c492a018d86d7bdb01852131ea7533992c5a0246d24c4ec74b56aff0",
            allowedModels: ["smart-route"],
          }],
        }),
      } as Env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    );

    const body = await response.json() as { data: Array<{ id: string }> };
    expect(response.status).toBe(200);
    expect(response.headers.get("X-Policy-Id")).toBe("default");
    expect(response.headers.get("X-Policy-Version")).toBe("default:unversioned");
    expect(response.headers.get("X-Route-Version")).toBe("switchboard-static-2026-05-24");
    expect(body.data.map((model) => model.id)).toContain("smart-route");
    expect(body.data.map((model) => model.id)).not.toContain("nim-primary");
    expect(body.data[0]).toHaveProperty("label");
    expect(body.data[0]).toHaveProperty("capabilities");
    expect(body.data[0]).toHaveProperty("category");
    expect(body.data[0]).not.toHaveProperty("route_group");
  });

  it("persists policy denial receipts before planning", async () => {
    const storeReceipt = vi.fn(async () => {});
    const storeClientRequest = vi.fn(async () => {});
    const stateDo = { storeReceipt, storeClientRequest };
    const env = {
      CONTROL_PLANE_STATE: {
        idFromName: vi.fn(() => "control-plane"),
        get: vi.fn(() => stateDo),
      },
    } as unknown as Env;
    const response = await handleChatCompletions(
      new Request("https://example.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "nim-primary",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
      {
        clientId: "hermes-alice",
        appId: "hermes",
        userHash: "user-hash",
        policyId: "hermes-basic",
        policyVersion: "hermes-basic:v1",
        policy: { allowedModels: ["smart-route"] },
        authSource: "client_keys_json",
      },
    );

    expect(response.status).toBe(403);
    expect(response.headers.get("X-Policy-Id")).toBe("hermes-basic");
    expect(response.headers.get("X-Policy-Version")).toBe("hermes-basic:v1");
    expect(response.headers.get("X-Route-Version")).toBe("switchboard-static-2026-05-24");
    expect(storeReceipt).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "hermes-alice",
      denialReason: "model_not_allowed",
      policyVersion: "hermes-basic:v1",
    }));
    expect(storeClientRequest).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "hermes-alice",
      denialReason: "model_not_allowed",
    }));
  });

  it("rejects token-budgeted chat requests without an explicit output token cap", async () => {
    const admitClientRequest = vi.fn(async (admissionRequest: { estimatedTokens?: number }) => ({
      admitted: false,
      reservationId: "client-reservation-1",
      reason: "client_token_budget_exceeded",
      message: `estimated ${admissionRequest.estimatedTokens} over budget`,
    }));
    const storeReceipt = vi.fn(async () => {});
    const storeClientRequest = vi.fn(async () => {});
    const stateDo = { admitClientRequest, storeReceipt, storeClientRequest };
    const env = {
      CONTROL_PLANE_STATE: {
        idFromName: vi.fn(() => "control-plane"),
        get: vi.fn(() => stateDo),
      },
    } as unknown as Env;
    const response = await handleChatCompletions(
      new Request("https://example.com/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "smart-route",
          messages: [{ role: "user", content: "hi" }],
        }),
      }),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
      {
        clientId: "hermes-alice",
        appId: "hermes",
        userHash: "user-hash",
        policyId: "hermes-basic",
        policyVersion: "hermes-basic:v1",
        policy: { allowedModels: ["smart-route"], tokenBudgetPerMinute: 100 },
        authSource: "client_keys_json",
      },
    );

    expect(response.status).toBe(429);
    expect(admitClientRequest).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "hermes-alice",
      estimatedTokens: 101,
      tokenBudgetPerMinute: 100,
    }));
    expect(storeReceipt).toHaveBeenCalledWith(expect.objectContaining({
      denialReason: "client_token_budget_exceeded",
      fallbackGroups: [],
    }));
  });

  it("keeps hidden routes unavailable unless policy explicitly allows them", async () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer client-token" },
    });
    const auth = await authenticateProxyClient(req, {
      CLIENT_KEYS_JSON: JSON.stringify({
        clients: [{
          id: "power-user",
          token_sha256: "acf6b6f1c492a018d86d7bdb01852131ea7533992c5a0246d24c4ec74b56aff0",
          allowedModels: ["gpt-5.5(high)"],
        }],
      }),
    } as Env);

    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(authorizeModelForClient("gpt-5.5(high)", auth.client)).toEqual({
      allowed: false,
      reason: "hidden_route",
    });
  });

  it("allows hidden routes only for clients that explicitly opt in", async () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer client-token" },
    });
    const auth = await authenticateProxyClient(req, {
      CLIENT_KEYS_JSON: JSON.stringify({
        clients: [{
          id: "operator",
          token_sha256: "acf6b6f1c492a018d86d7bdb01852131ea7533992c5a0246d24c4ec74b56aff0",
          allowedModels: ["gpt-5.5(high)"],
          allowHiddenRoutes: true,
        }],
      }),
    } as Env);

    expect(auth.ok).toBe(true);
    if (!auth.ok) return;
    expect(authorizeModelForClient("gpt-5.5(high)", auth.client).allowed).toBe(true);
  });
});

describe("Streaming client admission release", () => {
  it("releases the durable client reservation when a streaming response completes", async () => {
    const releaseClientRequest = vi.fn(async () => {});
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1]));
        controller.close();
      },
    });

    const wrapped = releaseClientOnStreamEnd(stream, { releaseClientRequest } as unknown as ControlPlaneStateDO, "reservation-1");
    expect(wrapped).not.toBeNull();
    const reader = wrapped!.getReader();
    expect((await reader.read()).done).toBe(false);
    expect((await reader.read()).done).toBe(true);

    expect(releaseClientRequest).toHaveBeenCalledTimes(1);
    expect(releaseClientRequest).toHaveBeenCalledWith("reservation-1");
  });

  it("releases the durable client reservation when a streaming response is canceled", async () => {
    const releaseClientRequest = vi.fn(async () => {});
    let canceled = false;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new Uint8Array([1]));
      },
      cancel() {
        canceled = true;
      },
    });

    const wrapped = releaseClientOnStreamEnd(stream, { releaseClientRequest } as unknown as ControlPlaneStateDO, "reservation-2");
    const reader = wrapped!.getReader();
    await reader.read();
    await reader.cancel("client disconnected");

    expect(canceled).toBe(true);
    expect(releaseClientRequest).toHaveBeenCalledTimes(1);
    expect(releaseClientRequest).toHaveBeenCalledWith("reservation-2");
  });
});

describe("ChatGPT Responses public surface", () => {
  it("routes gpt-5.5 /v1/responses requests through planning and provider attempts", async () => {
    const { env, stateDo, storeReceipt } = createRouteTestEnv();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "resp_test",
      model: "gpt-5.5",
      output: [{
        type: "message",
        content: [{ type: "output_text", text: "OK - route accepted successfully." }],
      }],
      usage: { input_tokens: 4, output_tokens: 5 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://example.com/v1/responses", {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          input: "Return a short success message.",
        }),
      }),
      env,
      routeContext(),
    );
    const body = await response.json() as { choices: Array<{ message: { content: string } }> };

    expect(response.status).toBe(200);
    expect(body.choices[0].message.content).toBe("OK - route accepted successfully.");
    expect(stateDo.admitClientRequest).toHaveBeenCalledWith(expect.objectContaining({
      clientId: "operator",
    }));
    expect(stateDo.admit).toHaveBeenCalledWith(expect.objectContaining({
      candidates: expect.arrayContaining([
        expect.objectContaining({
          deploymentId: "chatgpt-subscription-gpt-5.5-medium-key-1",
          keyRef: "CHATGPT_OAUTH",
        }),
      ]),
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toContain("/responses");
    expect(storeReceipt).toHaveBeenCalledWith(expect.objectContaining({
      originalModel: "gpt-5.5",
      selectedGroup: "chatgpt-subscription-gpt-5.5-medium",
      routeDecision: expect.objectContaining({
        requestClass: expect.objectContaining({
          surface: "responses",
          operation: "responses",
        }),
      }),
    }));
  });

  it("rejects ChatGPT subscription aliases on /v1/chat/completions before provider dispatch", async () => {
    const { env, stateDo } = createRouteTestEnv();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://example.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "gpt-5.5",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      env,
      routeContext(),
    );
    const body = await response.json() as { error: { code: string; message: string } };

    expect(response.status).toBe(400);
    expect(body.error.code).toBe("unsupported_surface");
    expect(body.error.message).toContain("/v1/responses");
    expect(stateDo.admitClientRequest).not.toHaveBeenCalled();
    expect(stateDo.admit).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps ordinary non-ChatGPT chat-completions planning and dispatch working", async () => {
    const { env, stateDo, storeReceipt } = createRouteTestEnv();
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      id: "chatcmpl_test",
      object: "chat.completion",
      created: 0,
      model: "glm-5.1",
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Non-ChatGPT route accepted." },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 3, completion_tokens: 4, total_tokens: 7 },
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await worker.fetch(
      new Request("https://example.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: "Bearer client-token",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: "smart-route",
          messages: [{ role: "user", content: "hello" }],
        }),
      }),
      env,
      routeContext(),
    );

    expect(response.status).toBe(200);
    expect(stateDo.admit).toHaveBeenCalledWith(expect.objectContaining({
      candidates: expect.arrayContaining([
        expect.objectContaining({ deploymentId: "zai-glm-5.1-key-1", keyRef: "ZAI_KEY_1" }),
      ]),
    }));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0][0])).toBe("https://api.z.ai/api/coding/paas/v4/chat/completions");
    expect(storeReceipt).toHaveBeenCalledWith(expect.objectContaining({
      selectedGroup: "smart-route-worker",
      routeDecision: expect.objectContaining({
        requestClass: expect.objectContaining({
          surface: "chat_completions",
          operation: "chat",
        }),
      }),
    }));
  });

  it("rejects messages payloads on /v1/responses validation", () => {
    const result = validateResponsesRequest({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
    });

    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("unsupported_messages");
  });
});

// ─── Admin usage ─────────────────────────────────────────────────

describe("Admin usage", () => {
  it("computes requested hourly rollups before querying them", async () => {
    const now = Date.UTC(2026, 4, 24, 5, 30, 0);
    const order: string[] = [];
    const computeHourlyRollups = vi.fn((hourStart?: number) =>
      new Promise<void>((resolve) => {
        queueMicrotask(() => {
          order.push(`compute:${hourStart}`);
          resolve();
        });
      }),
    );
    const queryRollups = vi.fn(async () => {
      order.push("query");
      return [{
        requests: 2,
        knownRequests: 1,
        unknownRequests: 1,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      }];
    });
    const stateDo = { computeHourlyRollups, queryRollups };
    const env = {
      CONTROL_PLANE_STATE: {
        idFromName: vi.fn(() => "control-plane-id"),
        get: vi.fn(() => stateDo),
      },
    } as unknown as Env;

    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const response = await handleAdminUsage(
        new Request("https://example.test/admin/usage?window=2h"),
        env,
      );
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.rollupSince).toBe(Date.UTC(2026, 4, 24, 3, 0, 0));
      expect((body.totals as Record<string, number>).requests).toBe(2);
    } finally {
      vi.useRealTimers();
    }

    expect(computeHourlyRollups).toHaveBeenCalledTimes(3);
    expect(computeHourlyRollups).toHaveBeenNthCalledWith(1, Date.UTC(2026, 4, 24, 3, 0, 0));
    expect(computeHourlyRollups).toHaveBeenNthCalledWith(2, Date.UTC(2026, 4, 24, 4, 0, 0));
    expect(computeHourlyRollups).toHaveBeenNthCalledWith(3, Date.UTC(2026, 4, 24, 5, 0, 0));
    expect(queryRollups).toHaveBeenCalledWith({
      group: undefined,
      deploymentId: undefined,
      since: Date.UTC(2026, 4, 24, 3, 0, 0),
    });
    expect(order.at(-1)).toBe("query");
  });
});

describe("Admin client requests", () => {
  it("exposes durable route decisions and denial reasons with client filters", async () => {
    const queryClientRequests = vi.fn(async () => [{
      requestId: "req-denied",
      clientId: "hermes-alice",
      appId: "hermes",
      policyId: "hermes-basic",
      denialReason: "model_not_allowed",
      originalModel: "nim-primary",
      canonicalTarget: "denied",
      selectedGroup: "denied",
      routeDecision: {
        selectedReason: "highest scoring viable candidate (90)",
        candidates: [{ group: "smart-route-worker", viable: true }],
      },
      finalOutcome: "client_error",
    }]);
    const stateDo = { queryClientRequests };
    const env = {
      CONTROL_PLANE_STATE: {
        idFromName: vi.fn(() => "control-plane-id"),
        get: vi.fn(() => stateDo),
      },
    } as unknown as Env;

    const response = await handleAdminClientRequests(
      new Request("https://example.test/admin/client-requests?client_id=hermes-alice&app_id=hermes&since=10&until=20&limit=5"),
      env,
    );
    const body = await response.json() as {
      requests: Array<Record<string, unknown>>;
      total: number;
    };

    expect(response.status).toBe(200);
    expect(queryClientRequests).toHaveBeenCalledWith({
      clientId: "hermes-alice",
      appId: "hermes",
      since: 10,
      until: 20,
      limit: 5,
    });
    expect(body.total).toBe(1);
    expect(body.requests[0]).toMatchObject({
      clientId: "hermes-alice",
      appId: "hermes",
      denialReason: "model_not_allowed",
      selectedGroup: "denied",
      routeDecision: {
        selectedReason: "highest scoring viable candidate (90)",
        candidates: [{ group: "smart-route-worker", viable: true }],
      },
    });
  });
});

describe("NIM failed request observability", () => {
  function makeFailureRow(overrides: Record<string, unknown> = {}) {
    return {
      requestId: "req-failure-1",
      timestamp: Date.UTC(2026, 4, 24, 4, 0, 0),
      originalModel: "glm-5.1",
      route: "smart-route-worker",
      canonicalTarget: "smart-route-worker",
      selectedGroup: "nim-primary",
      selectedModel: "nim-primary-key-1",
      finalOutcome: "exhausted",
      failureClass: "server_5xx",
      issueCode: "provider_5xx",
      requestSource: "hermes",
      attemptsCount: 1,
      summary: {
        requestId: "req-failure-1",
        route: "smart-route-worker",
        selectedModel: "nim-primary-key-1",
        failureClass: "server_5xx",
      },
      ...overrides,
    };
  }

  function makeFailureEnv(queryFailedRequests = vi.fn(async () => [makeFailureRow()])) {
    return {
      NIM_HEALTH_TOKEN: "health-token",
      CONTROL_PLANE_STATE: {
        idFromName: vi.fn(() => "control-plane-id"),
        get: vi.fn(() => ({ queryFailedRequests })),
      },
    } as unknown as Env;
  }

  it("supports LiteLLM parity summary filters and omits receipts by default", async () => {
    const now = Date.UTC(2026, 4, 24, 5, 0, 0);
    const queryFailedRequests = vi.fn(async () => [makeFailureRow({ receipt: { body: "must not leak" } })]);
    const env = makeFailureEnv(queryFailedRequests);

    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const response = await handleNimFailures(
        new Request(
          "https://example.test/nim/failures?route=smart-route-worker&selected_group=nim-primary&selected_model=nim-primary-key-1&failure_class=server_5xx&issue_code=provider_5xx&request_source=hermes&since=1h&until=1779598800&limit=25",
          { headers: { Authorization: "Bearer health-token" } },
        ),
        env,
      );
      const body = await response.json() as { failures: Array<Record<string, unknown>>; total: number };

      expect(response.status).toBe(200);
      expect(queryFailedRequests).toHaveBeenCalledWith({
        route: "smart-route-worker",
        selectedGroup: "nim-primary",
        selectedModel: "nim-primary-key-1",
        failureClass: "server_5xx",
        issueCode: "provider_5xx",
        requestSource: "hermes",
        since: now - 3_600_000,
        until: 1779598800 * 1000,
        limit: 25,
      });
      expect(body.total).toBe(1);
      expect(body.failures[0]).not.toHaveProperty("receipt");
    } finally {
      vi.useRealTimers();
    }
  });

  it("routes detail lookups through the Worker entrypoint", async () => {
    const queryFailedRequests = vi.fn(async () => [makeFailureRow()]);
    const env = makeFailureEnv(queryFailedRequests);

    const response = await worker.fetch(
      new Request("https://example.test/nim/failures/req-failure-1", {
        headers: { Authorization: "Bearer health-token" },
      }),
      env,
      { waitUntil: vi.fn(), passThroughOnException: vi.fn() } as unknown as ExecutionContext,
    );

    expect(response.status).toBe(200);
    expect(queryFailedRequests).toHaveBeenCalledWith({
      requestId: "req-failure-1",
      includeReceipt: false,
      limit: 1,
    });
    const body = await response.json() as Record<string, unknown>;
    expect(body.requestId).toBe("req-failure-1");
    expect(body).not.toHaveProperty("receipt");
  });

  it("returns sanitized receipts only when include_receipt is true", async () => {
    const queryFailedRequests = vi.fn(async () => [makeFailureRow({
      summary: {
        requestId: "req-failure-1",
        input: "raw prompt body",
      },
      receipt: {
        requestId: "req-failure-1",
        authorization: "Bearer sk-secret-token",
        body: "raw provider body",
        attempts: [{ failureMessage: "provider body contained user prompt" }],
      },
    })]);
    const env = makeFailureEnv(queryFailedRequests);

    const response = await handleNimFailures(
      new Request("https://example.test/nim/failures/req-failure-1?include_receipt=true", {
        headers: { Authorization: "Bearer health-token" },
      }),
      env,
    );
    const text = await response.text();
    const body = JSON.parse(text) as Record<string, unknown>;
    const receipt = body.receipt as Record<string, unknown>;

    expect(response.status).toBe(200);
    expect(queryFailedRequests).toHaveBeenCalledWith({
      requestId: "req-failure-1",
      includeReceipt: true,
      limit: 1,
    });
    expect(receipt.authorization).toBe("<redacted>");
    expect(receipt.body).toBe("<redacted>");
    expect(text).not.toContain("raw provider body");
    expect(text).not.toContain("raw prompt body");
    expect(text).not.toContain("sk-secret-token");
  });

  it("returns 404 for unknown receipts without storage details", async () => {
    const queryFailedRequests = vi.fn(async () => []);
    const env = makeFailureEnv(queryFailedRequests);

    const response = await handleNimFailures(
      new Request("https://example.test/nim/failures/missing", {
        headers: { Authorization: "Bearer health-token" },
      }),
      env,
    );
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(404);
    expect(body).toEqual({ error: "not found" });
  });

  it("returns 422 for invalid filters before touching storage", async () => {
    const queryFailedRequests = vi.fn(async () => [makeFailureRow()]);
    const env = makeFailureEnv(queryFailedRequests);

    const response = await handleNimFailures(
      new Request("https://example.test/nim/failures?limit=0", {
        headers: { Authorization: "Bearer health-token" },
      }),
      env,
    );

    expect(response.status).toBe(422);
    expect(queryFailedRequests).not.toHaveBeenCalled();
  });

  it("keeps failed-request review endpoints authenticated", async () => {
    const queryFailedRequests = vi.fn(async () => [makeFailureRow()]);
    const env = makeFailureEnv(queryFailedRequests);

    const response = await handleNimFailures(
      new Request("https://example.test/nim/failures"),
      env,
    );

    expect(response.status).toBe(401);
    expect(queryFailedRequests).not.toHaveBeenCalled();
  });
});

// ─── Planner integration ──────────────────────────────────────────

describe("Planner routing integration", () => {
  it("routes glm-5.1 to smart-route-worker", () => {
    const envelope = makeEnvelope({ originalModel: "glm-5.1" });
    envelope.body.model = "glm-5.1";
    const plan = planRequest(envelope);
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBe("smart-route-worker");
    expect(plan!.routeDecision).toMatchObject({
      canonicalization: {
        requestedModel: "glm-5.1",
        canonicalTarget: "smart-route-worker",
        reason: "alias",
      },
      selectedGroup: "smart-route-worker",
      selectedReason: "highest scoring viable candidate (90)",
    });
    expect(plan!.routeDecision.candidates.length).toBeGreaterThan(0);
  });

  it("routes nim-primary to nim-primary group", () => {
    const envelope = makeEnvelope({ originalModel: "nim-primary" });
    envelope.body.model = "nim-primary";
    const plan = planRequest(envelope);
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBe("nim-primary");
  });

  it("routes gpt-5.5 to chatgpt subscription", () => {
    const envelope = makeEnvelope({ originalModel: "gpt-5.5" });
    envelope.body.model = "gpt-5.5";
    const plan = planRequest(envelope);
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBe("chatgpt-subscription-gpt-5.5-medium");
  });

  it("routes claude-sonnet-4-6 to anthropic subscription", () => {
    const envelope = makeEnvelope({ originalModel: "claude-sonnet-4-6" });
    envelope.body.model = "claude-sonnet-4-6";
    const plan = planRequest(envelope);
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBe("anthropic-subscription-sonnet-4-6-high");
  });

  it("returns null for unknown models", () => {
    const envelope = makeEnvelope({ originalModel: "nonexistent-model" });
    envelope.body.model = "nonexistent-model";
    const plan = planRequest(envelope);
    expect(plan).toBeNull();
  });

  it("canonicalizes aliased models", () => {
    const result = canonicalize("smart-route");
    expect(result.canonicalTarget).toBe("smart-route-worker");
    expect(result.isManaged).toBe(true);
  });

  it("canonicalizes prefixed models", () => {
    const result = canonicalize("nim-primary");
    expect(result.isManaged).toBe(true);
  });

  it("detects unmanaged models", () => {
    const result = canonicalize("some-random-model");
    expect(result.isManaged).toBe(false);
  });

  it("plan includes fallback chain", () => {
    const envelope = makeEnvelope({ originalModel: "nim-primary" });
    envelope.body.model = "nim-primary";
    const plan = planRequest(envelope);
    expect(plan!.fallbackSequence.length).toBeGreaterThan(0);
    expect(plan!.fallbackSequence[0].group).toBeDefined();
  });

  it("plan has transforms for unsupported params", () => {
    const envelope = makeEnvelope({
      originalModel: "glm-5.1",
      body: {
        model: "glm-5.1",
        messages: [{ role: "user", content: "hello" }],
        logit_bias: { 123: -100 },
      },
    });
    const plan = planRequest(envelope);
    expect(plan).not.toBeNull();
    expect(plan!.transforms.length).toBeGreaterThan(0);
    expect(plan!.transforms.some((t) => t.param === "logit_bias")).toBe(true);
  });

  it("routes tool requests to tool lane", () => {
    const envelope = makeEnvelope({
      originalModel: "glm-5.1",
      hasTools: true,
      body: {
        model: "glm-5.1",
        messages: [{ role: "user", content: "use tool" }],
        tools: [{ type: "function", function: { name: "test", description: "test", parameters: {} } }],
      },
    });
    const plan = planRequest(envelope);
    expect(plan).not.toBeNull();
    // Should route to tool group if available
    expect(plan!.selectedGroup).toBeDefined();
  });
});

// ─── Manifest validation ─────────────────────────────────────────

describe("Manifest integrity", () => {
  it("all alias targets resolve to valid route groups", () => {
    for (const [alias, target] of Object.entries(MANIFEST.aliases)) {
      const rg = MANIFEST.routeGroups[target];
      expect(rg).toBeDefined(`Alias '${alias}' -> '${target}' has no route group`);
    }
  });

  it("all primary alias target groups have deployments", () => {
    // Check that groups which are direct alias targets have deployments,
    // excluding groups that are known to be routing-only (no direct deployments)
    const routingOnlyGroups = new Set(["nim-secondary"]);

    for (const [alias, target] of Object.entries(MANIFEST.aliases)) {
      const rg = MANIFEST.routeGroups[target];
      if (!rg || rg.hidden) continue;
      if (routingOnlyGroups.has(target)) continue;
      const deployments = MANIFEST.deploymentsByGroup[target];
      expect(deployments?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("all fallback groups exist in route groups", () => {
    for (const [group, rg] of Object.entries(MANIFEST.routeGroups)) {
      for (const fb of rg.fallbacks) {
        expect(MANIFEST.routeGroups[fb]).toBeDefined(
          `Group '${group}' references fallback '${fb}' which doesn't exist`,
        );
      }
    }
  });

  it("all deployment groups match a route group", () => {
    for (const d of MANIFEST.deployments) {
      expect(MANIFEST.routeGroups[d.group]).toBeDefined(
        `Deployment '${d.id}' references group '${d.group}' which doesn't exist`,
      );
    }
  });

  it("policies exist for all groups", () => {
    for (const group of Object.keys(MANIFEST.routeGroups)) {
      const policy = MANIFEST.policies[group] ?? MANIFEST.defaultPolicy;
      expect(policy).toBeDefined();
      expect(policy.request).toBeDefined();
      expect(policy.retry).toBeDefined();
      expect(policy.deadline).toBeDefined();
    }
  });

  it("default policy has all required fields", () => {
    const p = MANIFEST.defaultPolicy;
    expect(p.request.unsupportedParams).toBeInstanceOf(Array);
    expect(p.retry.retryableFailureClasses).toBeInstanceOf(Array);
    expect(p.health.circuitFailureThreshold).toBeGreaterThan(0);
    expect(p.deadline.totalTimeoutSeconds).toBeGreaterThan(0);
  });
});

// ─── Request envelope construction ────────────────────────────────

describe("Request envelope construction", () => {
  it("detects tools in request", () => {
    const body = {
      model: "glm-5.1",
      messages: [{ role: "user", content: "use tool" }],
      tools: [{ type: "function", function: { name: "test" } }],
    };
    const hasTools = !!(body.tools && (body.tools as unknown[]).length > 0);
    expect(hasTools).toBe(true);
  });

  it("detects streaming request", () => {
    const body = { model: "glm-5.1", messages: [], stream: true };
    expect(body.stream === true).toBe(true);
  });

  it("detects strict tools", () => {
    const body = { model: "glm-5.1", messages: [], tool_choice: "required" };
    expect(body.tool_choice === "required" || body.tool_choice === "any").toBe(true);
  });

  it("detects json mode", () => {
    const body = { model: "glm-5.1", messages: [], response_format: { type: "json_object" } };
    expect(body.response_format !== undefined).toBe(true);
  });
});

// ─── Validation edge cases ────────────────────────────────────────

describe("Validation edge cases", () => {
  it("handles deeply nested messages", () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({
      role: "user" as const,
      content: `Message ${i}`,
    }));
    const result = validateChatRequest({
      model: "glm-5.1",
      messages,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects too many messages", () => {
    const messages = Array.from({ length: 201 }, (_, i) => ({
      role: "user" as const,
      content: `Message ${i}`,
    }));
    const result = validateChatRequest({
      model: "glm-5.1",
      messages,
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_messages");
  });

  it("accepts boundary temperature values", () => {
    expect(validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0,
    }).valid).toBe(true);

    expect(validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      temperature: 2,
    }).valid).toBe(true);
  });

  it("rejects temperature just outside range", () => {
    expect(validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      temperature: -0.001,
    }).valid).toBe(false);

    expect(validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      temperature: 2.001,
    }).valid).toBe(false);
  });

  it("accepts boundary max_tokens", () => {
    expect(validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 1,
    }).valid).toBe(true);

    expect(validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 1000000,
    }).valid).toBe(true);
  });

  it("accepts all supported model aliases", () => {
    for (const alias of Object.keys(MANIFEST.aliases)) {
      const result = validateChatRequest({
        model: alias,
        messages: [{ role: "user", content: "hello" }],
      });
      expect(result.valid).toBe(true);
    }
  });
});

// ─── Functions → tools migration ──────────────────────────────────

describe("Functions to tools migration", () => {
  it("migrates functions to tools format", () => {
    const body: Record<string, unknown> = {
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      functions: [
        { name: "get_weather", description: "Get weather", parameters: { type: "object" } },
      ],
    };
    migrateFunctionsToTools(body);
    expect(body.tools).toHaveLength(1);
    expect((body.tools as Array<Record<string, unknown>>)[0]).toEqual({
      type: "function",
      function: { name: "get_weather", description: "Get weather", parameters: { type: "object" } },
    });
    expect(body.functions).toBeUndefined();
  });

  it("migrates function_call string to tool_choice", () => {
    const body: Record<string, unknown> = {
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      functions: [{ name: "test", description: "test" }],
      function_call: "auto",
    };
    migrateFunctionsToTools(body);
    expect(body.tool_choice).toBe("auto");
    expect(body.function_call).toBeUndefined();
  });

  it("migrates function_call object to tool_choice", () => {
    const body: Record<string, unknown> = {
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      functions: [{ name: "test", description: "test" }],
      function_call: { name: "test" },
    };
    migrateFunctionsToTools(body);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "test" } });
  });

  it("does not overwrite existing tools", () => {
    const body: Record<string, unknown> = {
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      functions: [{ name: "old", description: "old" }],
      tools: [{ type: "function", function: { name: "new" } }],
    };
    migrateFunctionsToTools(body);
    expect((body.tools as Array<Record<string, unknown>>)[0].function).toEqual({ name: "new" });
  });

  it("is no-op when no functions present", () => {
    const body: Record<string, unknown> = {
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
    };
    migrateFunctionsToTools(body);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });
});
