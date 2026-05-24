import { describe, it, expect } from "vitest";
import {
  planRequest,
  applyTransforms,
  computeRequestClass,
  selectCandidateGroups,
} from "../../src/planner/planner";

describe("Request transforms", () => {
  it("clamps max_tokens to policy ceiling", () => {
    const plan = planRequest({
      requestId: "test",
      originalModel: "nim-primary",
      body: { model: "nim-primary", messages: [{ role: "user", content: "hi" }], max_tokens: 50000 },
      stream: false, hasTools: false, hasStrictTools: false, hasTypedContent: false, requiresJsonMode: false,
    });
    expect(plan).not.toBeNull();
    const clamped = plan!.transforms.find((t) => t.type === "clamp_max_tokens");
    expect(clamped).toBeDefined();
    expect(clamped!.value).toBe(32000);
  });

  it("strips unsupported params", () => {
    const result = applyTransforms(
      { model: "test", logprobs: true, top_logprobs: 5, messages: [] },
      [{ type: "strip_param", param: "logprobs" }, { type: "strip_param", param: "top_logprobs" }],
    );
    expect(result).not.toHaveProperty("logprobs");
    expect(result).not.toHaveProperty("top_logprobs");
  });

  it("applies clamp_max_tokens transform", () => {
    const result = applyTransforms(
      { model: "test", max_tokens: 50000, messages: [] },
      [{ type: "clamp_max_tokens", param: "max_tokens", value: 32000 }],
    );
    expect(result.max_tokens).toBe(32000);
  });

  it("applies raise_min_tokens transform", () => {
    const result = applyTransforms(
      { model: "test", max_tokens: 10, messages: [] },
      [{ type: "raise_min_tokens", param: "max_tokens", value: 512 }],
    );
    expect(result.max_tokens).toBe(512);
  });

  it("strips reasoning from extra_body", () => {
    const result = applyTransforms(
      { model: "test", extra_body: { reasoning_effort: "high", reasoning: true }, messages: [] },
      [{ type: "strip_reasoning", param: "__reasoning__" }],
    );
    expect(result.extra_body).not.toHaveProperty("reasoning_effort");
    expect(result.extra_body).not.toHaveProperty("reasoning");
  });

  it("strips user message reasoning blocks", () => {
    const result = applyTransforms(
      {
        model: "test",
        messages: [
          { role: "user", content: "Hello <think reasoning>secret thoughts</think > actual question" },
          { role: "assistant", content: "Hi" },
        ],
      },
      [{ type: "strip_user_reasoning", param: "user_reasoning" }],
    );
    const userMsg = (result.messages as Array<{ content: string }>)[0];
    expect(userMsg.content).not.toContain("secret thoughts");
    expect(userMsg.content).toContain("actual question");
  });

  it("adds and applies typed content normalization", () => {
    const body = {
      model: "nim-primary",
      messages: [{
        role: "user",
        content: [
          { type: "input_text", text: "visible" },
          { type: "thinking", text: "secret" },
          { type: "metadata_marker", id: "m1" },
        ],
      }],
    };
    const plan = planRequest({
      requestId: "test",
      originalModel: "nim-primary",
      body,
      stream: false, hasTools: false, hasStrictTools: false, hasTypedContent: false, requiresJsonMode: false,
    });

    expect(plan?.transforms.some((t) => t.type === "normalize_typed_content_parts")).toBe(true);
    const result = applyTransforms(body, plan!.transforms);
    const message = (result.messages as Array<Record<string, unknown>>)[0];
    expect(message.content).toEqual([{ type: "text", text: "visible" }]);
  });
});

describe("Content class detection", () => {
  it("rejects multimodal for text-only groups", () => {
    const candidates = selectCandidateGroups("nim-primary", {
      requestId: "test",
      originalModel: "nim-primary",
      body: {
        model: "nim-primary",
        messages: [{ role: "user", content: [{ type: "text", text: "describe" }, { type: "image_url", image_url: { url: "data:..." } }] }],
      },
      stream: false, hasTools: false, hasStrictTools: false, hasTypedContent: true, requiresJsonMode: false,
    });
    // nim-primary is rejected due to multimodal content class
    const nimPrimary = candidates.find((c) => c.group === "nim-primary");
    expect(nimPrimary?.rejectionReason).toContain("content class");
    // Hidden fallback zai-glm-5.1-terminal-fallback bypasses content class check
    // so the planner still produces a plan via the hidden terminal fallback
  });

  it("classifies input_image typed parts as multimodal", () => {
    const candidates = selectCandidateGroups("nim-primary", {
      requestId: "test",
      originalModel: "nim-primary",
      body: {
        model: "nim-primary",
        messages: [{ role: "user", content: [{ type: "input_image", image_url: { url: "data:..." } }] }],
      },
      stream: false, hasTools: false, hasStrictTools: false, hasTypedContent: true, requiresJsonMode: false,
    });

    const nimPrimary = candidates.find((c) => c.group === "nim-primary");
    expect(nimPrimary?.rejectionReason).toContain("content class");
  });

  it("allows multimodal for chatgpt responses", () => {
    const plan = planRequest({
      requestId: "test",
      originalModel: "gpt-5.5",
      body: {
        model: "gpt-5.5",
        messages: [{ role: "user", content: [{ type: "text", text: "describe" }, { type: "image_url", image_url: { url: "data:..." } }] }],
      },
      stream: false, hasTools: false, hasStrictTools: false, hasTypedContent: true, requiresJsonMode: false,
    });
    expect(plan).not.toBeNull();
  });
});

describe("Context window validation", () => {
  it("rejects requests exceeding deployment context window", () => {
    const plan = planRequest({
      requestId: "test",
      originalModel: "nim-primary",
      body: {
        model: "nim-primary",
        messages: [{ role: "user", content: "hi" }],
        max_tokens: 999999, // way over 128k context
      },
      stream: false, hasTools: false, hasStrictTools: false, hasTypedContent: false, requiresJsonMode: false,
    });
    expect(plan).toBeNull();
  });
});

describe("strip_response_format transform", () => {
  it("strips response_format via applyTransforms", () => {
    const result = applyTransforms(
      { model: "test", response_format: { type: "json_object" }, messages: [] },
      [{ type: "strip_response_format", param: "response_format" }],
    );
    expect(result).not.toHaveProperty("response_format");
  });

  it("does not strip response_format when not in transform list", () => {
    const result = applyTransforms(
      { model: "test", response_format: { type: "json_object" }, messages: [] },
      [],
    );
    expect(result).toHaveProperty("response_format");
  });
});
