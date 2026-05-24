import { afterEach, describe, expect, it, vi } from "vitest";
import { logInfo, setLogLevel } from "../../src/observability/logging";

describe("structured logging", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    setLogLevel("info");
  });

  it("redacts sensitive log data and protects reserved fields", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);

    logInfo("request_start Bearer token123", {
      level: "debug",
      message: "override",
      timestamp: "1970-01-01T00:00:00.000Z",
      authorization: "Bearer token123",
      failureMessage: "provider echoed prompt text",
      path: "/Users/alice/.config/auth.json",
    });

    expect(spy).toHaveBeenCalledTimes(1);
    const entry = JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("request_start Bearer ***REDACTED***");
    expect(entry.timestamp).not.toBe("1970-01-01T00:00:00.000Z");
    expect(entry.authorization).toBe("<redacted>");
    expect(entry.path).toBe("<redacted>");
    expect(JSON.stringify(entry)).not.toContain("provider echoed prompt text");
  });

  it("formats circular data instead of throwing", () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const data: Record<string, unknown> = { requestId: "req-log-circular" };
    data.self = data;

    logInfo("request_end", data);

    const entry = JSON.parse(spy.mock.calls[0][0] as string) as Record<string, unknown>;
    expect(entry.requestId).toBe("req-log-circular");
    expect(entry.self).toBe("[Circular]");
  });
});
