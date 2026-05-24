import { describe, it, expect } from "vitest";
import { classifyChatGPTFailure } from "../../src/providers/chatgpt-failure";
import { classifyAnthropicFailure } from "../../src/providers/anthropic-failure";

describe("ChatGPT failure classifier", () => {
  it("classifies 401 session expiry as health-neutral", () => {
    const result = classifyChatGPTFailure(401, '{"error": "session expired"}');
    expect(result.failureClass).toBe("oauth_session_failure");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(true);
  });

  it("classifies 401 token error as health-neutral", () => {
    const result = classifyChatGPTFailure(401, '{"error": "invalid token"}');
    expect(result.failureClass).toBe("oauth_session_failure");
    expect(result.affectsHealth).toBe(false);
  });

  it("classifies 401 generic as auth_failure", () => {
    const result = classifyChatGPTFailure(401, "unauthorized");
    expect(result.failureClass).toBe("auth_failure");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(true);
  });

  it("classifies 403 subscription limit", () => {
    const result = classifyChatGPTFailure(403, "subscription limit reached");
    expect(result.failureClass).toBe("subscription_limit");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(true);
    expect(result.cooldownSeconds).toBe(300);
  });

  it("classifies 403 quota limit", () => {
    const result = classifyChatGPTFailure(403, "quota exceeded");
    expect(result.failureClass).toBe("subscription_limit");
  });

  it("classifies 403 generic as session failure", () => {
    const result = classifyChatGPTFailure(403, "forbidden");
    expect(result.failureClass).toBe("oauth_session_failure");
  });

  it("classifies 422 Responses API error", () => {
    const result = classifyChatGPTFailure(422, "responses format invalid");
    expect(result.failureClass).toBe("responses_api_error");
    expect(result.affectsHealth).toBe(false);
  });

  it("classifies 400 with responses as Responses API error", () => {
    const result = classifyChatGPTFailure(400, "responses api: invalid input");
    expect(result.failureClass).toBe("responses_api_error");
  });

  it("classifies 429 rate limit", () => {
    const result = classifyChatGPTFailure(429, "rate limit exceeded");
    expect(result.failureClass).toBe("rate_limit_overload");
    expect(result.affectsHealth).toBe(true);
    expect(result.affectsAccount).toBe(true);
  });

  it("returns unknown for unclassified status", () => {
    const result = classifyChatGPTFailure(500, "internal error");
    expect(result.failureClass).toBe("unknown_failure");
    expect(result.affectsHealth).toBe(false);
  });
});

describe("Anthropic failure classifier", () => {
  it("classifies 401 expired token as oauth_refresh_failure", () => {
    const result = classifyAnthropicFailure(401, '{"error": "invalid x-api-key"}');
    expect(result.failureClass).toBe("oauth_refresh_failure");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(true);
  });

  it("classifies 401 expired token", () => {
    const result = classifyAnthropicFailure(401, "token has expired");
    expect(result.failureClass).toBe("oauth_refresh_failure");
    expect(result.affectsHealth).toBe(false);
  });

  it("classifies 401 generic as auth_failure", () => {
    const result = classifyAnthropicFailure(401, "unauthorized");
    expect(result.failureClass).toBe("auth_failure");
    expect(result.affectsAccount).toBe(true);
  });

  it("classifies 403 as session failure", () => {
    const result = classifyAnthropicFailure(403, "permission denied");
    expect(result.failureClass).toBe("oauth_session_failure");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(true);
  });

  it("classifies 429 usage limit as subscription_limit", () => {
    const result = classifyAnthropicFailure(429, "usage limit reached for tier");
    expect(result.failureClass).toBe("subscription_limit");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(true);
  });

  it("classifies 429 generic as rate_limit_overload", () => {
    const result = classifyAnthropicFailure(429, "too many requests");
    expect(result.failureClass).toBe("rate_limit_overload");
    expect(result.affectsHealth).toBe(true);
    expect(result.affectsAccount).toBe(false);
  });

  it("classifies 529 overloaded as server_5xx", () => {
    const result = classifyAnthropicFailure(529, "overloaded");
    expect(result.failureClass).toBe("server_5xx");
    expect(result.affectsHealth).toBe(true);
  });

  it("returns unknown for unclassified status", () => {
    const result = classifyAnthropicFailure(502, "bad gateway");
    expect(result.failureClass).toBe("unknown_failure");
  });
});
