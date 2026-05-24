import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { log, setLogLevel } from "../../src/observability/logging";

describe("structured logging", () => {
  const logLines: string[] = [];
  let originalLog: typeof console.log;

  beforeEach(() => {
    setLogLevel("info");
    logLines.length = 0;
    originalLog = console.log;
    console.log = ((value: string) => {
      logLines.push(String(value));
    }) as typeof console.log;
  });

  afterEach(() => {
    console.log = originalLog;
  });

  it("does not let caller data override core log fields", () => {
    log("info", "request_end", {
      level: "error",
      message: "override",
      timestamp: "1970-01-01T00:00:00.000Z",
      requestId: "req-1",
    });

    const entry = JSON.parse(logLines[0]);
    expect(entry.level).toBe("info");
    expect(entry.message).toBe("request_end");
    expect(entry.timestamp).not.toBe("1970-01-01T00:00:00.000Z");
    expect(entry.requestId).toBe("req-1");
  });

  it("respects configured minimum log level", () => {
    setLogLevel("warn");
    log("info", "hidden");
    log("warn", "visible");

    expect(logLines).toHaveLength(1);
    expect(JSON.parse(logLines[0]).message).toBe("visible");
  });
});
