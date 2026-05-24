// Stream evaluator: inspects streaming chunks for NIM-specific issues.
// Runs in pre-buffer mode to detect problems before committing to the client stream.

import { stripThinkingLeaks, THINKING_TAG_NAMES } from "../nim/repair/thinking";
import { repairSpecialTokens } from "../nim/repair/special-tokens";
import { detectSuccessShapedFailure } from "../nim/classify/semantic";

// Pre-compiled regex patterns derived from the shared tag name list.
const THINKING_TAG_ALTERNATION = THINKING_TAG_NAMES.join("|");
const thinkingOpenRe = new RegExp(`<(${THINKING_TAG_ALTERNATION})\\b`, "g");
const thinkingCloseRe = new RegExp(`<\\/(${THINKING_TAG_ALTERNATION})\\b`, "g");

export interface StreamEvaluation {
  action: "continue" | "abort_retry" | "abort_accept";
  reason?: string;
  failureClass?: string;
}

export interface StreamEvaluatorConfig {
  preBufferChunks: number;
  enableThinkingLeakStripping: boolean;
  enableSpecialTokenRepair: boolean;
  heartbeatIntervalMs: number;
  maxSilenceMs: number;
}

const DEFAULT_STREAM_CONFIG: StreamEvaluatorConfig = {
  preBufferChunks: 4,
  enableThinkingLeakStripping: true,
  enableSpecialTokenRepair: true,
  heartbeatIntervalMs: 15000,
  maxSilenceMs: 30000,
};

export class StreamEvaluator {
  private config: StreamEvaluatorConfig;
  private contentBuffer = "";
  private chunkCount = 0;
  private thinkingDepth = 0;
  private inThinkingBlock = false;
  private firstContentSeen = false;
  private hasSentToClient = false;

  constructor(config?: Partial<StreamEvaluatorConfig>) {
    this.config = { ...DEFAULT_STREAM_CONFIG, ...config };
  }

  /** Evaluate a chunk. Returns whether this chunk should be buffered (pre-buffer phase)
   *  or passed through. */
  evaluateChunk(
    content: string | undefined,
    finishReason: string | undefined,
    toolCalls?: unknown,
  ): StreamEvaluation {
    this.chunkCount++;
    const isPreBuffer = this.chunkCount <= this.config.preBufferChunks;

    if (content) {
      // Only accumulate content during pre-buffer phase for error detection.
      // After pre-buffer, stop growing to avoid unbounded memory use on long streams.
      if (!this.hasSentToClient) {
        this.contentBuffer += content;
      }
      this.firstContentSeen = true;

      // Track thinking block depth
      this.updateThinkingState(content);
    }

    if (toolCalls) {
      this.firstContentSeen = true;
    }

    // Pre-buffer evaluation: check for early-abort signals
    if (isPreBuffer && !this.hasSentToClient) {
      // Check if content looks like an error message (success-shaped failure)
      if (this.contentBuffer.length > 50 && isErrorPattern(this.contentBuffer)) {
        return {
          action: "abort_retry",
          reason: "success_shaped_failure_in_stream",
          failureClass: "success_shaped_failure",
        };
      }

      // Check for immediate garbled content
      if (this.contentBuffer.length > 20) {
        let printable = 0;
        for (const ch of this.contentBuffer) {
          const cp = ch.charCodeAt(0);
          if ((cp >= 32 && cp <= 126) || (cp >= 160 && cp !== 0xFEFF)) printable++;
        }
        const printableRatio = printable / this.contentBuffer.length;
        if (printableRatio < 0.6) {
          return {
            action: "abort_retry",
            reason: "garbled_stream_content",
            failureClass: "garbled_response",
          };
        }
      }
    }

    // If finish_reason indicates truncation
    if (finishReason === "length") {
      // Let the chunk through but note truncation for receipt
    }

    // If we've passed pre-buffer and haven't found issues, commit to client
    if (!isPreBuffer && !this.hasSentToClient && this.firstContentSeen) {
      this.hasSentToClient = true;
    }

    return { action: "continue" };
  }

  /** Process content for output: strip thinking leaks, repair tokens. */
  processContent(content: string): string {
    let result = content;

    // Handle thinking block suppression
    if (this.inThinkingBlock) {
      return ""; // suppress content inside thinking blocks
    }

    if (this.config.enableThinkingLeakStripping) {
      result = stripThinkingLeaks(result);
    }

    if (this.config.enableSpecialTokenRepair) {
      result = repairSpecialTokens(result);
    }

    return result;
  }

  /** Check if pre-buffer phase is complete and no issues found. */
  get preBufferComplete(): boolean {
    return this.chunkCount >= this.config.preBufferChunks && this.firstContentSeen;
  }

  get shouldCommitToClient(): boolean {
    if (this.hasSentToClient) return true;
    return this.preBufferComplete;
  }

  /** Get the buffered content that was suppressed during pre-buffer. */
  get bufferedContent(): string {
    return this.contentBuffer;
  }

  /** Whether we're currently inside a thinking block. */
  get isInsideThinkingBlock(): boolean {
    return this.inThinkingBlock;
  }

  private updateThinkingState(content: string): void {
    thinkingOpenRe.lastIndex = 0;
    thinkingCloseRe.lastIndex = 0;

    while (thinkingOpenRe.exec(content) !== null) {
      this.thinkingDepth++;
      this.inThinkingBlock = true;
    }
    while (thinkingCloseRe.exec(content) !== null) {
      this.thinkingDepth = Math.max(0, this.thinkingDepth - 1);
      if (this.thinkingDepth === 0) this.inThinkingBlock = false;
    }
  }
}

function isErrorPattern(text: string): boolean {
  return detectSuccessShapedFailure(text) !== null;
}
