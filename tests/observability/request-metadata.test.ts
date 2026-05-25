import { describe, it, expect } from "vitest";
import { extractRequestMetadata } from "../../src/observability/request-metadata";

describe("extractRequestMetadata", () => {
  it("reads session and trace headers", () => {
    const req = new Request("https://x", {
      headers: {
        "X-Switchboard-Session-Id": "sess-1",
        "X-Switchboard-Trace-Id": "trace-9",
      },
    });
    expect(extractRequestMetadata(req)).toEqual({
      sessionId: "sess-1",
      traceId: "trace-9",
    });
  });
});
