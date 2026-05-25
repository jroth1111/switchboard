import { describe, it, expect, vi, beforeEach } from "vitest";
import { executeAttemptLoop } from "../../src/attempts/attempt-loop";
import {
  admit,
  release,
  recordSuccess,
  recordFailure,
} from "../../src/state/admission-engine";
import { InMemoryStorageAdapter } from "../../src/state/storage-adapter";
import {
  buildProviderRequest,
  type ProviderRequest,
} from "../../src/providers/base";
import {
  buildAnthropicSubscriptionRequest,
  convertAnthropicToOpenAI,
  convertAnthropicStreamChunk,
} from "../../src/providers/anthropic-subscription";
import {
  buildChatGPTResponsesRequest,
  convertResponsesToOpenAI,
  convertResponsesStreamChunk,
  validateResponsesContract,
} from "../../src/providers/chatgpt-responses";
import {
  evaluateResponse,
  type ResponseEvaluationConfig,
} from "../../src/nim/evaluate/response";
import {
  planRequest,
  canonicalize,
  applyTransforms,
  type RequestEnvelope,
} from "../../src/planner/planner";
import { MANIFEST } from "../../src/config/manifest";
import type { Deployment } from "../../src/config/schema";

function candidate(
  deploymentId: string,
  keyRef = "key-1",
  rpm = 35,
  maxParallel = 2,
  group = "test",
) {
  return { deploymentId, keyRef, rpm, maxParallel, group };
}

function makeDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "test-deploy",
    group: "test-group",
    provider: "nvidia_nim",
    model: "test-model",
    providerModel: "test-model-v1",
    keyRef: "TEST_KEY",
    rpm: 10,
    maxParallelRequests: 2,
    timeout: 30,
    streamTimeout: 120,
    supportsStreaming: true,
    capabilities: {
      toolCalling: "native",
      streamingWithTools: "native",
      jsonMode: "native",
      reasoning: "native",
      multimodal: "native",
    },
    contextWindow: 128000,
    hidden: false,
    ...overrides,
  };
}

function structuredChatGPTAuth(): string {
  return JSON.stringify({
    access_token: "access-secret",
    refresh_token: "refresh-secret",
    id_token: "id-secret",
  });
}

function makeEvalConfig(): ResponseEvaluationConfig {
  return {
    enableSemanticValidation: true,
    enableToolRepair: true,
    enableSpecialTokenDetection: true,
    enableRepetitionDetection: true,
    semanticMinChars: 1,
    semanticMinEntropy: 2.5,
    semanticMinPrintableRatio: 0.8,
    repetitionMaxRatio: 0.4,
    stripReasoningFromSuccess: true,
    enableSchemaAwareRepair: false,
    repairPolicy: {
      allowDestructive: false,
      enumAliases: {},
      toolNameAliases: {},
      relationalDefaults: {},
    },
  };
}

// ─── Provider request building ────────────────────────────────────

describe("Provider request building integration", () => {
  it("builds NIM request with correct URL and headers", () => {
    const deploy = makeDeployment({
      provider: "nvidia_nim",
      apiBase: "https://integrate.api.nvidia.com/v1",
    });
    const req = buildProviderRequest(deploy, {
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
    }, "nim-api-key");

    expect(req.url).toBe("https://integrate.api.nvidia.com/v1/chat/completions");
    expect(req.headers["Authorization"]).toBe("Bearer nim-api-key");
    const body = JSON.parse(req.body);
    expect(body.model).toBe("test-model-v1");
  });

  it("builds OpenAI request with correct format", () => {
    const deploy = makeDeployment({
      provider: "openai",
      apiBase: "https://api.openai.com/v1",
    });
    const req = buildProviderRequest(deploy, {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 100,
    }, "openai-key");

    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    const body = JSON.parse(req.body);
    expect(body.model).toBe("test-model-v1");
    expect(body.max_tokens).toBe(100);
  });

  it("merges deployment params", () => {
    const deploy = makeDeployment({
      params: { temperature: 0.7, top_p: 0.95 },
    });
    const req = buildProviderRequest(deploy, {
      model: "test",
      messages: [{ role: "user", content: "hello" }],
    }, "key");

    const body = JSON.parse(req.body);
    expect(body.temperature).toBe(0.7);
    expect(body.top_p).toBe(0.95);
  });

  it("does not override explicit params with deployment params", () => {
    const deploy = makeDeployment({
      params: { temperature: 0.7 },
    });
    const req = buildProviderRequest(deploy, {
      model: "test",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0.3,
    }, "key");

    const body = JSON.parse(req.body);
    expect(body.temperature).toBe(0.3);
  });
});

// End-to-end flow: plan -> admit -> evaluate

describe("End-to-end plan -> admit -> evaluate flow", () => {
  it("plans, admits, and evaluates a successful request", () => {
    // 1. Plan
    const envelope: RequestEnvelope = {
      requestId: "req-e2e-1",
      originalModel: "nim-primary",
      body: { model: "nim-primary", messages: [{ role: "user", content: "Hello" }] },
      stream: false,
      hasTools: false,
      hasStrictTools: false,
      hasTypedContent: false,
      requiresJsonMode: false,
    };
    const plan = planRequest(envelope);
    expect(plan).not.toBeNull();
    expect(plan!.selectedDeployments.length).toBeGreaterThan(0);

    // 2. Admit
    const store = new InMemoryStorageAdapter();
    const deployment = plan!.selectedDeployments[0];
    const admission = admit(store, {
      requestId: "req-e2e-1",
      candidates: [{
        deploymentId: deployment.id,
        keyRef: deployment.keyRef,
        rpm: deployment.rpm,
        maxParallel: deployment.maxParallelRequests,
        group: deployment.group,
      }],
    });
    expect(admission.admitted).toBe(true);

    // 3. Build provider request
    const apiKey = "test-key";
    const providerReq = buildProviderRequest(deployment, envelope.body, apiKey);
    expect(providerReq.url).toBeDefined();
    expect(providerReq.body).toBeDefined();

    // 4. Simulate successful response
    const mockResponse = {
      id: "chatcmpl-123",
      object: "chat.completion",
      model: deployment.providerModel,
      choices: [{
        index: 0,
        message: { role: "assistant", content: "Hello! How can I help you today?" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
    };

    // 5. Evaluate
    const evaluation = evaluateResponse(envelope.body, mockResponse, makeEvalConfig());
    expect(evaluation.action).toBe("accept");

    // 6. Record success
    recordSuccess(store, admission.deploymentId!);
    release(store, admission.reservationId!);

    const health = store.getHealthScore(admission.deploymentId!);
    expect(health!.score).toBeGreaterThan(0);
  });

  it("handles failure -> cooldown -> fallback flow", () => {
    const store = new InMemoryStorageAdapter();

    // First deployment fails
    const c1 = candidate("deploy-1", "key-1", 35, 2, "primary");
    const c2 = candidate("deploy-2", "key-2", 35, 2, "fallback");

    // Admit to first
    const r1 = admit(store, { requestId: "req-1", candidates: [c1, c2] });
    expect(r1.admitted).toBe(true);
    expect(r1.deploymentId).toBe("deploy-1");

    // Simulate failure and release
    release(store, r1.reservationId!);
    recordFailure(store, "deploy-1", "rate_limit_overload", 30, 5, 300);

    // Next request should skip deploy-1 (cooldown)
    const r2 = admit(store, { requestId: "req-2", candidates: [c1, c2] });
    expect(r2.admitted).toBe(true);
    expect(r2.deploymentId).toBe("deploy-2");

    // deploy-2 succeeds
    release(store, r2.reservationId!);
    recordSuccess(store, "deploy-2");

    // Overload pressure keeps fallback behavior without poisoning route health.
    expect(store.getHealthScore("deploy-1")!.score).toBe(100);
    expect(store.getCircuit("deploy-1")).toBeNull();
    expect(store.getHealthScore("deploy-2")!.score).toBeGreaterThan(0);
  });

  it("handles circuit breaker opening after repeated failures", () => {
    const store = new InMemoryStorageAdapter();
    const c = candidate("deploy-1");

    // 5 failures should open circuit (threshold = 5)
    for (let i = 0; i < 5; i++) {
      const r = admit(store, { requestId: `req-${i}`, candidates: [c] });
      if (r.admitted) release(store, r.reservationId!);
      recordFailure(store, "deploy-1", "server_5xx", 0, 5, 300);
    }

    // Circuit should be open
    const circuit = store.getCircuit("deploy-1");
    expect(circuit?.state).toBe("open");

    // Should reject with circuit_open
    const r = admit(store, { requestId: "req-6", candidates: [c] });
    expect(r.admitted).toBe(false);
    expect(r.rejected?.[0]?.reason).toBe("circuit_open");
  });

  it("handles learned concurrency limits", () => {
    const store = new InMemoryStorageAdapter();
    const c = candidate("deploy-1", "key-1", 35, 4, "test");

    // Admit a request (inflight becomes 1)
    admit(store, { requestId: "req-1", candidates: [c] });

    // Simulate concurrency rate limit
    recordFailure(store, "deploy-1", "rate_limit_concurrency", 0, 5, 300);

    // Learned limit should be lower: inflight was 1, so max(1, 1-1) = 1
    const limit = store.getLearnedLimit("deploy-1", Date.now());
    expect(limit).toBeDefined();
    expect(limit!.maxParallel).toBeLessThan(4);
    expect(limit!.maxParallel).toBeGreaterThanOrEqual(1);

    // Current inflight is 1, learned max is 1, so second admit should be rejected
    const r2 = admit(store, { requestId: "req-2", candidates: [c] });
    expect(r2.admitted).toBe(false);
    expect(r2.rejected?.[0]?.reason).toBe("inflight_exhausted");
  });

  it("handles key RPM rotation", () => {
    const store = new InMemoryStorageAdapter();
    const c1 = candidate("deploy-1", "key-1", 1, 10, "test");
    const c2 = candidate("deploy-1", "key-2", 1, 10, "test");

    // Use key-1
    const r1 = admit(store, { requestId: "req-1", candidates: [c1, c2] });
    expect(r1.keyRef).toBe("key-1");

    // key-1 exhausted, should use key-2
    const r2 = admit(store, { requestId: "req-2", candidates: [c1, c2] });
    expect(r2.keyRef).toBe("key-2");

    // Both exhausted
    const r3 = admit(store, { requestId: "req-3", candidates: [c1, c2] });
    expect(r3.admitted).toBe(false);
  });
});

// ─── Response evaluation integration ──────────────────────────────

describe("Response evaluation integration", () => {
  const evalConfig = makeEvalConfig();

  it("accepts good response", () => {
    const body = { model: "glm-5.1", messages: [{ role: "user", content: "hello" }] };
    const response = {
      id: "chatcmpl-1",
      choices: [{
        message: { role: "assistant", content: "Hello! How can I help?" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 6, total_tokens: 11 },
    };
    const evaluation = evaluateResponse(body, response, evalConfig);
    expect(evaluation.action).toBe("accept");
  });

  it("detects empty response", () => {
    const body = { model: "glm-5.1", messages: [{ role: "user", content: "hello" }] };
    const response = {
      id: "chatcmpl-2",
      choices: [{
        message: { role: "assistant", content: "" },
        finish_reason: "stop",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 0, total_tokens: 5 },
    };
    const evaluation = evaluateResponse(body, response, evalConfig);
    expect(evaluation.action).not.toBe("accept");
  });

  it("handles tool call response", () => {
    const body = {
      model: "glm-5.1",
      messages: [{ role: "user", content: "weather?" }],
      tools: [{
        type: "function",
        function: { name: "get_weather", parameters: { type: "object", properties: { city: { type: "string" } } } },
      }],
    };
    const response = {
      id: "chatcmpl-3",
      choices: [{
        message: {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call_1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"SF"}' },
          }],
        },
        finish_reason: "tool_calls",
      }],
      usage: { prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 },
    };
    const evaluation = evaluateResponse(body, response, evalConfig);
    expect(evaluation.action).toBe("accept");
  });

  it("detects truncated response", () => {
    const body = { model: "glm-5.1", messages: [{ role: "user", content: "write a lot" }] };
    const response = {
      id: "chatcmpl-4",
      choices: [{
        message: { role: "assistant", content: "Once upon a time there was a" },
        finish_reason: "length",
      }],
      usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
    };
    const evaluation = evaluateResponse(body, response, evalConfig);
    expect(evaluation.action).toBe("retry_fallback");
    expect(evaluation.failureClass).toBe("truncated_response");
    expect(evaluation.failureMessage).toBe("finish_reason_length_truncation");
  });
});

// ─── Provider format conversion integration ───────────────────────

describe("Provider format conversion integration", () => {
  it("round-trips Anthropic subscription -> OpenAI format", () => {
    const deploy = makeDeployment({
      provider: "anthropic_subscription",
      providerModel: "claude-sonnet-4-6-20250514",
    });
    const body = {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "Be helpful." },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 1024,
    };
    const req = buildAnthropicSubscriptionRequest(deploy, body, "test-token");
    const parsed = JSON.parse(req.body);
    expect(parsed.model).toBe("claude-sonnet-4-6-20250514");
    expect(parsed.system[0].text).toMatch(/^x-anthropic-billing-header:/);
    expect(parsed.system[1].text).toBe("You are a Claude agent, built on Anthropic's Claude Agent SDK.");
    expect(parsed.system[2].text).toBe("Be helpful.");
    expect(parsed.messages).toHaveLength(1);

    // Convert response
    const anthropicResponse = {
      id: "msg_test",
      model: "claude-sonnet-4-6-20250514",
      content: [{ type: "text", text: "Hello!" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const openai = convertAnthropicToOpenAI(anthropicResponse, "req-1");
    expect(openai.choices[0].message.content).toBe("Hello!");
    expect(openai.usage.total_tokens).toBe(15);
  });

  it("round-trips ChatGPT Responses -> OpenAI format", () => {
    const deploy = makeDeployment({
      provider: "chatgpt",
      mode: "responses",
      providerModel: "gpt-5.5",
      reasoningEffort: "medium",
    });
    const body = {
      model: "gpt-5.5",
      input: "Hello",
      instructions: "Be helpful.",
    };

    const contract = validateResponsesContract(body);
    expect(contract.valid).toBe(true);

    const req = buildChatGPTResponsesRequest(deploy, body, structuredChatGPTAuth());
    const parsed = JSON.parse(req.body);
    expect(parsed.model).toBe("gpt-5.5");
    expect(parsed.instructions).toBe("Be helpful.");
    expect(parsed.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }]);
    expect(parsed.stream).toBe(true);
    expect(parsed.store).toBe(false);
    expect(parsed.include).toContain("reasoning.encrypted_content");

    // Convert response
    const responsesApi = {
      id: "resp_1",
      model: "gpt-5.5",
      output: [{ type: "message", content: [{ type: "output_text", text: "Hi!" }] }],
      usage: { input_tokens: 8, output_tokens: 3 },
    };
    const openai = convertResponsesToOpenAI(responsesApi, "req-1");
    expect(openai.choices[0].message.content).toBe("Hi!");
    expect(openai.usage.total_tokens).toBe(11);
  });
});

describe("ChatGPT Responses auth resolution in the attempt loop", () => {
  function makeResponsesEnvelope(): RequestEnvelope {
    return {
      requestId: "req-chatgpt-auth",
      originalModel: "gpt-5.5",
      surface: "responses",
      body: { model: "gpt-5.5", input: "Hello" },
      stream: false,
      hasTools: false,
      hasStrictTools: false,
      isMultiTool: false,
      hasTypedContent: false,
      requiresJsonMode: false,
      requiresReasoning: false,
    };
  }

  function makeAttemptState() {
    let reservation = 0;
    return {
      admit: vi.fn(async (req: { candidates: Array<{ deploymentId: string; keyRef: string }> }) => {
        const candidate = req.candidates[0];
        if (!candidate) return { admitted: false, rejected: [] };
        reservation += 1;
        return {
          admitted: true,
          deploymentId: candidate.deploymentId,
          keyRef: candidate.keyRef,
          reservationId: `res-chatgpt-${reservation}`,
          inflightAtDispatch: 0,
          effectiveMaxParallel: 1,
        };
      }),
      confirm: vi.fn(async () => {}),
      recordSuccess: vi.fn(async () => {}),
      recordFailure: vi.fn(async () => {}),
      recordTokenUsage: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
      getHealth: vi.fn(async () => ({ healthScores: {}, circuits: {} })),
      recordRouteDispatch: vi.fn(async () => {}),
      storeUsageEvent: vi.fn(async () => {}),
    };
  }

  it("uses CHATGPT_AUTH_JSON as the primary auth material and sends only access_token upstream", async () => {
    const envelope = makeResponsesEnvelope();
    const plan = planRequest(envelope)!;
    const state = makeAttemptState();
    const fetchMock = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer access-secret");
      expect(String(init?.body)).not.toContain("refresh-secret");
      expect(String(init?.body)).not.toContain("id-secret");
      return new Response(JSON.stringify({
        id: "resp_structured_auth",
        model: "gpt-5.5",
        output: [{ type: "message", content: [{ type: "output_text", text: "Structured auth produced a complete successful response." }] }],
        usage: { input_tokens: 2, output_tokens: 8 },
      }), { status: 200, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await executeAttemptLoop(
        envelope,
        plan,
        state as unknown as Parameters<typeof executeAttemptLoop>[2],
        { CHATGPT_AUTH_JSON: structuredChatGPTAuth(), CHATGPT_OAUTH: "legacy-token" },
        AbortSignal.timeout(5_000),
      );

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(state.admit.mock.calls[0][0].candidates[0].keyRef).toBe("CHATGPT_AUTH_JSON");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects CHATGPT_AUTH_FILE path strings before they can become bearer tokens", async () => {
    const envelope = makeResponsesEnvelope();
    const plan = planRequest(envelope)!;
    const state = makeAttemptState();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await executeAttemptLoop(
        envelope,
        plan,
        state as unknown as Parameters<typeof executeAttemptLoop>[2],
        { CHATGPT_AUTH_FILE: ".secrets/chatgpt-auth.json", CHATGPT_OAUTH: "legacy-token" },
        AbortSignal.timeout(5_000),
      );

      expect(result.success).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.attempts[0].failureClass).toBe("oauth_session_failure");
      expect(result.attempts[0].failureMessage).toContain("CHATGPT_AUTH_FILE must contain structured ChatGPT subscription auth JSON");
      expect(result.attempts[0].failureMessage).not.toContain(".secrets/chatgpt-auth.json");
      expect(result.attempts[0].failureMessage).not.toContain("legacy-token");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("rejects legacy CHATGPT_OAUTH-only auth before provider fetch", async () => {
    const envelope = makeResponsesEnvelope();
    const plan = planRequest(envelope)!;
    const state = makeAttemptState();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await executeAttemptLoop(
        envelope,
        plan,
        state as unknown as Parameters<typeof executeAttemptLoop>[2],
        { CHATGPT_OAUTH: "legacy-token" },
        AbortSignal.timeout(5_000),
      );

      expect(result.success).toBe(false);
      expect(fetchMock).not.toHaveBeenCalled();
      expect(result.attempts[0].failureClass).toBe("oauth_session_failure");
      expect(result.attempts[0].failureMessage).toContain("requires structured CHATGPT_AUTH_JSON or CHATGPT_AUTH_FILE");
      expect(result.attempts[0].failureMessage).not.toContain("legacy-token");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ─── Transform application ────────────────────────────────────────

describe("Request transform application", () => {
  it("strips unsupported params", () => {
    const body = {
      model: "glm-5.1",
      messages: [],
      logit_bias: { 123: -100 },
      logprobs: true,
    };
    const result = applyTransforms(body, [
      { type: "strip_param", param: "logit_bias" },
      { type: "strip_param", param: "logprobs" },
    ]);
    expect(result.logit_bias).toBeUndefined();
    expect(result.logprobs).toBeUndefined();
    expect(result.model).toBe("glm-5.1");
  });

  it("sets params", () => {
    const body = { model: "glm-5.1", messages: [] };
    const result = applyTransforms(body, [
      { type: "set_param", param: "temperature", value: 0.5 },
    ]);
    expect(result.temperature).toBe(0.5);
  });
});
