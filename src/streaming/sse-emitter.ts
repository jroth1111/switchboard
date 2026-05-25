// SSE emitter: writes Server-Sent Events to a WritableStream.
// Produces the text/event-stream wire format.

import { MAX_SSE_FRAME_SIZE } from "./sse-parser";

export class SSEEmitter {
  private writer: WritableStreamDefaultWriter<Uint8Array>;
  private encoder = new TextEncoder();
  private closed = false;
  private maxFrameSize: number;
  private released = false;

  constructor(writable: WritableStream<Uint8Array>, maxFrameSize = MAX_SSE_FRAME_SIZE) {
    this.writer = writable.getWriter();
    this.maxFrameSize = maxFrameSize;
  }

  async send(data: string, event?: string, id?: string): Promise<void> {
    if (this.closed) return;
    let msg = "";
    if (id) msg += `id: ${id}\n`;
    if (event) msg += `event: ${event}\n`;
    for (const line of data.split("\n")) {
      msg += `data: ${line}\n`;
    }
    msg += "\n";
    if (msg.length > this.maxFrameSize) {
      throw new Error(`sse_frame_too_large: ${msg.length} > ${this.maxFrameSize}`);
    }
    await this.writer.write(this.encoder.encode(msg));
  }

  async sendJSON(payload: unknown): Promise<void> {
    await this.send(JSON.stringify(payload));
  }

  async sendDone(): Promise<void> {
    await this.send("[DONE]");
  }

  async sendComment(comment: string): Promise<void> {
    if (this.closed) return;
    await this.writer.write(this.encoder.encode(`: ${comment}\n\n`));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      await this.writer.close();
    } catch {
      // writer may already be closed
    } finally {
      this.releaseWriter();
    }
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private releaseWriter(): void {
    if (this.released) return;
    this.released = true;
    try {
      this.writer.releaseLock();
    } catch {
      // lock may already be released by the underlying stream implementation
    }
  }
}

/** Create a ReadableStream<Response> pair for SSE streaming. */
export function createSSEStream(): {
  readable: ReadableStream<Uint8Array>;
  emitter: SSEEmitter;
} {
  // TransformStream wires the read and write sides together so that the
  // writable's write() promise does not resolve until the readable side has
  // capacity — giving real backpressure instead of the fake queueMicrotask trick.
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const emitter = new SSEEmitter(writable);
  return { readable, emitter };
}
