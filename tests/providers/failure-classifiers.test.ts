import { describe, it, expect } from "vitest";
import { classifyAnthropicFailure } from "../../src/providers/anthropic-failure";
import { classifyChatGPTFailure } from "../../src/providers/chatgpt-failure";

// ─── Anthropic failure classification ────────────────────────────────

describe("classifyAnthropicFailure", () => {
  it("classifies 401 with expired token as oauth_refresh_failure", () => {
    const result = classifyAnthropicFailure(401, '{"error":"token has expired"}');
    expect(result.failureClass).toBe("oauth_refresh_failure");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(true);
    expect(result.cooldownSeconds).toBe(30);
  });

  it("classifies 401 with 'invalid' as oauth_refresh_failure", () => {
    const result = classifyAnthropicFailure(401, "invalid_token");
    expect(result.failureClass).toBe("oauth_refresh_failure");
    expect(result.affectsAccount).toBe(true);
  });

  it("classifies 401 without token keywords as auth_failure", () => {
    const result = classifyAnthropicFailure(401, '{"error":"unauthorized"}');
    expect(result.failureClass).toBe("auth_failure");
    expect(result.affectsAccount).toBe(true);
    expect(result.cooldownSeconds).toBe(0);
  });

  it("classifies 403 as oauth_session_failure", () => {
    const result = classifyAnthropicFailure(403, '{"error":"forbidden"}');
    expect(result.failureClass).toBe("oauth_session_failure");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(true);
    expect(result.cooldownSeconds).toBe(60);
  });

  it("classifies 403 subscription quota failures as subscription_limit", () => {
    const result = classifyAnthropicFailure(403, '{"error":"subscription quota exceeded"}');
    expect(result.failureClass).toBe("subscription_limit");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(true);
    expect(result.cooldownSeconds).toBe(300);
  });

  it("classifies 429 with usage tier as subscription_limit (account-scoped)", () => {
    const result = classifyAnthropicFailure(429, '{"error":"usage limit exceeded for tier"}');
    expect(result.failureClass).toBe("subscription_limit");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(true);
    expect(result.cooldownSeconds).toBe(120);
  });

  it("classifies 429 without usage as rate_limit_overload (health-affecting)", () => {
    const result = classifyAnthropicFailure(429, '{"error":"too many requests"}');
    expect(result.failureClass).toBe("rate_limit_overload");
    expect(result.affectsHealth).toBe(true);
    expect(result.affectsAccount).toBe(false);
    expect(result.cooldownSeconds).toBe(60);
  });

  it("classifies 429 rate limit text as retryable rate_limit_overload", () => {
    const result = classifyAnthropicFailure(429, '{"error":"rate limit exceeded"}');
    expect(result.failureClass).toBe("rate_limit_overload");
    expect(result.affectsHealth).toBe(true);
    expect(result.affectsAccount).toBe(false);
  });

  it("classifies 400 with context as context_length_exceeded", () => {
    const result = classifyAnthropicFailure(400, "prompt is too long: max tokens exceeded");
    expect(result.failureClass).toBe("context_length_exceeded");
    expect(result.cooldownSeconds).toBe(0);
  });

  it("classifies 400 with 'too many tokens' as context_length_exceeded", () => {
    const result = classifyAnthropicFailure(400, "too many tokens in request");
    expect(result.failureClass).toBe("context_length_exceeded");
  });

  it("classifies 529 as server_5xx (overloaded)", () => {
    const result = classifyAnthropicFailure(529, '{"error":"overloaded"}');
    expect(result.failureClass).toBe("server_5xx");
    expect(result.affectsHealth).toBe(true);
    expect(result.cooldownSeconds).toBe(30);
  });

  it("returns unknown_failure for unclassified status codes", () => {
    const result = classifyAnthropicFailure(500, "Internal Server Error");
    expect(result.failureClass).toBe("unknown_failure");
    expect(result.details).toContain("anthropic_unclassified_500");
  });
});

// ─── ChatGPT failure classification ──────────────────────────────────

describe("classifyChatGPTFailure", () => {
  it("classifies 401 with session expired as oauth_session_failure", () => {
    const result = classifyChatGPTFailure(401, "session has expired");
    expect(result.failureClass).toBe("oauth_session_failure");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(true);
    expect(result.cooldownSeconds).toBe(60);
  });

  it("classifies 401 with token as oauth_session_failure", () => {
    const result = classifyChatGPTFailure(401, "invalid token");
    expect(result.failureClass).toBe("oauth_session_failure");
  });

  it("classifies 401 without session/token keywords as auth_failure", () => {
    const result = classifyChatGPTFailure(401, "unauthorized");
    expect(result.failureClass).toBe("auth_failure");
    expect(result.affectsAccount).toBe(true);
  });

  it("classifies 403 with limit/quota as subscription_limit", () => {
    const result = classifyChatGPTFailure(403, "quota exceeded");
    expect(result.failureClass).toBe("subscription_limit");
    expect(result.cooldownSeconds).toBe(300);
    expect(result.affectsAccount).toBe(true);

    const result2 = classifyChatGPTFailure(403, "subscription limit reached");
    expect(result2.failureClass).toBe("subscription_limit");
  });

  it("classifies 403 without quota keywords as oauth_session_failure", () => {
    const result = classifyChatGPTFailure(403, "access denied");
    expect(result.failureClass).toBe("oauth_session_failure");
    expect(result.cooldownSeconds).toBe(60);
  });

  it("classifies 422 as responses_api_error", () => {
    const result = classifyChatGPTFailure(422, "invalid response format");
    expect(result.failureClass).toBe("responses_api_error");
    expect(result.affectsHealth).toBe(false);
    expect(result.cooldownSeconds).toBe(0);
  });

  it("classifies 400 with 'responses' as responses_api_error", () => {
    const result = classifyChatGPTFailure(400, "responses API error: bad input");
    expect(result.failureClass).toBe("responses_api_error");
  });

  it("classifies 400 with context as context_length_exceeded", () => {
    const result = classifyChatGPTFailure(400, "maximum context length exceeded");
    expect(result.failureClass).toBe("context_length_exceeded");
  });

  it("classifies 404 ChatGPT model errors as invalid_model", () => {
    const result = classifyChatGPTFailure(404, "model not found");
    expect(result.failureClass).toBe("invalid_model");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(false);
    expect(result.cooldownSeconds).toBe(300);
  });

  it("classifies named unavailable ChatGPT model errors as invalid_model", () => {
    const result = classifyChatGPTFailure(400, "model gpt-5.5 is not available");
    expect(result.failureClass).toBe("invalid_model");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(false);
    expect(result.cooldownSeconds).toBe(300);
  });

  it("classifies 429 as rate_limit_overload (health + account)", () => {
    const result = classifyChatGPTFailure(429, "rate limit exceeded");
    expect(result.failureClass).toBe("rate_limit_overload");
    expect(result.affectsHealth).toBe(true);
    expect(result.affectsAccount).toBe(true);
    expect(result.cooldownSeconds).toBe(60);
  });

  it("returns unknown_failure for unclassified status codes", () => {
    const result = classifyChatGPTFailure(502, "Bad Gateway");
    expect(result.failureClass).toBe("unknown_failure");
    expect(result.details).toContain("chatgpt_unclassified_502");
  });
});
