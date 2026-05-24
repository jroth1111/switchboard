import { describe, it, expect } from "vitest";
import {
  buildChatGPTResponsesRequest,
  convertResponsesToOpenAI,
  convertResponsesStreamChunk,
  validateResponsesContract,
} from "../../src/providers/chatgpt-responses";
import type { Deployment } from "../../src/config/schema";

function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "chatgpt-deploy",
    group: "chatgpt",
    provider: "chatgpt_responses",
    model: "gpt-5.5",
    providerModel: "gpt-5.5",
    keyRef: "CHATGPT_KEY",
    rpm: 100,
    maxParallelRequests: 4,
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

const basicBody = {
  model: "gpt-5.5",
  messages: [
    { role: "system", content: "You are helpful." },
    { role: "user", content: "Hello" },
  ],
};

// ─── buildChatGPTResponsesRequest ────────────────────────────────────

describe("buildChatGPTResponsesRequest", () => {
  it("builds a basic request with correct URL and headers", () => {
    const result = buildChatGPTResponsesRequest(deployment(), basicBody, "tok-123");
    expect(result.url).toBe("https://api.openai.com/v1/responses");
    expect(result.method).toBe("POST");
    expect(result.headers["Authorization"]).toBe("Bearer tok-123");
    expect(result.headers["Content-Type"]).toBe("application/json");
  });

  it("extracts system message as instructions", () => {
    const result = buildChatGPTResponsesRequest(deployment(), basicBody, "tok");
    const body = JSON.parse(result.body as string) as Record<string, unknown>;
    expect(body.instructions).toBe("You are helpful.");
    // System should not appear in input
    const input = body.input as Array<Record<string, unknown>>;
    expect(input.every((item) => item.role !== "system" && item.type !== "system")).toBe(true);
  });

  it("converts user and assistant messages to input items", () => {
    const body = {
      model: "gpt-5.5",
      messages: [
        { role: "user", content: "Hi" },
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "How are you?" },
      ],
    };
    const result = buildChatGPTResponsesRequest(deployment(), body, "tok");
    const parsed = JSON.parse(result.body as string) as Record<string, unknown>;
    const input = parsed.input as Array<Record<string, unknown>>;
    expect(input).toHaveLength(3);
    expect(input[0]).toEqual({ role: "user", content: "Hi" });
    expect(input[1]).toEqual({ role: "assistant", content: "Hello!" });
    expect(input[2]).toEqual({ role: "user", content: "How are you?" });
  });

  it("converts tool calls on assistant messages to function_call items", () => {
    const body = {
      model: "gpt-5.5",
      messages: [
        { role: "user", content: "weather?" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{
            id: "call-1",
            type: "function",
            function: { name: "get_weather", arguments: '{"city":"SF"}' },
          }],
        },
        { role: "tool", content: "sunny", tool_call_id: "call-1" },
      ],
    };
    const result = buildChatGPTResponsesRequest(deployment(), body, "tok");
    const parsed = JSON.parse(result.body as string) as Record<string, unknown>;
    const input = parsed.input as Array<Record<string, unknown>>;
    // user, function_call, function_call_output
    expect(input).toHaveLength(3);
    expect(input[0]).toEqual({ role: "user", content: "weather?" });
    expect(input[1]).toEqual({
      type: "function_call",
      id: "call-1",
      call_id: "call-1",
      name: "get_weather",
      arguments: '{"city":"SF"}',
    });
    expect(input[2]).toEqual({
      type: "function_call_output",
      call_id: "call-1",
      output: "sunny",
    });
  });

  it("converts tools to Responses format", () => {
    const body = {
      ...basicBody,
      tools: [{
        type: "function",
        function: {
          name: "search",
          description: "Search the web",
          parameters: { type: "object", properties: { q: { type: "string" } } },
        },
      }],
    };
    const result = buildChatGPTResponsesRequest(deployment(), body, "tok");
    const parsed = JSON.parse(result.body as string) as Record<string, unknown>;
    const tools = parsed.tools as Array<Record<string, unknown>>;
    expect(tools).toHaveLength(1);
    expect(tools[0]).toEqual({
      type: "function",
      name: "search",
      description: "Search the web",
      parameters: { type: "object", properties: { q: { type: "string" } } },
    });
  });

  it("maps max_tokens to max_output_tokens", () => {
    const body = { ...basicBody, max_tokens: 4096 };
    const result = buildChatGPTResponsesRequest(deployment(), body, "tok");
    const parsed = JSON.parse(result.body as string) as Record<string, unknown>;
    expect(parsed.max_output_tokens).toBe(4096);
  });

  it("passes stream, temperature, top_p", () => {
    const body = { ...basicBody, stream: true, temperature: 0.7, top_p: 0.9 };
    const result = buildChatGPTResponsesRequest(deployment(), body, "tok");
    const parsed = JSON.parse(result.body as string) as Record<string, unknown>;
    expect(parsed.stream).toBe(true);
    expect(parsed.temperature).toBe(0.7);
    expect(parsed.top_p).toBe(0.9);
  });

  it("merges deployment reasoningEffort", () => {
    const dep = deployment({ reasoningEffort: "high" });
    const result = buildChatGPTResponsesRequest(dep, basicBody, "tok");
    const parsed = JSON.parse(result.body as string) as Record<string, unknown>;
    expect(parsed.reasoning).toEqual({ effort: "high" });
  });

  it("merges deployment params and extraBody without overwriting client values", () => {
    const dep = deployment({
      params: { temperature: 0.1, custom_param: "val" },
      extraBody: { extra_flag: true },
    });
    const body = { ...basicBody, temperature: 0.8 };
    const result = buildChatGPTResponsesRequest(dep, body, "tok");
    const parsed = JSON.parse(result.body as string) as Record<string, unknown>;
    // Client value takes priority
    expect(parsed.temperature).toBe(0.8);
    // Deployment-only params are merged
    expect(parsed.custom_param).toBe("val");
    expect(parsed.extra_flag).toBe(true);
  });

  it("uses deployment apiBase when provided", () => {
    const dep = deployment({ apiBase: "https://custom.api.com" });
    const result = buildChatGPTResponsesRequest(dep, basicBody, "tok");
    expect(result.url).toBe("https://custom.api.com/v1/responses");
  });
});

// ─── convertResponsesToOpenAI ────────────────────────────────────────

describe("convertResponsesToOpenAI", () => {
  it("converts text output to chat completion format", () => {
    const response = {
      id: "resp-1",
      model: "gpt-5.5",
      output: [
        { type: "message", content: [{ type: "output_text", text: "Hello world" }] },
      ],
      usage: { input_tokens: 10, output_tokens: 5 },
    };
    const result = convertResponsesToOpenAI(response, "req-1");
    expect(result.id).toBe("resp-1");
    expect(result.object).toBe("chat.completion");
    expect(result.model).toBe("gpt-5.5");
    const choices = result.choices as Array<Record<string, unknown>>;
    expect(choices[0].message).toEqual({ role: "assistant", content: "Hello world" });
    expect(choices[0].finish_reason).toBe("stop");
    const usage = result.usage as Record<string, number>;
    expect(usage.prompt_tokens).toBe(10);
    expect(usage.completion_tokens).toBe(5);
    expect(usage.total_tokens).toBe(15);
  });

  it("converts function_call output to tool_calls", () => {
    const response = {
      id: "resp-2",
      model: "gpt-5.5",
      output: [
        { type: "function_call", id: "fc-1", name: "search", arguments: '{"q":"test"}' },
      ],
    };
    const result = convertResponsesToOpenAI(response, "req-2");
    const choices = result.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("tool_calls");
    const msg = choices[0].message as Record<string, unknown>;
    const toolCalls = msg.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls).toHaveLength(1);
    expect(toolCalls[0].id).toBe("fc-1");
    expect(toolCalls[0].function).toEqual({ name: "search", arguments: '{"q":"test"}' });
  });

  it("handles mixed text + function_call output", () => {
    const response = {
      id: "resp-3",
      output: [
        { type: "message", content: [{ type: "output_text", text: "Let me search" }] },
        { type: "function_call", id: "fc-1", name: "search", arguments: '{}' },
      ],
    };
    const result = convertResponsesToOpenAI(response, "req-3");
    const choices = result.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("tool_calls");
    const msg = choices[0].message as Record<string, unknown>;
    expect(msg.content).toBe("Let me search");
    expect((msg.tool_calls as unknown[]).length).toBe(1);
  });

  it("defaults usage to 0 when not present", () => {
    const response = {
      id: "resp-4",
      output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
    };
    const result = convertResponsesToOpenAI(response, "req-4");
    const usage = result.usage as Record<string, number>;
    expect(usage.prompt_tokens).toBe(0);
    expect(usage.completion_tokens).toBe(0);
    expect(usage.total_tokens).toBe(0);
  });

  it("defaults to requestId when response has no id", () => {
    const response = {
      output: [{ type: "message", content: [{ type: "output_text", text: "hi" }] }],
    };
    const result = convertResponsesToOpenAI(response, "my-req");
    expect(result.id).toBe("my-req");
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

  it("converts function_call start (output_item.added)", () => {
    const result = convertResponsesStreamChunk(
      { type: "response.output_item.added", output_index: 2, item: { type: "function_call", id: "fc-1", name: "search" } },
      "req-2",
      "gpt-5.5",
    );
    expect(result).not.toBeNull();
    const choices = result!.choices as Array<Record<string, unknown>>;
    const delta = choices[0].delta as Record<string, unknown>;
    const toolCalls = delta.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls[0].index).toBe(2);
    expect(toolCalls[0].function).toEqual({ name: "search", arguments: "" });
  });

  it("converts function_call_arguments delta", () => {
    const result = convertResponsesStreamChunk(
      { type: "response.function_call_arguments.delta", output_index: 0, delta: '{"q":' },
      "req-3",
      "gpt-5.5",
    );
    expect(result).not.toBeNull();
    const choices = result!.choices as Array<Record<string, unknown>>;
    const delta = choices[0].delta as Record<string, unknown>;
    const toolCalls = delta.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls[0].function).toEqual({ arguments: '{"q":' });
  });

  it("converts response.completed with stop", () => {
    const result = convertResponsesStreamChunk(
      { type: "response.completed", response: { status: "completed" } },
      "req-4",
      "gpt-5.5",
    );
    expect(result).not.toBeNull();
    const choices = result!.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("stop");
  });

  it("converts response.completed with incomplete as length", () => {
    const result = convertResponsesStreamChunk(
      { type: "response.completed", response: { status: "incomplete" } },
      "req-5",
      "gpt-5.5",
    );
    expect(result).not.toBeNull();
    const choices = result!.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("length");
  });

  it("includes usage from response.completed", () => {
    const result = convertResponsesStreamChunk(
      { type: "response.completed", response: { status: "completed", usage: { input_tokens: 20, output_tokens: 10 } } },
      "req-6",
      "gpt-5.5",
    );
    expect(result).not.toBeNull();
    const usage = result!.usage as Record<string, number>;
    expect(usage.prompt_tokens).toBe(20);
    expect(usage.completion_tokens).toBe(10);
    expect(usage.total_tokens).toBe(30);
  });

  it("returns null for output_item.done (noise)", () => {
    const result = convertResponsesStreamChunk(
      { type: "response.output_item.done", item: { type: "function_call", id: "fc-1" } },
      "req-7",
      "gpt-5.5",
    );
    expect(result).toBeNull();
  });

  it("returns null for non-function_call output_item.added", () => {
    const result = convertResponsesStreamChunk(
      { type: "response.output_item.added", output_index: 0, item: { type: "message" } },
      "req-8",
      "gpt-5.5",
    );
    expect(result).toBeNull();
  });

  it("returns null for unknown event types", () => {
    const result = convertResponsesStreamChunk(
      { type: "response.created" },
      "req-9",
      "gpt-5.5",
    );
    expect(result).toBeNull();
  });
});

// ─── validateResponsesContract ───────────────────────────────────────

describe("validateResponsesContract", () => {
  it("returns valid for a basic chat request", () => {
    const result = validateResponsesContract(basicBody);
    expect(result.valid).toBe(true);
    expect(result.strippedParams).toBeUndefined();
  });

  it("strips unsupported params", () => {
    const body = {
      ...basicBody,
      frequency_penalty: 0.5,
      presence_penalty: 0.3,
      stop: ["\n"],
      user: "user-1",
    };
    const result = validateResponsesContract(body);
    expect(result.valid).toBe(true);
    expect(result.strippedParams).toContain("frequency_penalty");
    expect(result.strippedParams).toContain("presence_penalty");
    expect(result.strippedParams).toContain("stop");
    expect(result.strippedParams).toContain("user");
  });

  it("rejects n > 1", () => {
    const body = { ...basicBody, n: 3 };
    const result = validateResponsesContract(body);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("n > 1");
  });

  it("rejects response_format", () => {
    const body = { ...basicBody, response_format: { type: "json_object" } };
    const result = validateResponsesContract(body);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("response_format");
  });

  it("strips seed param", () => {
    const body = { ...basicBody, seed: 42 };
    const result = validateResponsesContract(body);
    expect(result.valid).toBe(true);
    expect(result.strippedParams).toContain("seed");
  });

  it("rejects unsupported message roles", () => {
    const body = {
      model: "gpt-5.5",
      messages: [{ role: "developer", content: "do stuff" }],
    };
    const result = validateResponsesContract(body);
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("unsupported message role");
  });
});
