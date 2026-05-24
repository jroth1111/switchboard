import { describe, it, expect } from "vitest";
import {
  validateChatRequest,
  validateBodySize,
  validateContentType,
} from "../../src/http/validation";

// ─── Chat request validation ──────────────────────────────────────

describe("Chat request validation", () => {
  it("accepts a valid minimal request", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.valid).toBe(true);
  });

  it("accepts a full request with tools and parameters", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [
        { role: "system", content: "You are helpful." },
        { role: "user", content: "hello" },
      ],
      tools: [{
        type: "function",
        function: { name: "get_weather", description: "Get weather", parameters: {} },
      }],
      temperature: 0.7,
      top_p: 0.9,
      max_tokens: 4096,
      stream: true,
    });
    expect(result.valid).toBe(true);
  });

  // Model validation
  it("rejects missing model", () => {
    const result = validateChatRequest({
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_model");
  });

  it("rejects non-string model", () => {
    const result = validateChatRequest({
      model: 123,
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_model");
  });

  it("rejects overly long model name", () => {
    const result = validateChatRequest({
      model: "a".repeat(257),
      messages: [{ role: "user", content: "hello" }],
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_model");
  });

  // Messages validation
  it("rejects missing messages", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_messages");
  });

  it("rejects empty messages", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [],
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_messages");
  });

  it("rejects message without role", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ content: "hello" }],
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_messages");
  });

  it("rejects null or non-object message entries", () => {
    for (const messages of [[null], [undefined], ["not-an-object"], [[]]]) {
      const result = validateChatRequest({
        model: "glm-5.1",
        messages,
      });
      expect(result.valid).toBe(false);
      expect(result.error?.code).toBe("invalid_messages");
    }
  });

  it("rejects unsupported message role", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "tool_call", content: "hello" }],
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_messages");
  });

  it("accepts all valid roles", () => {
    for (const role of ["system", "user", "assistant", "tool"]) {
      const result = validateChatRequest({
        model: "glm-5.1",
        messages: [{ role, content: "hello" }],
      });
      expect(result.valid).toBe(true);
    }
  });

  // Tools validation
  it("rejects non-array tools", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      tools: "not-an-array",
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_tools");
  });

  // Parameter validation
  it("rejects temperature out of range", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      temperature: 3.0,
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_parameter");
  });

  it("rejects negative temperature", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      temperature: -0.5,
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_parameter");
  });

  it("rejects top_p out of range", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      top_p: 1.5,
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_parameter");
  });

  it("rejects max_tokens out of range", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 0,
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_parameter");
  });

  it("accepts null optional parameters", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      temperature: null,
      top_p: null,
      max_tokens: null,
    });
    expect(result.valid).toBe(true);
  });

  // frequency_penalty / presence_penalty
  it("accepts valid frequency_penalty", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      frequency_penalty: 1.5,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects frequency_penalty out of range", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      frequency_penalty: 3.0,
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_parameter");
  });

  it("rejects presence_penalty out of range", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      presence_penalty: -3.0,
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_parameter");
  });

  // stream_options
  it("accepts valid stream_options", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      stream_options: { include_usage: true },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects non-object stream_options", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      stream_options: "yes",
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_parameter");
  });

  it("rejects non-boolean include_usage", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      stream_options: { include_usage: "yes" },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_parameter");
  });

  // tool_choice
  it("accepts string tool_choice values", () => {
    for (const tc of ["auto", "none", "required"]) {
      const result = validateChatRequest({
        model: "glm-5.1",
        messages: [{ role: "user", content: "hello" }],
        tool_choice: tc,
      });
      expect(result.valid).toBe(true);
    }
  });

  it("accepts object tool_choice", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      tool_choice: { type: "function", function: { name: "get_weather" } },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects invalid string tool_choice", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      tool_choice: "maybe",
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_parameter");
  });

  it("rejects object tool_choice without function type", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      tool_choice: { type: "other" },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_parameter");
  });

  // stop sequences
  it("accepts string stop", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      stop: "\n",
    });
    expect(result.valid).toBe(true);
  });

  it("accepts array stop sequences", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      stop: ["\n", "END"],
    });
    expect(result.valid).toBe(true);
  });

  it("rejects too many stop sequences", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      stop: ["a", "b", "c", "d", "e"],
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_parameter");
  });

  it("rejects non-string stop entries", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      stop: [123],
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_parameter");
  });

  // response_format
  it("accepts text response_format", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      response_format: { type: "text" },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts json_object response_format", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      response_format: { type: "json_object" },
    });
    expect(result.valid).toBe(true);
  });

  it("accepts json_schema response_format", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      response_format: { type: "json_schema", json_schema: { name: "test", schema: {} } },
    });
    expect(result.valid).toBe(true);
  });

  it("rejects json_schema without json_schema field", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      response_format: { type: "json_schema" },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_parameter");
  });

  it("rejects invalid response_format type", () => {
    const result = validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      response_format: { type: "xml" },
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_parameter");
  });
});

// ─── Body size validation ─────────────────────────────────────────

describe("Body size validation", () => {
  it("accepts null content length", () => {
    expect(validateBodySize(null).valid).toBe(true);
  });

  it("accepts reasonable body size", () => {
    expect(validateBodySize(1024).valid).toBe(true);
  });

  it("rejects oversized body", () => {
    const result = validateBodySize(20 * 1024 * 1024);
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("body_too_large");
  });
});

// ─── Content-Type validation ────────────────────────────────────────

describe("Content-Type validation", () => {
  function mockRequest(method: string, contentType: string | null): Request {
    const headers = new Headers();
    if (contentType !== null) headers.set("Content-Type", contentType);
    return new Request("https://example.com/v1/chat/completions", { method, headers });
  }

  it("accepts POST with application/json", () => {
    const result = validateContentType(mockRequest("POST", "application/json"));
    expect(result.valid).toBe(true);
  });

  it("accepts POST with application/json and charset", () => {
    const result = validateContentType(mockRequest("POST", "application/json; charset=utf-8"));
    expect(result.valid).toBe(true);
  });

  it("rejects POST without Content-Type", () => {
    const result = validateContentType(mockRequest("POST", null));
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("missing_content_type");
  });

  it("rejects POST with wrong Content-Type", () => {
    const result = validateContentType(mockRequest("POST", "text/plain"));
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_content_type");
  });

  it("rejects POST when application/json only appears in a parameter", () => {
    const result = validateContentType(mockRequest("POST", "text/plain; application/json"));
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_content_type");
  });

  it("rejects POST with application/json lookalike media types", () => {
    const result = validateContentType(mockRequest("POST", "application/jsonp"));
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_content_type");
  });

  it("accepts GET regardless of Content-Type", () => {
    const result = validateContentType(mockRequest("GET", null));
    expect(result.valid).toBe(true);
  });
});
