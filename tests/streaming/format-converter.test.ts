import { describe, it, expect } from "vitest";
import { wrapSubscriptionStream } from "../../src/streaming/format-converter";
import { convertAnthropicStreamChunk } from "../../src/providers/anthropic-subscription";
import { convertResponsesStreamChunk } from "../../src/providers/chatgpt-responses";

function makeSSEBody(events: string[]): ReadableStream<Uint8Array> {
  const text = events.map((e) => `data: ${e}\n\n`).join("");
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

async function collectStream(stream: ReadableStream<Uint8Array>): Promise<string[]> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(decoder.decode(value, { stream: true }));
  }
  // Split into individual SSE events
  return chunks.join("").split("\n\n").filter((s) => s.trim());
}

describe("wrapSubscriptionStream - Anthropic", () => {
  it("converts Anthropic text delta to OpenAI format", async () => {
    const anthropicEvent = JSON.stringify({
      type: "content_block_delta",
      delta: { type: "text_delta", text: "Hello" },
    });
    const stream = makeSSEBody([anthropicEvent]);
    const converted = wrapSubscriptionStream(stream, "anthropic_subscription", "req-1", "claude-opus-4-7");
    const events = await collectStream(converted);

    // Converter always appends [DONE] sentinel
    const dataEvents = events.filter((e) => !e.includes("[DONE]"));
    expect(dataEvents.length).toBe(1);
    const data = dataEvents[0].replace("data: ", "");
    const parsed = JSON.parse(data) as Record<string, unknown>;
    expect(parsed.object).toBe("chat.completion.chunk");
    expect(parsed.model).toBe("claude-opus-4-7");
    const choices = parsed.choices as Array<Record<string, unknown>>;
    expect(choices[0].delta).toEqual({ content: "Hello" });
  });

  it("passes through [DONE] sentinel", async () => {
    const stream = makeSSEBody(["[DONE]"]);
    const converted = wrapSubscriptionStream(stream, "anthropic_subscription", "req-1", "claude-opus-4-7");
    const events = await collectStream(converted);
    expect(events[0]).toContain("[DONE]");
  });
});

describe("wrapSubscriptionStream - ChatGPT Responses", () => {
  it("converts Responses text delta to OpenAI format", async () => {
    const responsesEvent = JSON.stringify({
      type: "response.output_text.delta",
      delta: "World",
    });
    const stream = makeSSEBody([responsesEvent]);
    const converted = wrapSubscriptionStream(stream, "chatgpt_responses", "req-2", "gpt-5.5");
    const events = await collectStream(converted);

    // Converter always appends [DONE] sentinel
    const dataEvents = events.filter((e) => !e.includes("[DONE]"));
    expect(dataEvents.length).toBe(1);
    const data = dataEvents[0].replace("data: ", "");
    const parsed = JSON.parse(data) as Record<string, unknown>;
    expect(parsed.object).toBe("chat.completion.chunk");
    const choices = parsed.choices as Array<Record<string, unknown>>;
    expect(choices[0].delta).toEqual({ content: "World" });
  });
});

describe("Anthropic stream chunk conversion", () => {
  it("converts tool use start", () => {
    const result = convertAnthropicStreamChunk(
      { type: "content_block_start", content_block: { type: "tool_use", id: "call-1", name: "get_weather" } },
      "req-1",
      "claude-opus-4-7",
    );
    expect(result).not.toBeNull();
    const choices = result!.choices as Array<Record<string, unknown>>;
    const delta = choices[0].delta as Record<string, unknown>;
    const toolCalls = delta.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls[0].function).toEqual({ name: "get_weather", arguments: "" });
  });

  it("converts message stop", () => {
    const result = convertAnthropicStreamChunk(
      { type: "message_delta", delta: { stop_reason: "end_turn" } },
      "req-1",
      "claude-opus-4-7",
    );
    expect(result).not.toBeNull();
    const choices = result!.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("stop");
  });

  it("returns null for ping events", () => {
    const result = convertAnthropicStreamChunk(
      { type: "ping" },
      "req-1",
      "claude-opus-4-7",
    );
    expect(result).toBeNull();
  });

  it("maps tool_use stop_reason to tool_calls", () => {
    const result = convertAnthropicStreamChunk(
      { type: "message_delta", delta: { stop_reason: "tool_use" } },
      "req-1",
      "claude-opus-4-7",
    );
    expect(result).not.toBeNull();
    const choices = result!.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("tool_calls");
  });

  it("maps max_tokens stop_reason to length", () => {
    const result = convertAnthropicStreamChunk(
      { type: "message_delta", delta: { stop_reason: "max_tokens" } },
      "req-1",
      "claude-opus-4-7",
    );
    expect(result).not.toBeNull();
    const choices = result!.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("length");
  });

  it("converts input_json_delta for tool call arguments", () => {
    const indexMap = new Map<number, number>();
    indexMap.set(1, 3);
    const result = convertAnthropicStreamChunk(
      { type: "content_block_delta", index: 1, delta: { type: "input_json_delta", partial_json: '{"location": "SF' } },
      "req-1",
      "claude-opus-4-7",
      indexMap,
    );
    expect(result).not.toBeNull();
    const choices = result!.choices as Array<Record<string, unknown>>;
    const delta = choices[0].delta as Record<string, unknown>;
    const toolCalls = delta.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls[0].index).toBe(3);
    expect(toolCalls[0].function).toEqual({ arguments: '{"location": "SF' });
  });

  it("converts message_start with input token usage", () => {
    const result = convertAnthropicStreamChunk(
      { type: "message_start", message: { usage: { input_tokens: 42 } } },
      "req-1",
      "claude-opus-4-7",
    );
    expect(result).not.toBeNull();
    const usage = result!.usage as Record<string, number>;
    expect(usage.prompt_tokens).toBe(42);
    expect(usage.completion_tokens).toBe(0);
    expect(result!.choices).toEqual([]);
  });

  it("returns null for content_block_stop", () => {
    const result = convertAnthropicStreamChunk(
      { type: "content_block_stop", index: 0 },
      "req-1",
      "claude-opus-4-7",
    );
    expect(result).toBeNull();
  });

  it("returns null for message_stop", () => {
    const result = convertAnthropicStreamChunk(
      { type: "message_stop" },
      "req-1",
      "claude-opus-4-7",
    );
    expect(result).toBeNull();
  });

  it("includes output_tokens usage on message_delta stop", () => {
    const result = convertAnthropicStreamChunk(
      { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 15 } },
      "req-1",
      "claude-opus-4-7",
    );
    expect(result).not.toBeNull();
    const usage = result!.usage as Record<string, number>;
    expect(usage.completion_tokens).toBe(15);
  });
});

describe("Responses stream chunk conversion", () => {
  it("converts function call start", () => {
    const result = convertResponsesStreamChunk(
      { type: "response.output_item.added", output_index: 0, item: { type: "function_call", id: "fc-1", name: "search" } },
      "req-2",
      "gpt-5.5",
    );
    expect(result).not.toBeNull();
    const choices = result!.choices as Array<Record<string, unknown>>;
    const delta = choices[0].delta as Record<string, unknown>;
    const toolCalls = delta.tool_calls as Array<Record<string, unknown>>;
    expect(toolCalls[0].function).toEqual({ name: "search", arguments: "" });
  });

  it("converts response completed with stop", () => {
    const result = convertResponsesStreamChunk(
      { type: "response.completed", response: { status: "completed" } },
      "req-2",
      "gpt-5.5",
    );
    expect(result).not.toBeNull();
    const choices = result!.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("stop");
  });

  it("converts response completed with incomplete as length", () => {
    const result = convertResponsesStreamChunk(
      { type: "response.completed", response: { status: "incomplete" } },
      "req-2",
      "gpt-5.5",
    );
    expect(result).not.toBeNull();
    const choices = result!.choices as Array<Record<string, unknown>>;
    expect(choices[0].finish_reason).toBe("length");
  });
});
