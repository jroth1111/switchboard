import { describe, it, expect } from "vitest";
import { extractRequestMetadata } from "../../src/observability/request-metadata";

describe("receipt metadata sanitization", () => {
  it("extracts custom property headers with sanitization", () => {
    const headers: Record<string, string> = {
      "X-Switchboard-Session-Id": "sess-abc",
      "X-Switchboard-Trace-Id": "trace-xyz",
      "X-Switchboard-Property-Env": "production",
      "Helicone-Property-Tenant": "acme-corp",
    };
    const req = new Request("https://example.com/v1/chat/completions", { headers });
    const meta = extractRequestMetadata(req);
    expect(meta.sessionId).toBe("sess-abc");
    expect(meta.traceId).toBe("trace-xyz");
    expect(meta.properties).toBeDefined();
    expect((meta.properties as Record<string, string>).env).toBe("production");
    expect((meta.properties as Record<string, string>).tenant).toBe("acme-corp");
  });

  it("omits properties when no property headers present", () => {
    const req = new Request("https://example.com/v1/chat/completions", {
      headers: { "X-Switchboard-Session-Id": "s1" },
    });
    const meta = extractRequestMetadata(req);
    expect(meta.sessionId).toBe("s1");
    expect(meta.properties).toBeUndefined();
  });
});
