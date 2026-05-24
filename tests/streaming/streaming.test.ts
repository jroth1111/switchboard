import { describe, it, expect } from "vitest";
import { SSEParser, extractDelta, parseSSEStream } from "../../src/streaming/sse-parser";
import { SSEEmitter, createSSEStream } from "../../src/streaming/sse-emitter";
import { StreamEvaluator } from "../../src/streaming/stream-evaluator";
import { executeStreamWithPreBuffer } from "../../src/streaming/pre-buffer";

// ─── SSE Parser ────────────────────────────────────────────────────

describe("SSEParser", () => {
  it("parses a single data event", () => {
    const parser = new SSEParser();
    const events = parser.feed("data: hello world\n\n");
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("hello world");
  });

  it("parses event with event type and id", () => {
    const parser = new SSEParser();
    const events = parser.feed("event: message\ndata: test\nid: 42\n\n");
    expect(events).toHaveLength(1);
    expect(events[0].event).toBe("message");
    expect(events[0].data).toBe("test");
    expect(events[0].id).toBe("42");
  });

  it("handles multi-line data", () => {
    const parser = new SSEParser();
    const events = parser.feed("data: line1\ndata: line2\n\n");
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("line1\nline2");
  });

  it("handles incremental feeding", () => {
    const parser = new SSEParser();
    const e1 = parser.feed("data: hel");
    expect(e1).toHaveLength(0);
    const e2 = parser.feed("lo\n\n");
    expect(e2).toHaveLength(1);
    expect(e2[0].data).toBe("hello");
  });

  it("ignores comments", () => {
    const parser = new SSEParser();
    const events = parser.feed(": this is a comment\ndata: real\n\n");
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("real");
  });

  it("parses multiple events from one chunk", () => {
    const parser = new SSEParser();
    const events = parser.feed("data: first\n\ndata: second\n\n");
    expect(events).toHaveLength(2);
    expect(events[0].data).toBe("first");
    expect(events[1].data).toBe("second");
  });

  it("flushes remaining data", () => {
    const parser = new SSEParser();
    parser.feed("data: hello\n");
    const events = parser.flush();
    expect(events).toHaveLength(1);
    expect(events[0].data).toBe("hello");
  });

  it("returns empty on flush with no data", () => {
    const parser = new SSEParser();
    expect(parser.flush()).toHaveLength(0);
  });
});

describe("extractDelta", () => {
  it("extracts content delta from OpenAI format", () => {
    const data = JSON.stringify({
      choices: [{ delta: { content: "Hello" }, finish_reason: null }],
    });
    const delta = extractDelta(data);
    expect(delta?.content).toBe("Hello");
  });

  it("detects [DONE] sentinel", () => {
    const delta = extractDelta("[DONE]");
    expect(delta?.finishReason).toBe("done");
  });

  it("extracts finish_reason", () => {
    const data = JSON.stringify({
      choices: [{ delta: {}, finish_reason: "stop" }],
    });
    const delta = extractDelta(data);
    expect(delta?.finishReason).toBe("stop");
  });

  it("returns null for invalid JSON", () => {
    expect(extractDelta("not json")).toBeNull();
  });

  it("extracts tool_calls from delta", () => {
    const data = JSON.stringify({
      choices: [{
        delta: { tool_calls: [{ function: { name: "test", arguments: "{}" } }] },
        finish_reason: null,
      }],
    });
    const delta = extractDelta(data);
    expect(delta?.toolCalls).toHaveLength(1);
  });
});

// ─── SSE Emitter ───────────────────────────────────────────────────

describe("SSEEmitter", () => {
  it("sends data events", async () => {
    const { readable, emitter } = createSSEStream();
    // Start reader before writing — TransformStream applies real backpressure,
    // so a reader must be active for writes to complete.
    const decoder = new TextDecoder();
    let result = "";
    const readDone = (async () => {
      const reader = readable.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        result += decoder.decode(value);
      }
    })();

    await emitter.send("hello");
    await emitter.send("world");
    await emitter.close();
    await readDone;

    expect(result).toContain("data: hello\n\n");
    expect(result).toContain("data: world\n\n");
  });

  it("sends JSON payloads", async () => {
    const { readable, emitter } = createSSEStream();
    const decoder = new TextDecoder();
    let text = "";
    const readDone = (async () => {
      const reader = readable.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    })();

    await emitter.sendJSON({ choices: [{ delta: { content: "hi" } }] });
    await emitter.close();
    await readDone;

    expect(text).toContain("data: ");
    const parsed = JSON.parse(text.split("data: ")[1].trim());
    expect(parsed.choices[0].delta.content).toBe("hi");
  });

  it("sends [DONE] sentinel", async () => {
    const { readable, emitter } = createSSEStream();
    const decoder = new TextDecoder();
    let text = "";
    const readDone = (async () => {
      const reader = readable.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    })();

    await emitter.sendDone();
    await emitter.close();
    await readDone;

    expect(text).toContain("data: [DONE]");
  });

  it("sends comments for heartbeats", async () => {
    const { readable, emitter } = createSSEStream();
    const decoder = new TextDecoder();
    let text = "";
    const readDone = (async () => {
      const reader = readable.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        text += decoder.decode(value);
      }
    })();

    await emitter.sendComment("ping");
    await emitter.close();
    await readDone;

    expect(text).toContain(": ping\n\n");
  });

  it("ignores sends after close", async () => {
    const { readable, emitter } = createSSEStream();
    await emitter.close();
    // Should not throw
    await emitter.send("after close");
  });
});

// ─── Stream Evaluator ──────────────────────────────────────────────

describe("StreamEvaluator", () => {
  it("passes through normal content", () => {
    const evaluator = new StreamEvaluator();
    const result = evaluator.evaluateChunk("Hello, world!", undefined);
    expect(result.action).toBe("continue");
  });

  it("detects error patterns in pre-buffer phase", () => {
    const evaluator = new StreamEvaluator({ preBufferChunks: 4 });
    const errorText = '{"error":{"message":"internal server error","detail":"provider returned a successful HTTP status but embedded an error"}}';
    const result = evaluator.evaluateChunk(errorText, undefined);
    expect(result.action).toBe("abort_retry");
    expect(result.failureClass).toBe("success_shaped_failure");
  });

  it("does not abort after pre-buffer phase", () => {
    const evaluator = new StreamEvaluator({ preBufferChunks: 1 });
    // First chunk clears pre-buffer
    evaluator.evaluateChunk("Normal start.", undefined);
    // Second chunk with error text should not abort (post-commit)
    const errorText = "I apologize, but I am unable to complete this request. The server encountered an error processing your query.";
    const result = evaluator.evaluateChunk(errorText, undefined);
    expect(result.action).toBe("continue");
  });

  it("suppresses content inside thinking blocks", () => {
    const evaluator = new StreamEvaluator();
    // Open thinking block
    evaluator.evaluateChunk("<think\n", undefined);
    const content = evaluator.processContent("secret reasoning");
    expect(content).toBe("");
  });

  it("allows content after thinking block closes", () => {
    const evaluator = new StreamEvaluator();
    evaluator.evaluateChunk("<think\nreasoning\n</think\n", undefined);
    expect(evaluator.isInsideThinkingBlock).toBe(false);
    const content = evaluator.processContent("actual answer");
    expect(content).toBe("actual answer");
  });

  it("processes content with special token repair", () => {
    const evaluator = new StreamEvaluator();
    const result = evaluator.processContent("Hello <|eot_id|> world");
    expect(result).toBe("Hello  world");
  });

  it("detects garbled content in pre-buffer", () => {
    const evaluator = new StreamEvaluator({ preBufferChunks: 4 });
    const garbled = "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14";
    const result = evaluator.evaluateChunk(garbled, undefined);
    expect(result.action).toBe("abort_retry");
    expect(result.failureClass).toBe("garbled_response");
  });

  it("reports pre-buffer as complete after enough chunks", () => {
    const evaluator = new StreamEvaluator({ preBufferChunks: 2 });
    evaluator.evaluateChunk("first", undefined);
    expect(evaluator.preBufferComplete).toBe(false); // only 1 chunk
    evaluator.evaluateChunk("second", undefined);
    expect(evaluator.preBufferComplete).toBe(true); // now 2 chunks with content
  });

  it("does not commit before seeing content", () => {
    const evaluator = new StreamEvaluator({ preBufferChunks: 2 });
    evaluator.evaluateChunk(undefined, undefined); // empty chunk
    evaluator.evaluateChunk(undefined, undefined); // empty chunk
    expect(evaluator.shouldCommitToClient).toBe(false); // no content seen yet
  });
});

// ─── Pre-buffer Runtime Semantics ─────────────────────────────────

describe("executeStreamWithPreBuffer", () => {
  it("commits short streams that finish before the pre-buffer threshold", async () => {
    const encoder = new TextEncoder();
    const upstream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "OK" }, finish_reason: null }] })}\n\n`));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });

    const result = executeStreamWithPreBuffer(
      { body: upstream, status: 200, headers: new Headers() },
      {
        preBufferChunks: 4,
        enableThinkingLeakStripping: true,
        enableSpecialTokenRepair: true,
        heartbeatIntervalMs: 0,
        maxSilenceMs: 0,
        firstTokenTimeoutMs: 100,
        hardTimeoutMs: 1000,
      },
    );

    const ready = await Promise.race([
      result.ready,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ready did not resolve")), 100)),
    ]);

    expect(ready).toEqual({ committed: true });
    const body = await new Response(result.readable).text();
    expect(body).toContain("OK");
    expect(body).toContain("data: [DONE]");
    await expect(result.done).resolves.toMatchObject({
      wasAborted: false,
      finishReason: "done",
    });
  });

  it("resolves ready as abort when the first token timeout fires", async () => {
    const upstream = new ReadableStream<Uint8Array>({
      start() {
        // Intentionally never enqueue or close. This used to leave callers
        // awaiting ready forever instead of falling back silently.
      },
    });

    const result = executeStreamWithPreBuffer(
      { body: upstream, status: 200, headers: new Headers() },
      {
        preBufferChunks: 1,
        enableThinkingLeakStripping: true,
        enableSpecialTokenRepair: true,
        heartbeatIntervalMs: 0,
        maxSilenceMs: 0,
        firstTokenTimeoutMs: 5,
        hardTimeoutMs: 0,
      },
    );

    const ready = await Promise.race([
      result.ready,
      new Promise<never>((_, reject) => setTimeout(() => reject(new Error("ready did not resolve")), 100)),
    ]);

    expect(ready).toEqual({ committed: false, abortReason: "first_token_timeout" });
    await expect(result.done).resolves.toMatchObject({
      wasAborted: true,
      abortReason: "first_token_timeout",
      totalChunks: 0,
    });
  });
});

// Full SSE pipeline (emitter -> parser)

describe("SSE pipeline", () => {
  it("round-trips events through emitter and parser", async () => {
    const { readable, emitter } = createSSEStream();

    const parser = new SSEParser();
    const decoder = new TextDecoder();
    const allEvents: Array<{ data: string }> = [];

    // Start reader before writing to satisfy TransformStream backpressure
    const readDone = (async () => {
      const reader = readable.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const text = decoder.decode(value, { stream: true });
        for (const evt of parser.feed(text)) {
          allEvents.push(evt);
        }
      }
      for (const evt of parser.flush()) {
        allEvents.push(evt);
      }
    })();

    await emitter.sendJSON({ choices: [{ delta: { content: "Hello" } }] });
    await emitter.sendJSON({ choices: [{ delta: { content: " world" } }] });
    await emitter.sendDone();
    await emitter.close();
    await readDone;

    expect(allEvents).toHaveLength(3);
    expect(extractDelta(allEvents[0].data)?.content).toBe("Hello");
    expect(extractDelta(allEvents[1].data)?.content).toBe(" world");
    expect(extractDelta(allEvents[2].data)?.finishReason).toBe("done");
  });
});
