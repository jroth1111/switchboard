// SSE parser: reads SSE events from a byte stream.
// Handles the Server-Sent Events wire format (event:, data:, id:, retry:).

export const MAX_SSE_FRAME_SIZE = 262_144; // 256 KiB

export interface SSEEvent {
  event?: string;
  data: string;
  id?: string;
  retry?: number;
}

export class SSEParser {
  private buffer = "";

  /** Feed raw text into the parser and return any complete events. */
  feed(chunk: string): SSEEvent[] {
    // Normalize CRLF to LF on the incoming chunk only (buffer is already normalized)
    const normalized = chunk.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
    this.buffer += normalized;
    // Guard against unbounded buffer growth
    if (this.buffer.length > MAX_SSE_FRAME_SIZE) {
      throw new Error(`sse_frame_too_large: ${this.buffer.length} > ${MAX_SSE_FRAME_SIZE}`);
    }
    const result: SSEEvent[] = [];

    while (true) {
      const idx = this.buffer.indexOf("\n\n");
      if (idx === -1) break;

      const block = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 2);

      const evt = this.parseBlock(block);
      if (evt) {
        result.push(evt);
      }
    }

    return result;
  }

  /** Flush any remaining buffered data (call when stream ends). */
  flush(): SSEEvent[] {
    if (!this.buffer.trim()) return [];
    const evt = this.parseBlock(this.buffer);
    this.buffer = "";
    if (evt) {
      return [evt];
    }
    return [];
  }

  private parseBlock(block: string): SSEEvent | null {
    let event: string | undefined;
    const dataLines: string[] = [];
    let id: string | undefined;
    let retry: number | undefined;

    for (const line of block.split("\n")) {
      if (line.startsWith(":")) continue; // comment
      if (line.startsWith("data:")) {
        // SSE spec: strip one leading space after "data:" if present
        const val = line.slice(5);
        dataLines.push(val.startsWith(" ") ? val.slice(1) : val);
      } else if (line.startsWith("event:")) {
        event = line.slice(6).trim();
      } else if (line.startsWith("id:")) {
        id = line.slice(3).trim();
      } else if (line.startsWith("retry:")) {
        const v = parseInt(line.slice(6).trim(), 10);
        if (!Number.isNaN(v)) retry = v;
      }
    }

    if (dataLines.length === 0) return null;

    return {
      event,
      data: dataLines.join("\n"),
      id,
      retry,
    };
  }
}

/** Parse SSE events from a ReadableStream<Uint8Array>. */
export async function* parseSSEStream(
  stream: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<SSEEvent> {
  const parser = new SSEParser();
  const reader = stream.getReader();
  const decoder = new TextDecoder();

  const abortHandler = () => {
    reader.cancel(new DOMException("Aborted", "AbortError")).catch(() => {});
  };
  if (signal) {
    if (signal.aborted) abortHandler();
    else signal.addEventListener("abort", abortHandler, { once: true });
  }

  try {
    while (true) {
      if (signal?.aborted) break;
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value, { stream: true });
      for (const evt of parser.feed(text)) {
        yield evt;
      }
    }
    if (!signal?.aborted) {
      // Flush remaining decoder bytes (partial UTF-8 at stream end)
      const remaining = decoder.decode();
      if (remaining) {
        for (const evt of parser.feed(remaining)) {
          yield evt;
        }
      }
      // Flush remaining
      for (const evt of parser.flush()) {
        yield evt;
      }
    }
  } catch (err) {
    if (signal?.aborted && err instanceof DOMException && err.name === "AbortError") {
      return;
    }
    throw err;
  } finally {
    if (signal) {
      signal.removeEventListener("abort", abortHandler);
    }
    reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

/** Extract content delta from an OpenAI-format SSE data payload. */
export function extractDelta(data: string): { content?: string; toolCalls?: unknown[]; finishReason?: string; usage?: Record<string, number> } | null {
  if (data.trim() === "[DONE]") return { finishReason: "done" };
  try {
    const json = JSON.parse(data) as Record<string, unknown>;
    const choices = json.choices as Array<Record<string, unknown>> | undefined;
    if (!choices || choices.length === 0) {
      // Some providers send usage on a chunk with empty choices
      if (json.usage && typeof json.usage === "object") {
        return { usage: json.usage as Record<string, number> };
      }
      return null;
    }

    const choice = choices[0];
    const delta = choice.delta as Record<string, unknown> | undefined;
    const result: ReturnType<typeof extractDelta> = {
      content: (delta?.content as string) ?? undefined,
      toolCalls: (delta?.tool_calls as unknown[]) ?? undefined,
      finishReason: (choice.finish_reason as string) ?? undefined,
    };
    // OpenAI includes usage on the final chunk alongside finishReason
    if (json.usage && typeof json.usage === "object") {
      result.usage = json.usage as Record<string, number>;
    }
    return result;
  } catch {
    return null;
  }
}

/** Extract raw usage from an SSE data payload, regardless of choices. */
export function extractUsage(data: string): Record<string, number> | undefined {
  if (data.trim() === "[DONE]") return undefined;
  try {
    const json = JSON.parse(data) as Record<string, unknown>;
    if (json.usage && typeof json.usage === "object") {
      return json.usage as Record<string, number>;
    }
    return undefined;
  } catch {
    return undefined;
  }
}
