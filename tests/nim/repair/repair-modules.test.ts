import { describe, it, expect } from "vitest";
import { stripThinkingLeaks, stripResponseReasoningFields } from "../../../src/nim/repair/thinking";
import { repairRepetition } from "../../../src/nim/repair/repetition";
import { repairSpecialTokens } from "../../../src/nim/repair/special-tokens";
import { isDestructiveToolName } from "../../../src/nim/repair/aliases";
import {
  hasHiddenOnlyTypedContent,
  hasTypedContentNormalization,
  normalizeTypedContentParts,
  typedContentPartAction,
} from "../../../src/nim/repair/content-parts";

// ─── stripThinkingLeaks ──────────────────────────────────────────────

describe("stripThinkingLeaks", () => {
  it("removes matched <think/> tags", () => {
    expect(stripThinkingLeaks("Hello <think attr>internal reasoning</think > world")).toBe("Hello  world");
  });

  it("removes matched <thinking> tags with content", () => {
    expect(stripThinkingLeaks("Let me think<thinking>step 1\nstep 2</thinking>Done")).toBe("Let me thinkDone");
  });

  it("removes <scratchpad> tags", () => {
    expect(stripThinkingLeaks("Answer<scratchpad>draft</scratchpad>")).toBe("Answer");
  });

  it("removes <reasoning> tags", () => {
    expect(stripThinkingLeaks("Hi<reasoning>logic here</reasoning> there")).toBe("Hi there");
  });

  it("removes unclosed thinking tag when no close tag exists", () => {
    const result = stripThinkingLeaks("Hello <think this is my thought");
    expect(result).not.toContain("<think");
  });

  it("preserves text without thinking tags", () => {
    expect(stripThinkingLeaks("Hello world")).toBe("Hello world");
  });

  it("handles multiple thinking blocks", () => {
    const input = "Start<think#a</think<middle><thinking>b</thinking>End";
    const result = stripThinkingLeaks(input);
    expect(result).not.toContain("think");
    expect(result).toContain("Start");
    expect(result).toContain("End");
  });

  it("handles <cot> chain of thought tags", () => {
    expect(stripThinkingLeaks("Result<cot>reasoning steps</cot>")).toBe("Result");
  });

  it("strips <inner_monologue> tags", () => {
    expect(stripThinkingLeaks("Reply<inner_monologue>hmm</inner_monologue>")).toBe("Reply");
  });
});

// ─── stripResponseReasoningFields ────────────────────────────────────

describe("stripResponseReasoningFields", () => {
  it("removes reasoning field from message", () => {
    const msg = { role: "assistant", content: "Hi", reasoning: "my thoughts" };
    const { message, changed } = stripResponseReasoningFields(msg);
    expect(changed).toBe(true);
    expect(message.reasoning).toBeUndefined();
    expect(message.content).toBe("Hi");
  });

  it("removes reasoning_content field", () => {
    const msg = { role: "assistant", content: "Hi", reasoning_content: "thoughts" };
    const { changed } = stripResponseReasoningFields(msg);
    expect(changed).toBe(true);
  });

  it("removes thinking field", () => {
    const msg = { role: "assistant", content: "Hi", thinking: "deep thoughts" };
    const { changed } = stripResponseReasoningFields(msg);
    expect(changed).toBe(true);
  });

  it("does not modify message without reasoning fields", () => {
    const msg = { role: "assistant", content: "Hi" };
    const { changed } = stripResponseReasoningFields(msg);
    expect(changed).toBe(false);
  });

  it("filters reasoning-type content blocks from array content", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "reasoning", text: "hmm" },
        { type: "text", text: "answer" },
      ],
    };
    const { message, changed } = stripResponseReasoningFields(msg);
    expect(changed).toBe(true);
    const content = message.content as Array<Record<string, string>>;
    expect(content).toHaveLength(1);
    expect(content[0].type).toBe("text");
  });

  it("filters thinking-type content blocks", () => {
    const msg = {
      role: "assistant",
      content: [
        { type: "thinking", text: "pondering" },
        { type: "text", text: "result" },
      ],
    };
    const { message, changed } = stripResponseReasoningFields(msg);
    expect(changed).toBe(true);
    const content = message.content as Array<Record<string, string>>;
    expect(content).toHaveLength(1);
  });
});

// ─── repairRepetition ────────────────────────────────────────────────

describe("repairRepetition", () => {
  it("returns null for text under 3 lines", () => {
    expect(repairRepetition("line1\nline2")).toBeNull();
  });

  it("returns null for text with no repetition", () => {
    expect(repairRepetition("line1\nline2\nline3")).toBeNull();
  });

  it("removes lines repeated more than twice consecutively", () => {
    const input = "hello\nhello\nhello\nhello\nworld";
    const result = repairRepetition(input);
    expect(result).not.toBeNull();
    const lines = result!.split("\n");
    // Should keep at most 2 consecutive "hello" lines
    const helloCount = lines.filter((l) => l.trim() === "hello").length;
    expect(helloCount).toBeLessThanOrEqual(2);
  });

  it("is case-insensitive for repetition detection", () => {
    const input = "Hello\nhello\nHELLO\nhello\nworld";
    const result = repairRepetition(input);
    expect(result).not.toBeNull();
    const lines = result!.split("\n");
    const helloCount = lines.filter((l) => l.trim().toLowerCase() === "hello").length;
    expect(helloCount).toBeLessThanOrEqual(2);
  });

  it("preserves non-consecutive repeated lines", () => {
    const input = "hello\nworld\nhello\nworld\nhello";
    // No consecutive repetition, should return null
    expect(repairRepetition(input)).toBeNull();
  });
});

// ─── repairSpecialTokens ─────────────────────────────────────────────

describe("repairSpecialTokens", () => {
  it("removes <|special|> tokens", () => {
    expect(repairSpecialTokens("Hello <|im_start|> world")).toBe("Hello  world");
  });

  it("removes <|im_end|> tokens", () => {
    expect(repairSpecialTokens("text<|im_end|>more")).toBe("textmore");
  });

  it("removes <s> and </s> tokens", () => {
    expect(repairSpecialTokens("<s>Hello</s>")).toBe("Hello");
  });

  it("removes [INST] tokens", () => {
    expect(repairSpecialTokens("[INST]prompt[/INST]")).toBe("prompt");
  });

  it("removes <|begin_of_text|>", () => {
    expect(repairSpecialTokens("<|begin_of_text|>Hello")).toBe("Hello");
  });

  it("removes DeepSeek tokens", () => {
    expect(repairSpecialTokens("<｜begin▁of▁sentence｜>Hi")).toBe("Hi");
  });

  it("removes <|end_of_text|>", () => {
    expect(repairSpecialTokens("Hello<|end_of_text|>")).toBe("Hello");
  });

  it("handles text with no special tokens", () => {
    expect(repairSpecialTokens("clean text")).toBe("clean text");
  });

  it("handles multiple special tokens in one string", () => {
    const input = "<s><|im_start|>user\nHello<|im_end|><|end_of_text|>";
    const result = repairSpecialTokens(input);
    expect(result).toBe("user\nHello");
  });
});

// ─── isDestructiveToolName ───────────────────────────────────────────

describe("isDestructiveToolName", () => {
  it("identifies write as destructive", () => {
    expect(isDestructiveToolName("write_file")).toBe(true);
  });

  it("identifies delete as destructive", () => {
    expect(isDestructiveToolName("delete_record")).toBe(true);
  });

  it("identifies update as destructive", () => {
    expect(isDestructiveToolName("update_user")).toBe(true);
  });

  it("identifies create as destructive", () => {
    expect(isDestructiveToolName("create_item")).toBe(true);
  });

  it("identifies remove as destructive", () => {
    expect(isDestructiveToolName("remove_item")).toBe(true);
  });

  it("identifies drop as destructive", () => {
    expect(isDestructiveToolName("drop_table")).toBe(true);
  });

  it("does not flag read-only tool names", () => {
    expect(isDestructiveToolName("get_weather")).toBe(false);
    expect(isDestructiveToolName("search")).toBe(false);
    expect(isDestructiveToolName("read_file")).toBe(false);
    expect(isDestructiveToolName("list_items")).toBe(false);
  });

  it("is case-insensitive", () => {
    expect(isDestructiveToolName("WRITE_FILE")).toBe(true);
    expect(isDestructiveToolName("Delete_User")).toBe(true);
  });
});

// ─── typed content part normalization ─────────────────────────────

describe("typed content part normalization", () => {
  it("normalizes visible typed text and strips hidden reasoning and metadata", () => {
    const body = {
      messages: [{
        role: "user",
        content: [
          { type: "input_text", text: "visible" },
          { type: "thinking", text: "secret" },
          { type: "metadata_marker", id: "m1" },
          { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
        ],
      }],
    };

    expect(hasTypedContentNormalization(body)).toBe(true);
    const receipts = normalizeTypedContentParts(body);

    expect(receipts).toEqual([
      { messageIndex: 0, partIndex: 0, partType: "input_text", action: "normalize_visible_text" },
      { messageIndex: 0, partIndex: 1, partType: "thinking", action: "strip_hidden_reasoning" },
      { messageIndex: 0, partIndex: 2, partType: "metadata_marker", action: "strip_metadata" },
    ]);
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "visible" },
      { type: "image_url", image_url: { url: "data:image/png;base64,abc" } },
    ]);
  });

  it("uses output_text as visible text fallback", () => {
    const body = {
      messages: [{ role: "assistant", content: [{ type: "output_text", output_text: "answer" }] }],
    };

    normalizeTypedContentParts(body);
    expect(body.messages[0].content).toEqual([{ type: "text", text: "answer" }]);
  });

  it("detects hidden-only typed content before stripping it to an empty request", () => {
    expect(hasHiddenOnlyTypedContent({
      messages: [{ role: "user", content: [{ type: "reasoning", text: "internal" }] }],
    })).toBe(true);
    expect(hasHiddenOnlyTypedContent({
      messages: [{ role: "user", content: [{ type: "reasoning", text: "internal" }, { type: "text", text: "visible" }] }],
    })).toBe(false);
  });

  it("leaves unknown typed parts to preflight instead of rewriting them", () => {
    expect(typedContentPartAction({ type: "unknown_part", value: 1 })).toBe("unknown");
    const body = {
      messages: [{ role: "user", content: [{ type: "unknown_part", value: 1 }] }],
    };
    expect(normalizeTypedContentParts(body)).toEqual([]);
    expect(body.messages[0].content).toEqual([{ type: "unknown_part", value: 1 }]);
  });
});
