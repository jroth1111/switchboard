import { describe, it, expect } from "vitest";
import {
  CHATGPT_RESPONSES_BACKEND_PATH,
  CHATGPT_RESPONSES_ENCRYPTED_REASONING_INCLUDE,
  buildChatGPTResponsesRequest,
  chatgptResponsesTextInput,
  convertResponsesStreamChunk,
  convertResponsesToOpenAI,
  normalizeChatGPTResponsesInput,
  resolveChatGPTSubscriptionAuth,
  validateResponsesContract,
} from "../../src/providers/chatgpt-responses";
import type { Deployment } from "../../src/config/schema";

function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "chatgpt-deploy",
    group: "chatgpt-subscription-gpt-5.5-high",
    provider: "chatgpt",
    mode: "responses",
    model: "gpt-5.5",
    providerModel: "gpt-5.5",
    keyRef: "CHATGPT_AUTH_JSON",
    rpm: 100,
    maxParallelRequests: 1,
    timeout: 30,
    streamTimeout: 120,
    supportsStreaming: true,
    reasoningEffort: "high",
    capabilities: {
      toolCalling: "native",
      streamingWithTools: "native",
      jsonMode: "native",
      reasoning: "native",
      multimodal: "native",
    },
    contextWindow: 400000,
    hidden: true,
    ...overrides,
  };
}

function structuredAuth(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: "access-secret",
    refresh_token: "refresh-secret",
    id_token: "id-secret",
    ...overrides,
  });
}

// ─── ChatGPT/Codex Responses contract ────────────────────────────────

describe("ChatGPT Responses provider contract", () => {
  it("normalizes plain text input to Codex Responses message items", () => {
    expect(normalizeChatGPTResponsesInput("Return exactly OK")).toEqual(
      chatgptResponsesTextInput("Return exactly OK"),
    );
  });

  it("normalizes message content while preserving structured Responses items", () => {
    const normalized = normalizeChatGPTResponsesInput([
      { role: "user", content: "hello" },
      { type: "function_call", id: "fc_1", call_id: "call_1", name: "search", arguments: "{}" },
    ]);

    expect(normalized[0]).toEqual({
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: "hello" }],
    });
    expect(normalized[1]).toEqual({
      type: "function_call",
      id: "fc_1",
      call_id: "call_1",
      name: "search",
      arguments: "{}",
    });
  });

  it("builds the LiteLLM-equivalent ChatGPT/Codex backend request", () => {
    const req = buildChatGPTResponsesRequest(deployment(), {
      model: "gpt-5.5",
      input: "Return exactly OK",
      instructions: "Be precise.",
      stream: false,
      store: true,
      include: ["file_search_call.results"],
      tools: [{ type: "function", name: "search", parameters: { type: "object", properties: {} } }],
      tool_choice: "auto",
      previous_response_id: "resp_prev",
      truncation: "auto",
    }, structuredAuth({ access_token: "oauth-token" }));
    const body = JSON.parse(req.body) as Record<string, unknown>;

    expect(req.url).toBe(`https://chatgpt.com${CHATGPT_RESPONSES_BACKEND_PATH}`);
    expect(req.method).toBe("POST");
    expect(req.headers.Authorization).toBe("Bearer oauth-token");
    expect(body.model).toBe("gpt-5.5");
    expect(body.instructions).toBe("Be precise.");
    expect(body.input).toEqual(chatgptResponsesTextInput("Return exactly OK"));
    expect(body.stream).toBe(true);
    expect(body.store).toBe(false);
    expect(body.include).toEqual(["file_search_call.results", CHATGPT_RESPONSES_ENCRYPTED_REASONING_INCLUDE]);
    expect(body.reasoning).toEqual({ effort: "high" });
    expect(body.tools).toEqual([{ type: "function", name: "search", parameters: { type: "object", properties: {} } }]);
    expect(body.tool_choice).toBe("auto");
    expect(body.previous_response_id).toBe("resp_prev");
    expect(body.truncation).toBe("auto");
    expect(body).not.toHaveProperty("messages");
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
    expect(body).not.toHaveProperty("max_output_tokens");
    expect(body).not.toHaveProperty("metadata");
  });

  it("appends the Codex backend path to a configured ChatGPT backend origin", () => {
    const req = buildChatGPTResponsesRequest(
      deployment({ apiBase: "https://chatgpt-proxy.example/upstream" }),
      { model: "gpt-5.5", input: "OK" },
      structuredAuth({ access_token: "oauth-token" }),
    );

    expect(req.url).toBe(`https://chatgpt-proxy.example/upstream${CHATGPT_RESPONSES_BACKEND_PATH}`);
  });

  it("does not double-append the Codex backend path", () => {
    const req = buildChatGPTResponsesRequest(
      deployment({ apiBase: `https://chatgpt-proxy.example${CHATGPT_RESPONSES_BACKEND_PATH}` }),
      { model: "gpt-5.5", input: "OK" },
      structuredAuth({ access_token: "oauth-token" }),
    );

    expect(req.url).toBe(`https://chatgpt-proxy.example${CHATGPT_RESPONSES_BACKEND_PATH}`);
  });

  it("rejects generic OpenAI Platform base URLs", () => {
    expect(() => buildChatGPTResponsesRequest(
      deployment({ apiBase: "https://api.openai.com/v1" }),
      { model: "gpt-5.5", input: "OK" },
      structuredAuth({ access_token: "oauth-token" }),
    )).toThrow(/generic OpenAI API Platform/);
  });

  it("rejects OpenAI API-key shaped credentials", () => {
    expect(() => buildChatGPTResponsesRequest(
      deployment(),
      { model: "gpt-5.5", input: "OK" },
      structuredAuth({ access_token: "sk-test-openai-key" }),
    )).toThrow(/subscription OAuth/);
  });

  it("rejects deployment-level provider body params and extraBody", () => {
    expect(() => buildChatGPTResponsesRequest(
      deployment({ params: { temperature: 0.2 }, extraBody: { custom: true } }),
      { model: "gpt-5.5", input: "OK" },
      structuredAuth({ access_token: "oauth-token" }),
    )).toThrow(/must not configure provider body params/);
  });
});

// ─── validateResponsesContract ───────────────────────────────────────

describe("validateResponsesContract", () => {
  it("accepts a minimal Responses request", () => {
    expect(validateResponsesContract({ model: "gpt-5.5", input: "hello" })).toEqual({ valid: true });
  });

  it("rejects missing input", () => {
    const result = validateResponsesContract({ model: "gpt-5.5" });
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

  it("rejects forbidden request fields instead of stripping them", () => {
    const result = validateResponsesContract({
      model: "gpt-5.5",
      input: "hello",
      temperature: 0.7,
      top_p: 0.9,
      max_output_tokens: 512,
      extra_body: { unsafe: true },
      response_format: { type: "json_object" },
    });

    expect(result.valid).toBe(false);
    expect(result.forbiddenFields).toEqual([
      "extra_body",
      "max_output_tokens",
      "response_format",
      "temperature",
      "top_p",
    ]);
  });

  it("rejects non-nim metadata before provider dispatch", () => {
    const result = validateResponsesContract({
      model: "gpt-5.5",
      input: "hello",
      metadata: { session_id: "secret", public_label: "client" },
    });

    expect(result.valid).toBe(false);
    expect(result.forbiddenFields).toEqual(["metadata.session_id", "metadata.public_label"]);
  });

  it("allows internal nim metadata and strips it from the provider body", () => {
    const req = buildChatGPTResponsesRequest(
      deployment(),
      { model: "gpt-5.5", input: "hello", metadata: { nim_request_id: "req_1" } },
      structuredAuth({ access_token: "oauth-token" }),
    );
    const body = JSON.parse(req.body) as Record<string, unknown>;

    expect(body).not.toHaveProperty("metadata");
  });

  it("accepts structured subscription auth and sends only the access token upstream", () => {
    const req = buildChatGPTResponsesRequest(
      deployment(),
      { model: "gpt-5.5", input: "OK" },
      structuredAuth(),
    );

    expect(req.headers.Authorization).toBe("Bearer access-secret");
    expect(req.body).not.toContain("refresh-secret");
    expect(req.body).not.toContain("id-secret");
    expect(resolveChatGPTSubscriptionAuth(structuredAuth()).source).toBe("structured");
  });

  it("rejects structured auth missing refresh_token or id_token without echoing secrets", () => {
    let thrown: Error | undefined;
    try {
      buildChatGPTResponsesRequest(
        deployment(),
        { model: "gpt-5.5", input: "OK" },
        structuredAuth({ refresh_token: "", id_token: undefined }),
      );
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeDefined();
    expect(thrown!.message).toContain("missing required fields: refresh_token, id_token");
    expect(thrown!.message).not.toContain("access-secret");
    expect(thrown!.message).not.toContain("refresh-secret");
    expect(thrown!.message).not.toContain("id-secret");
  });

  it("rejects OpenAI API-key shaped access tokens inside structured auth", () => {
    expect(() => buildChatGPTResponsesRequest(
      deployment(),
      { model: "gpt-5.5", input: "OK" },
      structuredAuth({ access_token: "sk-test-openai-key" }),
    )).toThrow(/subscription OAuth/);
  });

  it("rejects legacy bare access-token auth by default", () => {
    expect(() => resolveChatGPTSubscriptionAuth("legacy-oauth-token")).toThrow(/must be structured JSON/);
  });
});

// ─── convertResponsesToOpenAI ────────────────────────────────────────

describe("convertResponsesToOpenAI", () => {
  it("converts text output to chat completion format", () => {
    const result = convertResponsesToOpenAI({
      id: "resp-1",
      model: "gpt-5.5",
      output: [{ type: "message", content: [{ type: "output_text", text: "Hello world" }] }],
      usage: { input_tokens: 10, output_tokens: 5 },
    }, "req-1");

    expect(result.id).toBe("resp-1");
    expect(result.object).toBe("chat.completion");
    expect(result.model).toBe("gpt-5.5");
    const choices = result.choices as Array<Record<string, unknown>>;
    expect(choices[0].message).toEqual({ role: "assistant", content: "Hello world" });
    expect(choices[0].finish_reason).toBe("stop");
    expect(result.usage).toEqual({ prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 });
  });

  it("converts function_call output to tool_calls", () => {
    const result = convertResponsesToOpenAI({
      id: "resp-2",
      model: "gpt-5.5",
      output: [{ type: "function_call", id: "fc-1", name: "search", arguments: "{\"q\":\"test\"}" }],
    }, "req-2");

    const choices = result.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("tool_calls");
    const msg = choices[0].message as Record<string, unknown>;
    const toolCalls = msg.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls[0].id).toBe("fc-1");
    expect(toolCalls[0].function).toEqual({ name: "search", arguments: "{\"q\":\"test\"}" });
  });
});

// ─── convertResponsesStreamChunk ─────────────────────────────────────

describe("convertResponsesStreamChunk", () => {
  it("converts output_text delta", () => {
    const result = convertResponsesStreamChunk(
      { type: "response.output_text.delta", delta: "Hello" },
      "req-1",
      "gpt-5.5",
    );

    expect(result).not.toBeNull();
    const choices = result!.choices as Array<Record<string, unknown>>;
    expect(choices[0].delta).toEqual({ content: "Hello" });
    expect(choices[0].finish_reason).toBeNull();
  });

  it("converts function_call start and argument deltas", () => {
    const start = convertResponsesStreamChunk(
      { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc-1", name: "search" } },
      "req-2",
      "gpt-5.5",
    );
    const args = convertResponsesStreamChunk(
      { type: "response.function_call_arguments.delta", output_index: 0, delta: "{\"q\":" },
      "req-3",
      "gpt-5.5",
    );

    expect(start).not.toBeNull();
    expect(args).not.toBeNull();
    expect(((start!.choices as Array<Record<string, unknown>>)[0].delta as Record<string, unknown>).tool_calls).toBeDefined();
    expect(((args!.choices as Array<Record<string, unknown>>)[0].delta as Record<string, unknown>).tool_calls).toBeDefined();
  });

  it("converts response.completed with usage", () => {
    const result = convertResponsesStreamChunk(
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 20, output_tokens: 10 } } },
      "req-4",
      "gpt-5.5",
    );

    expect(result).not.toBeNull();
    const choices = result!.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("stop");
    expect(result!.usage).toEqual({ prompt_tokens: 20, completion_tokens: 10, total_tokens: 30 });
  });

  it("returns null for response stream noise", () => {
    expect(convertResponsesStreamChunk({ type: "response.created" }, "req-5", "gpt-5.5")).toBeNull();
    expect(convertResponsesStreamChunk(
      { type: "response.output_item.done", item: { type: "function_call", id: "fc-1" } },
      "req-6",
      "gpt-5.5",
    )).toBeNull();
  });
});
