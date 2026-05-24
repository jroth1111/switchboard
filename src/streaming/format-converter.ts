// Streaming format converter: wraps provider-native SSE streams into OpenAI format.
// Converts Anthropic Messages SSE and ChatGPT Responses SSE to OpenAI chat completion chunks.

import { SSEParser, type SSEEvent } from "./sse-parser";
import { convertAnthropicStreamChunk } from "../providers/anthropic-subscription";
import { convertResponsesStreamChunk } from "../providers/chatgpt-responses";

export type SubscriptionStreamFormat = "anthropic_subscription" | "chatgpt_responses";

export function wrapSubscriptionStream(
  upstream: ReadableStream<Uint8Array>,
  format: SubscriptionStreamFormat,
  requestId: string,
  model: string,
): ReadableStream<Uint8Array> {
  const parser = new SSEParser();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  const reader = upstream.getReader();
  let doneSent = false;

  // Anthropic: track mapping from content block index to tool call index
  const toolCallIndexMap = new Map<number, number>();
  let nextToolCallIdx = 0;

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            // Flush remaining parser buffer
            for (const evt of parser.flush()) {
              const converted = convertEvent(evt, format, requestId, model, toolCallIndexMap);
              if (converted) {
                if (converted === "data: [DONE]\n\n") doneSent = true;
                controller.enqueue(encoder.encode(converted));
              }
            }
            // Subscription providers don't send [DONE] natively — emit it for OpenAI clients
            if (!doneSent) {
              controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            }
            controller.close();
            return;
          }

          const text = decoder.decode(value, { stream: true });
          const events = parser.feed(text);

          for (const evt of events) {
            // Build tool call index mapping (content block index → sequential tool call index)
            trackToolCallIndex(evt, format, toolCallIndexMap, () => nextToolCallIdx++);
            const converted = convertEvent(evt, format, requestId, model, toolCallIndexMap);
            if (converted) {
              if (converted === "data: [DONE]\n\n") doneSent = true;
              controller.enqueue(encoder.encode(converted));
            }
          }

          // Only yield if we produced output; otherwise keep pulling
          if (events.length > 0) return;
        }
      } catch (err) {
        // Propagate the error — the pre-buffer pipeline will detect it
        // and mark the stream as aborted (wasAborted = true), which
        // correctly records a stream_interruption failure instead of
        // false success. Previously this emitted finish_reason: "stop"
        // + [DONE], masking the failure from health tracking.
        try { controller.error(err); } catch { /* already closed */ }
        throw err;
      }
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

function convertEvent(
  evt: SSEEvent,
  format: SubscriptionStreamFormat,
  requestId: string,
  model: string,
  toolCallIndexMap?: Map<number, number>,
): string | null {
  const data = evt.data;
  if (!data || data === "[DONE]") {
    return data === "[DONE]" ? "data: [DONE]\n\n" : null;
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return null;
  }

  let converted: Record<string, unknown> | null;
  if (format === "anthropic_subscription") {
    converted = convertAnthropicStreamChunk(
      parsed as { type: string; [key: string]: unknown },
      requestId,
      model,
      toolCallIndexMap,
    );
  } else {
    converted = convertResponsesStreamChunk(parsed, requestId, model, toolCallIndexMap);
  }

  if (!converted) return null;
  return `data: ${JSON.stringify(converted)}\n\n`;
}

/** Track tool call items to map provider output index → sequential OpenAI tool_calls index. */
function trackToolCallIndex(
  evt: SSEEvent,
  format: SubscriptionStreamFormat,
  toolCallIndexMap: Map<number, number>,
  allocIndex: () => number,
): void {
  if (!evt.data) return;
  try {
    const parsed = JSON.parse(evt.data) as Record<string, unknown>;
    if (format === "anthropic_subscription") {
      if (parsed.type === "content_block_start") {
        const cb = parsed.content_block as Record<string, unknown> | undefined;
        if (cb?.type === "tool_use") {
          toolCallIndexMap.set((parsed.index as number) ?? 0, allocIndex());
        }
      }
    } else if (format === "chatgpt_responses") {
      if (parsed.type === "response.output_item.added") {
        const item = parsed.item as Record<string, unknown> | undefined;
        if (item?.type === "function_call") {
          toolCallIndexMap.set((parsed.output_index as number) ?? 0, allocIndex());
        }
      }
    }
  } catch { /* ignore parse errors */ }
}
