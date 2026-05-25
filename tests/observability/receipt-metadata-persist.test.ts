import { describe, it, expect } from "vitest";
import { extractRequestMetadata } from "../../src/observability/request-metadata";
import { estimateUsageCostUsd } from "../../src/observability/usage-cost";

describe("receipt metadata and cost helpers", () => {
  it("extracts session and trace headers", () => {
    const req = new Request("https://example.com/v1/chat/completions", {
      headers: {
        "X-Switchboard-Session-Id": "sess-abc",
        "X-Switchboard-Trace-Id": "trace-xyz",
      },
    });
    expect(extractRequestMetadata(req)).toEqual({
      sessionId: "sess-abc",
      traceId: "trace-xyz",
    });
  });

  it("estimates usage cost for known providers", () => {
    expect(estimateUsageCostUsd("nvidia_nim", {
      kind: "known",
      promptTokens: 1000,
      completionTokens: 1000,
      totalTokens: 2000,
      source: "nim",
    })).toBe(0);
  });
});
