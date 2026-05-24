// Pre-buffer mode: buffers initial streaming chunks before committing to the
// client response. Enables silent failover when early chunks signal failure.

import type { SSEEvent } from "./sse-parser";
import { parseSSEStream, extractDelta, extractUsage } from "./sse-parser";
import { createSSEStream } from "./sse-emitter";
import { StreamEvaluator } from "./stream-evaluator";
import type { TokenUsage } from "../observability/token-usage";
import { logWarn } from "../observability/logging";

const MAX_BUFFERED_EVENTS = 100;

export interface PreBufferResult {
  /** The readable stream to return to the client. */
  readable: ReadableStream<Uint8Array>;
  /** Resolves once the stream is safe to expose, or aborts before client commit. */
  ready: Promise<PreBufferReady>;
  /** A promise that resolves when the stream ends, with metadata. */
  done: Promise<StreamDone>;
}

export interface PreBufferReady {
  committed: boolean;
  abortReason?: string;
}

export interface StreamDone {
  finishReason?: string;
  totalChunks: number;
  wasAborted: boolean;
  abortReason?: string;
  usage?: TokenUsage;
}

export interface PreBufferConfig {
  preBufferChunks: number;
  enableThinkingLeakStripping: boolean;
  enableSpecialTokenRepair: boolean;
  heartbeatIntervalMs: number;
  maxSilenceMs: number;
  firstTokenTimeoutMs: number;
  hardTimeoutMs: number;
  signal?: AbortSignal;
}

/**
 * Execute a streaming provider response through the pre-buffer pipeline.
 *
 * 1. Buffer the first N chunks
 * 2. Evaluate them for issues (garbled, error messages, etc.)
 * 3. If clean, replay buffered chunks and stream the rest to the client
 * 4. If bad, abort the upstream and signal retry
 */
export function executeStreamWithPreBuffer(
  upstream: { body: ReadableStream<Uint8Array> | null; status: number; headers: Headers },
  config: PreBufferConfig,
): PreBufferResult {
  const { readable, emitter } = createSSEStream();
  let resolveDone: (done: StreamDone) => void;
  const done = new Promise<StreamDone>((resolve) => { resolveDone = resolve; });
  let resolveReady: (ready: PreBufferReady) => void;
  const ready = new Promise<PreBufferReady>((resolve) => { resolveReady = resolve; });
  let readyResolved = false;
  const finishReady = (value: PreBufferReady) => {
    if (readyResolved) return;
    readyResolved = true;
    resolveReady(value);
  };
  let doneResolved = false;
  const finishDone = (value: StreamDone) => {
    if (doneResolved) return;
    doneResolved = true;
    resolveDone!(value);
  };

  const evaluator = new StreamEvaluator({
    preBufferChunks: config.preBufferChunks,
    enableThinkingLeakStripping: config.enableThinkingLeakStripping,
    enableSpecialTokenRepair: config.enableSpecialTokenRepair,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    maxSilenceMs: config.maxSilenceMs,
  });

  // Run the streaming pipeline in background
  (async () => {
    let totalChunks = 0;
    let wasAborted = false;
    let abortReason: string | undefined;
    let finishReason: string | undefined;
    const bufferedEvents: SSEEvent[] = [];
    let committed = false;
    let firstChunkReceived = false;
    let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
    let firstTokenTimer: ReturnType<typeof setTimeout> | undefined;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let hardTimer: ReturnType<typeof setTimeout> | undefined;
    let streamPromptTokens: number | undefined;
    let streamCompletionTokens: number | undefined;
    // Internal abort controller for the SSE reader — allows abortStream()
    // to break the for-await loop without calling cancel() on a locked body.
    const readerAbort = new AbortController();
    let configAbortHandler: (() => void) | undefined;

    const clearTimers = () => {
      if (heartbeatTimer) {
        clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
      }
      if (firstTokenTimer) {
        clearTimeout(firstTokenTimer);
        firstTokenTimer = undefined;
      }
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = undefined;
      }
      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = undefined;
      }
    };

    const abortStream = (reason: string) => {
      if (wasAborted) return;
      wasAborted = true;
      abortReason = reason;
      // All three calls must fire here (not deferred to the finally block) because the
      // for-await loop may be permanently blocked on reader.read() when no upstream
      // chunks arrive (e.g. first-token timeout on a silent stream). The finally block
      // calls them again as a safety net; flag guards make both paths idempotent.
      if (!committed) finishReady({ committed: false, abortReason });
      clearTimers();
      emitter.close().catch(() => {});
      // Abort the SSE reader to unblock a stuck reader.read() in the for-await loop.
      // We can't call upstream.body.cancel() directly because parseSSEStream
      // holds a reader lock on it; aborting the signal causes the generator's
      // finally block to release the reader cleanly.
      readerAbort.abort();
      finishDone({ finishReason, totalChunks, wasAborted, abortReason, usage: buildStreamUsage(streamPromptTokens, streamCompletionTokens) });
    };

    if (config.signal) {
      configAbortHandler = () => abortStream("client_abort");
      if (config.signal.aborted) {
        configAbortHandler();
      } else {
        config.signal.addEventListener("abort", configAbortHandler, { once: true });
      }
    }

    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (config.maxSilenceMs > 0) {
        idleTimer = setTimeout(() => {
          abortStream("idle_timeout");
        }, config.maxSilenceMs);
      }
    };

    try {
      if (wasAborted) return;

      if (!upstream.body || upstream.status >= 400) {
        // Non-success upstream — signal abort
        wasAborted = true;
        abortReason = `upstream_status_${upstream.status}`;
        finishReady({ committed: false, abortReason });
        await emitter.close();
        finishDone({ finishReason, totalChunks, wasAborted, abortReason, usage: buildStreamUsage(streamPromptTokens, streamCompletionTokens) });
        return;
      }

      const eventStream = parseSSEStream(upstream.body, readerAbort.signal);

      // Heartbeat to keep connection alive
      if (config.heartbeatIntervalMs > 0) {
        heartbeatTimer = setInterval(() => {
          if (!emitter.isClosed) {
            emitter.sendComment("heartbeat").catch(() => {});
          }
        }, config.heartbeatIntervalMs);
      }

      // First-token timeout: abort if no chunk arrives within firstTokenTimeoutMs
      if (config.firstTokenTimeoutMs > 0) {
        firstTokenTimer = setTimeout(() => {
          if (!firstChunkReceived) abortStream("first_token_timeout");
        }, config.firstTokenTimeoutMs);
      }

      if (config.hardTimeoutMs > 0) {
        hardTimer = setTimeout(() => {
          abortStream("hard_timeout");
        }, config.hardTimeoutMs);
      }

      resetIdleTimer();

      for await (const evt of eventStream) {
        if (readerAbort.signal.aborted) break;
        if (wasAborted) break;

        totalChunks++;
        resetIdleTimer();

        // Extract usage from any SSE event that carries it
        const rawUsage = extractUsage(evt.data);
        if (rawUsage) {
          const p = rawUsage.prompt_tokens ?? rawUsage.input_tokens;
          const c = rawUsage.completion_tokens ?? rawUsage.output_tokens;
          if (p !== undefined && p > 0) streamPromptTokens = p;
          if (c !== undefined && c > 0) streamCompletionTokens = c;
        }

        // Mark first chunk received
        if (!firstChunkReceived) {
          firstChunkReceived = true;
          if (firstTokenTimer) {
            clearTimeout(firstTokenTimer);
            firstTokenTimer = undefined;
          }
        }

        const delta = extractDelta(evt.data);
        if (!delta) {
          const abortForPayload = classifyUnusableStreamPayload(evt);
          if (abortForPayload) {
            abortStream(abortForPayload);
            break;
          }
          // Non-data event (e.g. ping) — pass through if committed
          if (committed) {
            await emitter.send(evt.data, evt.event, evt.id);
          }
          continue;
        }

        if (delta.finishReason === "done") {
          // Stream complete
          finishReason = "done";
          // Very short streams can finish before the pre-buffer threshold. Commit
          // before replaying buffered chunks so callers return a Response and start
          // reading; otherwise TransformStream backpressure can deadlock ready.
          if (!committed) {
            committed = true;
            finishReady({ committed: true });
            for (const bEvt of bufferedEvents) {
              const bDelta = extractDelta(bEvt.data);
              if (bDelta?.content) {
                const processed = evaluator.processContent(bDelta.content);
                if (processed !== bDelta.content) {
                  const modifiedData = rebuildDeltaData(bEvt.data, processed);
                  await emitter.send(modifiedData, bEvt.event, bEvt.id);
                  continue;
                }
              }
              await emitter.send(bEvt.data, bEvt.event, bEvt.id);
            }
          }
          await emitter.sendDone();
          break;
        }

        if (delta.finishReason) {
          finishReason = delta.finishReason;
        }

        // Evaluate chunk
        const evaluation = evaluator.evaluateChunk(delta.content, delta.finishReason, delta.toolCalls);

        if (evaluation.action === "abort_retry") {
          abortStream(evaluation.reason ?? "stream_evaluation_failed");
          break;
        }

        // Pre-buffer: accumulate chunks until we can commit
        if (!committed) {
          bufferedEvents.push(evt);

          if (bufferedEvents.length >= MAX_BUFFERED_EVENTS) {
            abortStream("pre_buffer_overflow");
            break;
          }

          if (evaluator.shouldCommitToClient) {
            committed = true;
            finishReady({ committed: true });
            // Replay buffered events with content processing
            for (const bEvt of bufferedEvents) {
              const bDelta = extractDelta(bEvt.data);
              if (bDelta?.content) {
                const processed = evaluator.processContent(bDelta.content);
                if (processed !== bDelta.content) {
                  // Content was modified — rebuild the SSE event
                  const modifiedData = rebuildDeltaData(bEvt.data, processed);
                  await emitter.send(modifiedData, bEvt.event, bEvt.id);
                  continue;
                }
              }
              await emitter.send(bEvt.data, bEvt.event, bEvt.id);
            }
            bufferedEvents.length = 0;
          }
        } else {
          // Post-commit: process and stream directly
          if (delta.content) {
            const processed = evaluator.processContent(delta.content);
            if (processed !== delta.content) {
              const modifiedData = rebuildDeltaData(evt.data, processed);
              await emitter.send(modifiedData, evt.event, evt.id);
              continue;
            }
          }
          await emitter.send(evt.data, evt.event, evt.id);
        }
      }

      clearTimers();
    } catch (err) {
      if (!wasAborted) {
        wasAborted = true;
        abortReason = err instanceof Error ? err.message : "stream_error";
      }
    } finally {
      if (configAbortHandler) {
        config.signal?.removeEventListener("abort", configAbortHandler);
      }
      clearTimers();
      // Cancel upstream body to release resources
      if (upstream.body) {
        try { await upstream.body.cancel(); } catch { /* already consumed */ }
      }
      if (!readyResolved) {
        finishReady({ committed: committed && !wasAborted, abortReason });
      }
      await emitter.close();
      finishDone({ finishReason, totalChunks, wasAborted, abortReason, usage: buildStreamUsage(streamPromptTokens, streamCompletionTokens) });
    }
  })().catch((err) => {
    logWarn("pre_buffer_unhandled_error", { error: String(err) });
  });

  return { readable, ready, done };
}

function buildStreamUsage(
  promptTokens: number | undefined,
  completionTokens: number | undefined,
): TokenUsage {
  if (promptTokens !== undefined && completionTokens !== undefined) {
    return {
      kind: "known",
      promptTokens,
      completionTokens,
      totalTokens: promptTokens + completionTokens,
      source: "streaming",
    };
  }
  return { kind: "unknown", source: "streaming" };
}

/** Rebuild SSE data payload with modified content. */
function rebuildDeltaData(originalData: string, newContent: string): string {
  if (originalData === "[DONE]") return originalData;
  try {
    const json = JSON.parse(originalData) as Record<string, unknown>;
    const choices = json.choices as Array<Record<string, unknown>>;
    if (choices?.[0]) {
      const delta = choices[0].delta as Record<string, unknown>;
      if (delta) delta.content = newContent;
    }
    return JSON.stringify(json);
  } catch {
    return originalData;
  }
}

function classifyUnusableStreamPayload(evt: SSEEvent): string | null {
  const data = evt.data.trim();
  if (!data || data === "[DONE]") return null;

  const eventName = evt.event?.toLowerCase();
  if (eventName && eventName !== "message") {
    return eventName === "error" ? "stream_error_event" : null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return "malformed_stream_json";
  }

  if (isRecord(parsed) && parsed.error !== undefined) {
    return "stream_error_payload";
  }

  if (isRecord(parsed) && parsed.type === "ping") {
    return null;
  }

  return "unrecognized_stream_payload";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
