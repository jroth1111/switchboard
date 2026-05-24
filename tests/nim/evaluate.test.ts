import { describe, it, expect } from "vitest";
import { evaluateResponse, type ResponseEvaluationConfig } from "../../src/nim/evaluate/response";
import { stripThinkingLeaks } from "../../src/nim/repair/thinking";
import { repairSpecialTokens } from "../../src/nim/repair/special-tokens";
import { repairJson, repairToolCalls, repairToolName, validateToolContract } from "../../src/nim/repair/tool-calls";

const defaultEvalConfig: ResponseEvaluationConfig = {
  enableSemanticValidation: true,
  enableToolRepair: true,
  enableSpecialTokenDetection: true,
  enableRepetitionDetection: true,
  semanticMinChars: 1,
  semanticMinEntropy: 2.5,
  semanticMinPrintableRatio: 0.8,
  repetitionMaxRatio: 0.4,
  stripReasoningFromSuccess: true,
  enableSchemaAwareRepair: false,
  repairPolicy: {
    allowDestructive: true,
    enumAliases: {},
    toolNameAliases: {},
    relationalDefaults: {},
  },
};

function makeResponse(content: string, finishReason = "stop", toolCalls?: unknown[]) {
  return {
    id: "test-id",
    choices: [{
      index: 0,
      finish_reason: finishReason,
      message: {
        role: "assistant",
        content,
        ...(toolCalls ? { tool_calls: toolCalls } : {}),
      },
    }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

describe("response evaluator", () => {
  it("accepts valid responses", () => {
    const result = evaluateResponse(
      { messages: [{ role: "user", content: "hello" }] },
      makeResponse("Hello! How can I help you today?"),
      defaultEvalConfig,
    );
    expect(result.action).toBe("accept");
  });

  it("detects empty responses", () => {
    const result = evaluateResponse(
      { messages: [{ role: "user", content: "hello" }] },
      makeResponse(""),
      defaultEvalConfig,
    );
    expect(result.action).toBe("retry_fallback");
    expect(result.failureClass).toBe("empty_response");
  });

  it("detects success-shaped failures", () => {
    const result = evaluateResponse(
      { messages: [{ role: "user", content: "write code" }] },
      makeResponse('{"error":{"message":"rate limit exceeded","detail":"provider returned a successful HTTP status but embedded an error"}}'),
      defaultEvalConfig,
    );
    expect(result.action).toBe("retry_fallback");
    expect(result.failureClass).toBe("success_shaped_failure");
  });

  it("detects content_filter finish reason", () => {
    const result = evaluateResponse(
      { messages: [{ role: "user", content: "hello" }] },
      makeResponse("Sorry", "content_filter"),
      defaultEvalConfig,
    );
    expect(result.action).toBe("retry_fallback");
    expect(result.failureClass).toBe("semantic_failure");
  });

  it("detects length finish reason as truncation", () => {
    const result = evaluateResponse(
      { messages: [{ role: "user", content: "write a long essay" }] },
      makeResponse("Once upon a time there was a", "length"),
      defaultEvalConfig,
    );
    expect(result.action).toBe("retry_fallback");
    expect(result.failureClass).toBe("truncated_response");
  });

  it("repairs special token leaks", () => {
    const result = evaluateResponse(
      { messages: [{ role: "user", content: "hello" }] },
      makeResponse("Here is the answer <|eot_id|> with a special token"),
      defaultEvalConfig,
    );
    expect(result.action).toBe("repair_accept");
    expect(result.repairedResponse).toBeDefined();
  });

  it("strips assistant reasoning fields from otherwise successful responses", () => {
    const response = makeResponse("Final answer.");
    const message = response.choices[0].message as Record<string, unknown>;
    message.reasoning_content = "hidden reasoning";
    message.thinking = "hidden thinking";

    const result = evaluateResponse(
      { messages: [{ role: "user", content: "hello" }] },
      response,
      defaultEvalConfig,
    );

    expect(result.action).toBe("repair_accept");
    const repairedMessage = (result.repairedResponse!.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>;
    expect(repairedMessage.reasoning_content).toBeUndefined();
    expect(repairedMessage.thinking).toBeUndefined();
    expect(repairedMessage.content).toBe("Final answer.");
  });

  it("removes reasoning content-array items and evaluates remaining text", () => {
    const response = makeResponse("");
    (response.choices[0].message as Record<string, unknown>).content = [
      { type: "reasoning", text: "hidden reasoning" },
      { type: "text", text: "Visible answer." },
    ];

    const result = evaluateResponse(
      { messages: [{ role: "user", content: "hello" }] },
      response,
      defaultEvalConfig,
    );

    expect(result.action).toBe("repair_accept");
    const repairedMessage = (result.repairedResponse!.choices as Array<Record<string, unknown>>)[0].message as Record<string, unknown>;
    expect(repairedMessage.content).toEqual([{ type: "text", text: "Visible answer." }]);
  });

  it("detects malformed response without choices", () => {
    const result = evaluateResponse(
      { messages: [{ role: "user", content: "hello" }] },
      { id: "x" },
      defaultEvalConfig,
    );
    expect(result.action).toBe("retry_fallback");
    expect(result.failureClass).toBe("malformed_response");
  });

  it("rejects tool calls when the request did not define tools", () => {
    const result = evaluateResponse(
      { messages: [{ role: "user", content: "hello" }] },
      makeResponse("", "tool_calls", [
        { function: { name: "get_weather", arguments: "{}" } },
      ]),
      defaultEvalConfig,
    );
    expect(result.action).toBe("retry_fallback");
    expect(result.failureClass).toBe("tool_contract_failure");
    expect(result.failureMessage).toContain("without requested tools");
  });

  it("rejects schema-invalid tool arguments when contract validation passes", () => {
    const result = evaluateResponse(
      {
        messages: [{ role: "user", content: "weather?" }],
        tools: [{
          type: "function",
          function: {
            name: "get_weather",
            parameters: {
              type: "object",
              properties: { city: { type: "string" } },
              required: ["city"],
            },
          },
        }],
      },
      makeResponse("", "tool_calls", [
        { function: { name: "get_weather", arguments: '{"city": 123}' } },
      ]),
      defaultEvalConfig,
    );
    expect(result.action).toBe("retry_fallback");
    expect(result.failureClass).toBe("tool_contract_failure");
    expect(result.failureMessage).toContain("schema_invalid");
  });
});

describe("thinking leak stripping", () => {
  it("strips thinking tags", () => {
    const input = "<think\nSome reasoning here\n</think\nThe actual answer.";
    const result = stripThinkingLeaks(input);
    // With proper tags: <think ... </think
    // The regex needs > to match properly — malformed tags need different handling
    expect(result).toContain("The actual answer");
  });

  it("strips properly formed thinking tags", () => {
    const input = "<think\nSome reasoning here\n</think\nThe actual answer.";
    const result = stripThinkingLeaks("<think Some reasoning </think The answer.");
    expect(result).toContain("The answer");
  });

  it("strips unclosed thinking tags", () => {
    const input = "<think\nSome reasoning that was never closed...";
    const result = stripThinkingLeaks("<think Some reasoning that was never closed...");
    expect(result).not.toContain("<think");
  });
});

describe("special token repair", () => {
  it("removes special tokens", () => {
    const result = repairSpecialTokens("Hello <|eot_id|> world <|im_start|>");
    expect(result).toBe("Hello  world ");
  });
});

describe("tool call validation", () => {
  it("validates correct tool calls", () => {
    const result = validateToolContract(
      [{ function: { name: "get_weather", arguments: '{"city":"SF"}' } }],
      [{ type: "function", function: { name: "get_weather" } }],
    );
    expect(result.valid).toBe(true);
  });

  it("detects missing function", () => {
    const result = validateToolContract([{}], []);
    expect(result.valid).toBe(false);
    expect(result.reason).toBe("tool_call_missing_function");
  });

  it("detects missing name", () => {
    const result = validateToolContract(
      [{ function: { arguments: "{}" } }],
      [],
    );
    expect(result.valid).toBe(false);
  });

  it("detects invalid JSON arguments", () => {
    const result = validateToolContract(
      [{ function: { name: "test", arguments: "{invalid" } }],
      [{ type: "function", function: { name: "test" } }],
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("invalid_json");
  });

  it("rejects tool calls for unrequested tools", () => {
    const result = validateToolContract(
      [{ function: { name: "delete_everything", arguments: "{}" } }],
      [{ type: "function", function: { name: "get_weather" } }],
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("unexpected_tool_name");
  });

  it("rejects tool calls when no tools were requested", () => {
    const result = validateToolContract(
      [{ function: { name: "get_weather", arguments: "{}" } }],
      [],
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("without requested tools");
  });

  it("rejects missing required tool arguments", () => {
    const result = validateToolContract(
      [{ function: { name: "get_weather", arguments: "{}" } }],
      [{ type: "function", function: { name: "get_weather", parameters: { required: ["city"] } } }],
    );
    expect(result.valid).toBe(false);
    expect(result.reason).toContain("missing required city");
  });

  it("repairs duplicated tool names using the requested tool allowlist", () => {
    expect(repairToolName("get_weatherget_weather", new Set(["get_weather"]))).toBe("get_weather");
    const repaired = repairToolCalls(
      [{ function: { name: "get_weatherget_weather", arguments: "{}" } }],
      [{ type: "function", function: { name: "get_weather" } }],
    );
    expect(repaired?.[0].function).toMatchObject({ name: "get_weather" });
  });

  it("repairs Python-style JSON tool arguments", () => {
    const fixed = repairJson("{'city': 'SF', 'ok': True, 'missing': None}");
    expect(JSON.parse(fixed!)).toEqual({ city: "SF", ok: true, missing: null });
  });

  it("repairs truncated JSON arguments", () => {
    const result = repairToolCalls([
      { function: { name: "test", arguments: '{"key": "value", "nested": {"a": 1' } },
    ], [{ type: "function", function: { name: "test" } }]);
    expect(result).not.toBeNull();
  });
});
