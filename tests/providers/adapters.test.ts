import { afterEach, describe, it, expect, vi } from "vitest";
import {
  ANTHROPIC_OAUTH_TOKEN_URL,
  CLAUDE_AI_OAUTH_SCOPE,
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
import { buildProviderRequest, executeProviderRequest } from "../../src/providers/base";
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

function structuredChatGPTAuth(accessToken = "chatgpt-token"): string {
  return JSON.stringify({
    access_token: accessToken,
    refresh_token: "chatgpt-refresh-token",
    id_token: "chatgpt-id-token",
  });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

function stubClaudeCodeEnv(overrides: Record<string, string> = {}): void {
  for (const [key, value] of Object.entries({
    ANTHROPIC_SUBSCRIPTION_CLAUDE_CODE_VERSION: "1.2.3",
    ANTHROPIC_SUBSCRIPTION_NODE_VERSION: "v22.11.0",
    CLAUDE_CODE_SESSION_ID: "session-123",
    CLAUDE_CODE_NONINTERACTIVE: "1",
    USER_TYPE: "external",
    CLAUDE_CODE_ENTRYPOINT: "cli",
    CLAUDE_CODE_WORKLOAD: "coding-harness",
    CLAUDE_CODE_DEVICE_ID: "device-abc",
    CLAUDE_CODE_ACCOUNT_UUID: "acct-xyz",
    ...overrides,
  })) {
    vi.stubEnv(key, value);
  }
}

// ─── Anthropic subscription request building ────────────────────────

describe("Anthropic subscription request builder", () => {
  it("builds a Claude Code-shaped Messages API request", () => {
    stubClaudeCodeEnv();
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

    expect(req.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
    expect(req.headers.authorization).toBe("Bearer test-token");
    expect(req.headers["anthropic-version"]).toBe("2023-06-01");
    expect(req.headers["x-app"]).toBe("cli");
    expect(req.headers["x-claude-code-session-id"]).toBe("session-123");
    expect(req.headers["user-agent"]).toBe("claude-cli/1.2.3 (external, cli, workload/coding-harness)");
    expect(req.headers["x-stainless-lang"]).toBe("js");
    expect(req.headers["x-stainless-package-version"]).toBe("0.81.0");
    expect(req.headers["x-stainless-runtime"]).toBe("node");
    expect(req.headers["x-stainless-runtime-version"]).toBe("v22.11.0");
    expect(req.headers["x-stainless-retry-count"]).toBe("0");
    expect(req.headers["x-stainless-timeout"]).toBe("600000");
    expect(req.headers["content-length"]).toBe(String(new TextEncoder().encode(req.body).length));
    expect(req.headers["anthropic-beta"]).toBe([
      "claude-code-20250219",
      "oauth-2025-04-20",
      "interleaved-thinking-2025-05-14",
      "context-management-2025-06-27",
      "prompt-caching-scope-2026-01-05",
      "effort-2025-11-24",
    ].join(","));
    expect(parsed.model).toBe("claude-sonnet-4-6-20250514");
    expect(parsed.system[0].text).toMatch(/^x-anthropic-billing-header: cc_version=1\.2\.3\.[0-9a-f]{3}; cc_entrypoint=cli; cch=[0-9a-f]{5}; cc_workload=coding-harness;$/);
    expect(parsed.system[1]).toEqual({
      type: "text",
      text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
      cache_control: { type: "ephemeral" },
    });
    expect(parsed.system[2]).toEqual({
      type: "text",
      text: "You are helpful.",
      cache_control: { type: "ephemeral" },
    });
    expect(JSON.parse(parsed.metadata.user_id)).toEqual({
      device_id: "device-abc",
      account_uuid: "acct-xyz",
      session_id: "session-123",
    });
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].role).toBe("user");
    expect(parsed.messages[0].content).toEqual([
      { type: "text", text: "Hello", cache_control: { type: "ephemeral" } },
    ]);
    expect(parsed.max_tokens).toBe(4096);
    expect(parsed.thinking).toEqual({ type: "adaptive" });
    expect(parsed.context_management).toEqual({ edits: [{ type: "clear_thinking_20251015", keep: "all" }] });
    expect(parsed.output_config).toEqual({ effort: "high" });
    expect(parsed).not.toHaveProperty("temperature");
    expect(Object.keys(parsed).slice(0, 8)).toEqual([
      "model",
      "messages",
      "system",
      "metadata",
      "max_tokens",
      "thinking",
      "context_management",
      "output_config",
    ]);
    expect(Object.keys(req.headers).slice(0, 5)).toEqual([
      "accept",
      "content-type",
      "user-agent",
      "x-claude-code-session-id",
      "x-stainless-arch",
    ]);
  });

  it("moves explicit betas into the anthropic-beta header", () => {
    stubClaudeCodeEnv({ CLAUDE_CODE_SESSION_ID: "session-custom" });
    const deploy = makeDeployment({ extraBody: { betas: ["custom-beta-1", "custom-beta-2"] } });
    const req = buildAnthropicSubscriptionRequest(deploy, {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 10,
    }, "token");
    const parsed = JSON.parse(req.body);

    expect(req.headers["anthropic-beta"]).toBe("custom-beta-1,custom-beta-2,effort-2025-11-24");
    expect(parsed.betas).toBeUndefined();
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

  it("converts tool_choice none without stripping tools", () => {
    const deploy = makeDeployment();
    const body = {
      model: "claude-sonnet-4-6",
      messages: [{ role: "user", content: "do not use the tool" }],
      tools: [{ type: "function", function: { name: "get_weather", description: "Get weather", parameters: { type: "object", properties: {} } } }],
      tool_choice: "none",
    };

    const req = buildAnthropicSubscriptionRequest(deploy, body, "token");
    const parsed = JSON.parse(req.body);
    expect(parsed.tool_choice).toEqual({ type: "none" });
    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].name).toBe("get_weather");
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
    expect(parsed.reasoning_effort).toBeUndefined();
    expect(parsed.output_config.effort).toBe("high");
  });

  it("strips client cache markers before adding the Claude cache breakpoint", () => {
    stubClaudeCodeEnv();
    const deploy = makeDeployment();
    const body = {
      model: "claude-sonnet-4-6",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "old marker", cache_control: { type: "ephemeral", ttl: "1h" } }],
        },
        {
          role: "user",
          content: [{ type: "text", text: "new marker", cache_control: { type: "ephemeral", ttl: "1h" } }],
        },
      ],
      max_tokens: 10,
    };

    const req = buildAnthropicSubscriptionRequest(deploy, body, "token");
    const parsed = JSON.parse(req.body);
    const messageCacheBlocks = parsed.messages.flatMap((message: { content: Array<Record<string, unknown>> }) =>
      message.content.filter((block) => "cache_control" in block)
    );

    expect(messageCacheBlocks).toHaveLength(1);
    expect(messageCacheBlocks[0]).toEqual({ type: "text", text: "new marker", cache_control: { type: "ephemeral" } });
    expect(parsed.messages[0].content[0]).not.toHaveProperty("cache_control");
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
        .mockResolvedValueOnce({ accessToken: "expired", expiresAt: Date.now() - 1000, refreshToken: "refresh-me" }),
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

      expect(fetchMock).toHaveBeenCalledWith(ANTHROPIC_OAUTH_TOKEN_URL, expect.objectContaining({
        method: "POST",
      }));
      const [, refreshInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(refreshInit.body as string)).toEqual({
        grant_type: "refresh_token",
        refresh_token: "refresh-me",
        client_id: "test-client",
        scope: CLAUDE_AI_OAUTH_SCOPE,
      });
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

  it("refreshAnthropicOAuthToken sends Claude scopes, optional client secret, and token URL override", async () => {
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
      const result = await refreshAnthropicOAuthToken(
        "refresh-me",
        "test-client",
        "client-secret",
        { tokenUrl: "https://platform.staging.ant.dev/v1/oauth/token" },
      );

      expect(fetchMock).toHaveBeenCalledWith("https://platform.staging.ant.dev/v1/oauth/token", expect.objectContaining({
        method: "POST",
      }));
      const [, refreshInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(JSON.parse(refreshInit.body as string)).toEqual({
        grant_type: "refresh_token",
        refresh_token: "refresh-me",
        client_id: "test-client",
        scope: CLAUDE_AI_OAUTH_SCOPE,
        client_secret: "client-secret",
      });
      expect(result).toMatchObject({
        success: true,
        token: {
          accessToken: "new-token",
          refreshToken: "refresh-new",
        },
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refreshAnthropicOAuthToken classifies rejected OAuth sessions", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("expired session", { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await refreshAnthropicOAuthToken("refresh-me", "test-client");

      expect(result).toEqual({
        success: false,
        error: "expired session",
        failureClass: "oauth_session_failure",
      });
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
  it("builds a LiteLLM-equivalent ChatGPT/Codex Responses request", () => {
    const deploy = makeDeployment({
      provider: "chatgpt",
      mode: "responses",
      providerModel: "gpt-5.5",
      reasoningEffort: "medium",
    });
    const body = {
      model: "gpt-5.5",
      input: "Hello",
      instructions: "You are helpful.",
      stream: false,
      store: true,
      previous_response_id: "resp_prev",
      truncation: "auto",
    };

    const req = buildChatGPTResponsesRequest(deploy, body, structuredChatGPTAuth("chatgpt-token"));
    const parsed = JSON.parse(req.body);

    expect(req.url).toContain("/backend-api/codex/responses");
    expect(req.headers["Authorization"]).toBe("Bearer chatgpt-token");
    expect(parsed.model).toBe("gpt-5.5");
    expect(parsed.instructions).toBe("You are helpful.");
    expect(parsed.input).toEqual([{ type: "message", role: "user", content: [{ type: "input_text", text: "Hello" }] }]);
    expect(parsed.stream).toBe(true);
    expect(parsed.store).toBe(false);
    expect(parsed.include).toContain("reasoning.encrypted_content");
    expect(parsed.reasoning).toEqual({ effort: "medium" });
    expect(parsed.previous_response_id).toBe("resp_prev");
    expect(parsed.truncation).toBe("auto");
    expect(parsed).not.toHaveProperty("messages");
    expect(parsed).not.toHaveProperty("max_output_tokens");
  });

  it("preserves Responses tools and tool_choice", () => {
    const deploy = makeDeployment({
      provider: "chatgpt",
      mode: "responses",
      providerModel: "gpt-5.5",
      reasoningEffort: "high",
    });
    const body = {
      model: "gpt-5.5",
      input: "use tool",
      tools: [{
        type: "function",
        name: "get_weather",
        description: "Get weather",
        parameters: { type: "object", properties: { city: { type: "string" } } },
      }],
      tool_choice: { type: "function", name: "get_weather" },
    };

    const req = buildChatGPTResponsesRequest(deploy, body, structuredChatGPTAuth("token"));
    const parsed = JSON.parse(req.body);

    expect(parsed.tools).toHaveLength(1);
    expect(parsed.tools[0].type).toBe("function");
    expect(parsed.tools[0].name).toBe("get_weather");
    expect(parsed.tool_choice).toEqual({ type: "function", name: "get_weather" });
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
      input: "hello",
    });
    expect(result.valid).toBe(true);
  });

  it("rejects missing input", () => {
    const result = validateResponsesContract({
      model: "gpt-5.5",
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("input is required");
  });

  it("rejects messages payloads", () => {
    const result = validateResponsesContract({
      model: "gpt-5.5",
      input: "hello",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.valid).toBe(false);
    expect(result.forbiddenFields).toEqual(["messages"]);
  });

  it("rejects response_format", () => {
    const result = validateResponsesContract({
      model: "gpt-5.5",
      input: "hello",
      response_format: { type: "json_object" },
    });
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("response_format");
  });

  it("rejects n instead of accepting chat-completions fanout semantics", () => {
    const result = validateResponsesContract({
      model: "gpt-5.5",
      input: "hello",
      n: 1,
    });
    expect(result.valid).toBe(false);
    expect(result.forbiddenFields).toEqual(["n"]);
  });

  it("rejects unsupported params instead of stripping them", () => {
    const result = validateResponsesContract({
      model: "gpt-5.5",
      input: "hello",
      frequency_penalty: 0.5,
      stop: ["\n"],
      seed: 42,
    });
    expect(result.valid).toBe(false);
    expect(result.forbiddenFields).toEqual(["frequency_penalty", "seed", "stop"]);
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

  it("normalizes trailing slashes on apiBase", () => {
    const deploy = makeDeployment({
      provider: "openai",
      apiBase: "https://api.openai.com/v1/",
    });
    const body = { messages: [{ role: "user", content: "hi" }] };
    const req = buildProviderRequest(deploy, body, "sk-test");
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
  });
});

describe("executeProviderRequest", () => {
  it("treats JSON array success bodies as non-object json", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await executeProviderRequest(
        { url: "https://example.test/v1/chat/completions", method: "POST", headers: {}, body: "{}" },
        { signal: new AbortController().signal, timeoutMs: 5000 },
      );
      expect(result.status).toBe(200);
      expect(result.json).toBeNull();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
