import { describe, it, expect } from "vitest";
import { failureClassToOpenAIError, openAIErrorJson } from "../../src/providers/openai-error-shape";

describe("failureClassToOpenAIError", () => {
  it("maps rate limits to rate_limit_error", () => {
    const e = failureClassToOpenAIError("rate_limit_overload", "too many");
    expect(e.type).toBe("rate_limit_error");
    expect(e.code).toBe("rate_limit_exceeded");
  });

  it("maps oauth failures to authentication_error", () => {
    const e = failureClassToOpenAIError("oauth_refresh_failure", "expired");
    expect(e.type).toBe("authentication_error");
    expect(e.code).toBe("oauth_refresh_failure");
  });

  it("maps context length to invalid_request_error", () => {
    const e = failureClassToOpenAIError("context_length_exceeded", "too long");
    expect(e.type).toBe("invalid_request_error");
    expect(e.code).toBe("context_length_exceeded");
    expect(e.param).toBe("messages");
  });

  it("openAIErrorJson includes request_id when provided", () => {
    const raw = openAIErrorJson("server_5xx", "upstream", "req_abc");
    const parsed = JSON.parse(raw) as { error: { type: string }; request_id: string };
    expect(parsed.error.type).toBe("server_error");
    expect(parsed.request_id).toBe("req_abc");
  });
});
