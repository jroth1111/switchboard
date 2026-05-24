import { describe, it, expect, vi } from "vitest";
import {
  buildAnthropicSubscriptionRequest,
  convertAnthropicToOpenAI,
  convertAnthropicStreamChunk,
  getValidAnthropicToken,
  refreshAnthropicOAuthToken,
  type OAuthAccountAccessor,
} from "../../src/providers/anthropic-subscription";
import {
  buildChatGPTResponsesRequest,
  convertResponsesToOpenAI,
  convertResponsesStreamChunk,
  validateResponsesContract,
} from "../../src/providers/chatgpt-responses";
import { buildProviderRequest } from "../../src/providers/base";
import type { Deployment } from "../../src/config/schema";

function makeDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "test-deploy",
    group: "test-group",
    provider: "anthropic_subscription",
    model: "claude-sonnet-4-6",
    providerModel: "claude-sonnet-4-6-20250514",
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
    contextWindow: 200000,
    hidden: true,
    ...overrides,
  };
}

// ─── Anthropic subscription request building ────────────────────────

describe("Anthropic subscription request builder", () => {
  it("builds a valid Messages API request", () => {
    const deploy = makeDeployment();
    const body = {
      model: "claude-sonnet-4-6",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 4096,
    };

    const req = buildAnthropicSubscriptionRequest(deploy, body, "test-token");
    const parsed = JSON.parse(req.body);

    expect(req.url).toContain("/v1/messages");
    expect(req.headers["Authorization"]).toBe("Bearer test-token");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(parsed.model).toBe("claude-sonnet-4-6-20250514");
    expect(parsed.system).toBe("You are helpful.");
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.max_tokens).toBe(4096);
  });

  it("converts tools to Anthropic format", () => {
    const deploy = makeDeployment();
    const body = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "use tool" }],
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      }],
    };

    const req = buildAnthropicSubscriptionRequest(deploy, body, "token");
    const parsed = JSON.parse(req.body);

    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].name).toBe("get_weather");
    expect(parsed.tools[0].input_schema).toBeDefined();
  });

  it("includes stream parameter", () => {
    const deploy = makeDeployment();
    const body = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    };

    const req = buildAnthropicSubscriptionRequest(deploy, body, "token");
    const parsed = JSON.parse(req.body);
    expect(parsed.stream).toBe(true);
  });

  it("converts stop to stop_sequences", () => {
    const deploy = makeDeployment();
    const body = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      stop: ["\n", "END"],
    };

    const req = buildAnthropicSubscriptionRequest(deploy, body, "token");
    const parsed = JSON.parse(req.body);
    expect(parsed.stop_sequences).toEqual(["\n", "END"]);
  });

  it("converts string stop to stop_sequences array", () => {
    const deploy = makeDeployment();
    const body = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      stop: "END",
    };

    const req = buildAnthropicSubscriptionRequest(deploy, body, "token");
    const parsed = JSON.parse(req.body);
    expect(parsed.stop_sequences).toEqual(["END"]);
  });

  it("converts tool_choice to Anthropic format", () => {
    const deploy = makeDeployment();
    const body = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "use tool" }],
      tools: [{ type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: {} } } }],
      tool_choice: "required",
    };

    const req = buildAnthropicSubscriptionRequest(deploy, body, "token");
    const parsed = JSON.parse(req.body);
    expect(parsed.tool_choice).toEqual({ type: "any" });
  });

  it("converts tool_choice with specific function name", () => {
    const deploy = makeDeployment();
    const body = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "use tool" }],
      tools: [{ type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: {} } } }],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    };

    const req = buildAnthropicSubscriptionRequest(deploy, body, "token");
    const parsed = JSON.parse(req.body);
    expect(parsed.tool_choice).toEqual({ type: "tool", name: "get_weather" });
  });

  it("converts tool_choice auto", () => {
    const deploy = makeDeployment();
    const body = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "use tool" }],
      tools: [{ type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: {} } } }],
      tool_choice: "auto",
    };

    const req = buildAnthropicSubscriptionRequest(deploy, body, "token");
    const parsed = JSON.parse(req.body);
    expect(parsed.tool_choice).toEqual({ type: "auto" });
  });

  it("merges deployment extraBody", () => {
    const deploy = makeDeployment({
      extraBody: { thinking: { type: "enabled", budget_tokens: 10000 } },
    });
    const body = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "think" }],
    };

    const req = buildAnthropicSubscriptionRequest(deploy, body, "token");
    const parsed = JSON.parse(req.body);
    expect(parsed.thinking).toBeDefined();
    expect(parsed.thinking.budget_tokens).toBe(10000);
  });

  it("does not overwrite client values with deployment extraBody", () => {
    const deploy = makeDeployment({
      extraBody: { output_config: { effort: "low" } },
    });
    const body = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hello" }],
      output_config: { effort: "high" },
    };

    const req = buildAnthropicSubscriptionRequest(deploy, body, "token");
    const parsed = JSON.parse(req.body);
    expect(parsed.output_config.effort).toBe("high");
  });

  it("does not overwrite client reasoning_effort with deployment value", () => {
    const deploy = makeDeployment({
      reasoningEffort: "low",
    });
    const body = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "think" }],
      reasoning_effort: "high",
    };

    const req = buildAnthropicSubscriptionRequest(deploy, body, "token");
    const parsed = JSON.parse(req.body);
    expect(parsed.reasoning_effort).toBe("high");
  });
});

// ─── Anthropic → OpenAI response conversion ────────────────────────

describe("Anthropic to OpenAI response conversion", () => {
  it("converts text response", () => {
    const anthropic = {
      id: "msg_test",
      model: "claude-sonnet-4-6-20250514",
      content: [{ type: "text", text: "Hello! How can I help?" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 10, output_tokens: 8 },
    };

    const openai = convertAnthropicToOpenAI(anthropic, "req-1");
    expect(openai.object).toBe("chat.completion");
    expect(openai.choices[0].message.content).toBe("Hello! How can I help?");
    expect(openai.choices[0].finish_reason).toBe("stop");
    expect(openai.usage.total_tokens).toBe(18);
  });

  it("converts tool-use response", () => {
    const anthropic = {
      id: "msg_tool",
      model: "claude-sonnet-4-6-20250514",
      content: [
        { type: "text", text: "Let me check." },
        { type: "tool_use", id: "tu_1", name: "get_weather", input: { city: "SF" } },
      ],
      stop_reason: "tool_use",
      usage: { input_tokens: 20, output_tokens: 15 },
    };

    const openai = convertAnthropicToOpenAI(anthropic, "req-2");
    expect(openai.choices[0].message.tool_calls).toHaveLength(1);
    expect(openai.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
    expect(openai.choices[0].finish_reason).toBe("tool_calls");
  });

  it("maps max_tokens stop_reason to length finish_reason", () => {
    const anthropic = {
      id: "msg_max",
      model: "claude-sonnet-4-6-20250514",
      content: [{ type: "text", text: "Truncated response..." }],
      stop_reason: "max_tokens",
      usage: { input_tokens: 10, output_tokens: 100 },
    };

    const openai = convertAnthropicToOpenAI(anthropic, "req-3");
    expect(openai.choices[0].finish_reason).toBe("length");
  });
});

// ─── Anthropic stream chunk conversion ─────────────────────────────

describe("Anthropic stream chunk conversion", () => {
  it("converts text delta", () => {
    const chunk = convertAnthropicStreamChunk(
      { type: "content_block_delta", delta: { type: "text_delta", text: "Hello" } },
      "req-1",
      "claude-sonnet-4-6",
    );
    expect(chunk).not.toBeNull();
    expect(chunk!.choices[0].delta.content).toBe("Hello");
  });

  it("converts stop reason", () => {
    const chunk = convertAnthropicStreamChunk(
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      "req-1",
      "claude-sonnet-4-6",
    );
    expect(chunk).not.toBeNull();
    expect(chunk!.choices[0].finish_reason).toBe("stop");
  });

  it("maps max_tokens stop reason to length", () => {
    const chunk = convertAnthropicStreamChunk(
      { type: "message_delta", delta: { stop_reason: "max_tokens" } },
      "req-1",
      "claude-sonnet-4-6",
    );
    expect(chunk).not.toBeNull();
    expect(chunk!.choices[0].finish_reason).toBe("length");
  });

  it("maps tool_use stop reason to tool_calls", () => {
    const chunk = convertAnthropicStreamChunk(
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      "req-1",
      "claude-sonnet-4-6",
    );
    expect(chunk).not.toBeNull();
    expect(chunk!.choices[0].finish_reason).toBe("tool_calls");
  });

  it("returns null for ping", () => {
    const chunk = convertAnthropicStreamChunk(
      { type: "ping" },
      "req-1",
      "claude-sonnet-4-6",
    );
    expect(chunk).toBeNull();
  });
});

// ─── OAuth token refresh ───────────────────────────────────────────

describe("OAuth token management", () => {
  it("getValidAnthropicToken returns valid token without refresh", async () => {
    const mockAccessor: OAuthAccountAccessor = {
      getToken: vi.fn().mockResolvedValue({
        accessToken: "valid-token",
        expiresAt: Date.now() + 3600000,
      }),
      setToken: vi.fn(),
      acquireRefreshLock: vi.fn(),
      releaseRefreshLock: vi.fn(),
    };

    const result = await getValidAnthropicToken("acc-1", "req-1", mockAccessor, { clientId: "test" });
    if ("token" in result) {
      expect(result.token).toBe("valid-token");
      expect(result.refreshed).toBe(false);
    } else {
      expect.fail("Expected token result");
    }
  });

  it("getValidAnthropicToken refreshes expired token and stores new one", async () => {
    const setTokenMock = vi.fn();
    const mockAccessor: OAuthAccountAccessor = {
      getToken: vi.fn()
        .mockResolvedValueOnce({ accessToken: "expired", expiresAt: Date.now() - 1000, refreshToken: "refresh-me" })
        .mockResolvedValueOnce({ accessToken: "new-token", expiresAt: Date.now() + 3600000 }),
      setToken: setTokenMock,
      acquireRefreshLock: vi.fn().mockResolvedValue(true),
      releaseRefreshLock: vi.fn(),
    };

    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      access_token: "new-token",
      refresh_token: "refresh-new",
      expires_in: 3600,
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await getValidAnthropicToken("acc-1", "req-1", mockAccessor, {
        clientId: "test-client",
      });

      expect(fetchMock).toHaveBeenCalledWith("https://api.anthropic.com/v1/oauth/token", expect.objectContaining({
        method: "POST",
      }));
      expect(mockAccessor.acquireRefreshLock).toHaveBeenCalledWith("acc-1", "req-1", 30000);
      expect(mockAccessor.releaseRefreshLock).toHaveBeenCalledWith("acc-1", "req-1");
      expect(setTokenMock).toHaveBeenCalledWith("acc-1", "anthropic_subscription", "new-token", "refresh-new", expect.any(Number));
      if ("token" in result) {
        expect(result.token).toBe("new-token");
        expect(result.refreshed).toBe(true);
      } else {
        expect.fail(`Expected refreshed token result, got ${result.failureClass}`);
      }
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("getValidAnthropicToken returns error when no token stored", async () => {
    const mockAccessor: OAuthAccountAccessor = {
      getToken: vi.fn().mockResolvedValue(null),
      setToken: vi.fn(),
      acquireRefreshLock: vi.fn(),
      releaseRefreshLock: vi.fn(),
    };

    const result = await getValidAnthropicToken("acc-1", "req-1", mockAccessor, { clientId: "test" });
    if ("error" in result) {
      expect(result.error).toBe("no_token_stored");
      expect(result.failureClass).toBe("oauth_session_failure");
    } else {
      expect.fail("Expected error result");
    }
  });

  it("getValidAnthropicToken waits for an in-flight refresh lock before failing", async () => {
    const mockAccessor: OAuthAccountAccessor = {
      getToken: vi.fn()
        .mockResolvedValueOnce({ accessToken: "expired", expiresAt: Date.now() - 1000, refreshToken: "refresh-me" })
        .mockResolvedValueOnce({ accessToken: "fresh-from-peer", expiresAt: Date.now() + 3600000 }),
      setToken: vi.fn(),
      acquireRefreshLock: vi.fn().mockResolvedValue(false),
      releaseRefreshLock: vi.fn(),
    };

    const result = await getValidAnthropicToken("acc-1", "req-2", mockAccessor, { clientId: "test" });

    expect(mockAccessor.acquireRefreshLock).toHaveBeenCalledWith("acc-1", "req-2", 30000);
    expect(mockAccessor.getToken).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ token: "fresh-from-peer", refreshed: true });
    expect(mockAccessor.releaseRefreshLock).not.toHaveBeenCalled();
  });
});

// ─── ChatGPT Responses request building ────────────────────────────

describe("ChatGPT Responses request builder", () => {
  it("builds a valid Responses API request", () => {
    const deploy = makeDeployment({
      provider: "chatgpt",
      mode: "responses",
      providerModel: "gpt-5.5",
      apiBase: "https://api.openai.com",
    });
    const body = {
      model: "gpt-5.5",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "Hello" },
      ],
      max_tokens: 4096,
    };

    const req = buildChatGPTResponsesRequest(deploy, body, "chatgpt-token");
    const parsed = JSON.parse(req.body);

    expect(req.url).toContain("/v1/responses");
    expect(req.headers["Authorization"]).toBe("Bearer chatgpt-token");
    expect(parsed.model).toBe("gpt-5.5");
    expect(parsed.instructions).toBe("You are helpful.");
    expect(parsed.input).toHaveLength(1);
    expect(parsed.input[0].role).toBe("user");
    expect(parsed.max_output_tokens).toBe(4096);
  });

  it("converts tools to Responses format", () => {
    const deploy = makeDeployment({
      provider: "chatgpt",
      mode: "responses",
      providerModel: "gpt-5.5",
    });
    const body = {
      model: "gpt-5.5",
      messages: [{ role: "user", content: "use tool" }],
      tools: [{
        type: "function",
        function: {
          name: "get_weather",
          description: "Get weather",
          parameters: { type: "object", properties: { city: { type: "string" } } },
        },
      }],
    };

    const req = buildChatGPTResponsesRequest(deploy, body, "token");
    const parsed = JSON.parse(req.body);

    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].type).toBe("function");
    expect(parsed.tools[0].name).toBe("get_weather");
  });
});

// ─── Responses → OpenAI response conversion ────────────────────────

describe("Responses to OpenAI response conversion", () => {
  it("converts text response", () => {
    const responsesApi = {
      id: "resp_test",
      model: "gpt-5.5",
      output: [
        { type: "message", content: [{ type: "output_text", text: "Hello there!" }] },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };

    const openai = convertResponsesToOpenAI(responsesApi, "req-1");
    expect(openai.object).toBe("chat.completion");
    expect(openai.choices[0].message.content).toBe("Hello there!");
    expect(openai.choices[0].finish_reason).toBe("stop");
  });

  it("converts tool-use response", () => {
    const responsesApi = {
      id: "resp_tool",
      model: "gpt-5.5",
      output: [
        { type: "function_call", id: "fc_1", name: "get_weather", arguments: '{"city":"SF"}' },
      ],
      usage: { input_tokens: 15, output_tokens: 10 },
    };

    const openai = convertResponsesToOpenAI(responsesApi, "req-2");
    expect(openai.choices[0].message.tool_calls).toHaveLength(1);
    expect(openai.choices[0].message.tool_calls[0].function.name).toBe("get_weather");
    expect(openai.choices[0].finish_reason).toBe("tool_calls");
  });
});

// ─── Responses stream chunk conversion ─────────────────────────────

describe("Responses stream chunk conversion", () => {
  it("converts text delta", () => {
    const chunk = convertResponsesStreamChunk(
      { type: "response.output_text.delta", delta: "Hello" },
      "req-1",
      "gpt-5.5",
    );
    expect(chunk).not.toBeNull();
    expect(chunk!.choices[0].delta.content).toBe("Hello");
  });

  it("converts completion event", () => {
    const chunk = convertResponsesStreamChunk(
      { type: "response.completed", response: { status: "completed" } },
      "req-1",
      "gpt-5.5",
    );
    expect(chunk).not.toBeNull();
    expect(chunk!.choices[0].finish_reason).toBe("stop");
  });

  it("converts incomplete to length finish", () => {
    const chunk = convertResponsesStreamChunk(
      { type: "response.completed", response: { status: "incomplete" } },
      "req-1",
      "gpt-5.5",
    );
    expect(chunk).not.toBeNull();
    expect(chunk!.choices[0].finish_reason).toBe("length");
  });

  it("returns null for unknown events", () => {
    const chunk = convertResponsesStreamChunk(
      { type: "response.created" },
      "req-1",
      "gpt-5.5",
    );
    expect(chunk).toBeNull();
  });
});

// ─── Responses contract validation ─────────────────────────────────

describe("Responses contract validation", () => {
  it("accepts valid request", () => {
    const result = validateResponsesContract({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects response_format", () => {
    const result = validateResponsesContract({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      response_format: { type: "json_object" },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("response_format");
  });

  it("rejects n > 1", () => {
    const result = validateResponsesContract({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      n: 3,
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("n > 1");
  });

  it("accepts n = 1", () => {
    const result = validateResponsesContract({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      n: 1,
    });
    expect(result.valid).toBe(true);
  });

  it("strips unsupported params", () => {
    const result = validateResponsesContract({
      model: "gpt-5.5",
      messages: [{ role: "user", content: "hello" }],
      frequency_penalty: 0.5,
      stop: ["\n"],
      seed: 42,
    });
    expect(result.valid).toBe(true);
    expect(result.strippedParams).toContain("frequency_penalty");
    expect(result.strippedParams).toContain("stop");
    expect(result.strippedParams).toContain("seed");
  });
});

// ─── Base provider request builder ──────────────────────────────────

describe("Base provider request builder", () => {
  it("merges extraBody into request", () => {
    const deploy = makeDeployment({
      provider: "openai",
      extraBody: { top_logprobs: 5, logprobs: true },
    });
    const body = { messages: [{ role: "user", content: "hi" }] };
    const req = buildProviderRequest(deploy, body, "sk-test");
    const parsed = JSON.parse(req.body);
    expect(parsed.top_logprobs).toBe(5);
    expect(parsed.logprobs).toBe(true);
  });

  it("extraBody does not overwrite client values", () => {
    const deploy = makeDeployment({
      provider: "openai",
      extraBody: { temperature: 0.9 },
    });
    const body = { messages: [{ role: "user", content: "hi" }], temperature: 0.3 };
    const req = buildProviderRequest(deploy, body, "sk-test");
    const parsed = JSON.parse(req.body);
    expect(parsed.temperature).toBe(0.3);
  });

  it("reasoningEffort does not overwrite client value", () => {
    const deploy = makeDeployment({
      provider: "openai",
      reasoningEffort: "high",
    });
    const body = { messages: [{ role: "user", content: "hi" }], reasoning_effort: "low" };
    const req = buildProviderRequest(deploy, body, "sk-test");
    const parsed = JSON.parse(req.body);
    expect(parsed.reasoning_effort).toBe("low");
  });

  it("reasoningEffort is applied when client didn't specify", () => {
    const deploy = makeDeployment({
      provider: "openai",
      reasoningEffort: "high",
    });
    const body = { messages: [{ role: "user", content: "hi" }] };
    const req = buildProviderRequest(deploy, body, "sk-test");
    const parsed = JSON.parse(req.body);
    expect(parsed.reasoning_effort).toBe("high");
  });

  it("params do not overwrite client values", () => {
    const deploy = makeDeployment({
      provider: "openai",
      params: { temperature: 0.9, max_tokens: 4096 },
    });
    const body = { messages: [{ role: "user", content: "hi" }], temperature: 0.1 };
    const req = buildProviderRequest(deploy, body, "sk-test");
    const parsed = JSON.parse(req.body);
    expect(parsed.temperature).toBe(0.1);
    expect(parsed.max_tokens).toBe(4096);
  });

  it("sets correct headers for anthropic_subscription provider", () => {
    const deploy = makeDeployment({ provider: "anthropic_subscription" });
    const body = { messages: [{ role: "user", content: "hi" }] };
    const req = buildProviderRequest(deploy, body, "sk-ant");
    expect(req.headers["x-api-key"]).toBe("sk-ant");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
  });

  it("sets Bearer auth for openai provider", () => {
    const deploy = makeDeployment({ provider: "openai" });
    const body = { messages: [{ role: "user", content: "hi" }] };
    const req = buildProviderRequest(deploy, body, "sk-oai");
    expect(req.headers["Authorization"]).toBe("Bearer sk-oai");
  });
});
