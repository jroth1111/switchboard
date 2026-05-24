import { describe, it, expect } from "vitest";
import {
  classifySemanticIssue,
  detectSuccessShapedFailure,
  detectTruncation,
  detectRepetition,
  detectSpecialTokenLeak,
  type SemanticValidationConfig,
} from "../../src/nim/classify/semantic";
import { classifyRateLimit } from "../../src/nim/classify/rate-limit";
import { classifyProviderFailure } from "../../src/nim/classify/provider-failure";

const defaultConfig: SemanticValidationConfig = {
  minChars: 1,
  minEntropy: 2.5,
  minPrintableRatio: 0.8,
  repetitionMaxRatio: 0.4,
};

describe("input echo detection", () => {
  it("does not false-positive when repeated response tokens collapse the overlap denominator", () => {
    const input = "alpha beta";
    const response = "alpha beta alpha beta alpha beta";
    const result = classifySemanticIssue(response, defaultConfig, undefined, input);
    expect(result).toBeNull();
  });
});

describe("semantic classifier", () => {
  it("detects empty responses", () => {
    const result = classifySemanticIssue("", defaultConfig);
    expect(result?.issue).toBe("empty_response");
  });

  it("detects garbled responses with low printable ratio", () => {
    const garbled = "\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b";
    const result = classifySemanticIssue(garbled, defaultConfig);
    expect(result?.issue).toBe("garbled_response");
  });

  it("accepts normal text", () => {
    const normal = "Hello, this is a perfectly normal response from the assistant.";
    const result = classifySemanticIssue(normal, defaultConfig);
    expect(result).toBeNull();
  });

  it("detects null bytes", () => {
    const withNull = "Hello\0world this is a response with null bytes in it.";
    const result = classifySemanticIssue(withNull, defaultConfig);
    expect(result?.issue).toBe("garbled_response");
  });
});

describe("success-shaped failure detection", () => {
  it("detects error messages in response body", () => {
    const text = '{"error":{"message":"rate limit exceeded","detail":"provider returned a successful HTTP status but embedded an error","padding":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}}';
    const result = detectSuccessShapedFailure(text);
    expect(result?.issue).toBe("success_shaped_failure");
  });

  it("ignores very long error-like text", () => {
    const text = `{"error":"rate limit exceeded","padding":"${"x".repeat(1200)}"}`;
    const result = detectSuccessShapedFailure(text);
    expect(result).toBeNull();
  });

  it("does not flag normal refusal or apology content as provider failure", () => {
    const text = "I apologize, but I am unable to complete that request because it asks for private credentials.";
    const result = detectSuccessShapedFailure(text);
    expect(result).toBeNull();
  });

  it("does not flag normal helpful responses", () => {
    const text = "Here is the answer to your question. The function you need is called `processData` and it takes two arguments.";
    const result = detectSuccessShapedFailure(text);
    expect(result).toBeNull();
  });
});

describe("truncation detection", () => {
  it("detects finish_reason=length", () => {
    const result = detectTruncation("Some partial text here...", "length");
    expect(result?.issue).toBe("truncation");
  });

  it("detects unclosed thinking tags", () => {
    const result = detectTruncation("<think\nLet me reason about this...\nThe answer is");
    expect(result?.issue).toBe("truncation");
  });

  it("accepts complete responses", () => {
    const result = detectTruncation("Here is a complete sentence. And another one.");
    expect(result).toBeNull();
  });
});

describe("repetition detection", () => {
  it("detects repeated lines", () => {
    const text = "This is a repeated line that is quite long\nThis is a repeated line that is quite long\nThis is a repeated line that is quite long\nThis is a repeated line that is quite long\nThis is a repeated line that is quite long";
    const result = detectRepetition(text);
    expect(result?.issue).toBe("repetition_detected");
  });

  it("accepts varied text", () => {
    const text = "First point about the topic.\nSecond point about something else.\nThird point with different content.\nFourth unique point.\nFifth final point.";
    const result = detectRepetition(text);
    expect(result).toBeNull();
  });
});

describe("special token leak detection", () => {
  it("detects tokenizer special tokens", () => {
    const text = "Here is the answer <|eot_id|> and some more text";
    const result = detectSpecialTokenLeak(text);
    expect(result?.issue).toBe("special_token_leak");
  });

  it("detects chatml tokens", () => {
    const text = "Some response <|im_start|>user hello<|im_end|>";
    const result = detectSpecialTokenLeak(text);
    expect(result?.issue).toBe("special_token_leak");
  });

  it("accepts normal text", () => {
    const result = detectSpecialTokenLeak("Normal text without any special tokens.");
    expect(result).toBeNull();
  });
});

describe("rate limit classifier", () => {
  it("classifies NIM overload 429", () => {
    const result = classifyRateLimit(429, "model is overloaded, please try again", {});
    expect(result?.failureClass).toBe("rate_limit_overload");
  });

  it("classifies GLM code 1305 as overload", () => {
    const result = classifyRateLimit(429, '{"code":"1305","message":"overloaded"}', {});
    expect(result?.failureClass).toBe("rate_limit_overload");
    expect(result?.cooldownSeconds).toBe(10);
  });

  it("classifies concurrency 429", () => {
    const result = classifyRateLimit(429, "too many concurrent connections", {});
    expect(result?.failureClass).toBe("rate_limit_concurrency");
  });

  it("classifies quota 429", () => {
    const result = classifyRateLimit(429, "daily quota exceeded", {});
    expect(result?.failureClass).toBe("rate_limit_quota_window");
  });

  it("classifies ambiguous 429", () => {
    const result = classifyRateLimit(429, "slow down", {});
    expect(result?.failureClass).toBe("rate_limit_concurrency_ambiguous");
  });

  it("keeps bare too many requests ambiguous without a retry-after header", () => {
    const result = classifyRateLimit(429, "Error: too many requests", {});
    expect(result?.failureClass).toBe("rate_limit_concurrency_ambiguous");
    expect(result?.details).toContain("body_ambiguous_rate_limit_marker");
  });

  it("treats long retry-after as quota window", () => {
    const result = classifyRateLimit(429, "Error: too many requests", { "retry-after": "600" });
    expect(result?.failureClass).toBe("rate_limit_quota_window");
    expect(result?.cooldownSeconds).toBe(600);
  });

  it("treats short retry-after as concurrency", () => {
    const result = classifyRateLimit(429, "some generic rate error", { "Retry-After": "120" });
    expect(result?.failureClass).toBe("rate_limit_concurrency");
    expect(result?.cooldownSeconds).toBe(120);
  });

  it("classifies rate limit reached as quota window", () => {
    const result = classifyRateLimit(429, "rate limit reached for this account", {});
    expect(result?.failureClass).toBe("rate_limit_quota_window");
  });

  it("parses GLM reset timestamp in quota messages", () => {
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString().replace(".000", "");
    const result = classifyRateLimit(429, `Your quota will reset at ${future}. Try again later.`, {});
    expect(result?.failureClass).toBe("rate_limit_quota_window");
    expect(result?.cooldownSeconds).toBeGreaterThan(3500);
    expect(result?.cooldownSeconds).toBeLessThan(3700);
  });

  it("parses bare GLM reset timestamps as CST/UTC+8", () => {
    const cstFuture = new Date(Date.now() + 60 * 60 * 1000 + 8 * 60 * 60 * 1000)
      .toISOString()
      .replace(/\.\d{3}Z$/, "")
      .replace("T", " ");
    const result = classifyRateLimit(429, `Your quota will reset at ${cstFuture}. Try again later.`, {});
    expect(result?.failureClass).toBe("rate_limit_quota_window");
    expect(result?.cooldownSeconds).toBeGreaterThan(3500);
    expect(result?.cooldownSeconds).toBeLessThan(3700);
  });

  it("respects NVIDIA reset headers as quota windows", () => {
    const result = classifyRateLimit(429, "", { "x-ratelimit-reset-requests": "90" });
    expect(result?.failureClass).toBe("rate_limit_quota_window");
    expect(result?.cooldownSeconds).toBe(90);
    expect(result?.details).toContain("provider_reset_header");
  });

  it("returns null for non-429", () => {
    const result = classifyRateLimit(500, "internal error", {});
    expect(result).toBeNull();
  });
});

describe("provider failure classifier", () => {
  it("classifies 401 as auth failure", () => {
    const result = classifyProviderFailure(401, "unauthorized", "openai");
    expect(result.failureClass).toBe("auth_failure");
    expect(result.affectsAccount).toBe(true);
    expect(result.affectsHealth).toBe(false);
  });

  it("classifies 401 for subscription as oauth_session_failure", () => {
    const result = classifyProviderFailure(401, "token expired", "anthropic_subscription");
    expect(result.failureClass).toBe("oauth_session_failure");
  });

  it("classifies 500 as server_5xx", () => {
    const result = classifyProviderFailure(500, "internal server error", "nvidia_nim");
    expect(result.failureClass).toBe("server_5xx");
    expect(result.affectsHealth).toBe(true);
  });

  it("classifies context length exceeded", () => {
    const result = classifyProviderFailure(400, "maximum context length exceeded", "openai");
    expect(result.failureClass).toBe("context_length_exceeded");
  });

  it("does not classify invalid token 400 as context length", () => {
    const result = classifyProviderFailure(400, '{"error":"invalid token"}', "openai");
    expect(result.failureClass).toBe("client_4xx_bad_request");
  });
});
