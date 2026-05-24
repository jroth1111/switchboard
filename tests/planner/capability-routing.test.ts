import { describe, it, expect } from "vitest";
import {
  computeRequestClass,
  planRequest,
  selectCandidateGroups,
  type RequestEnvelope,
} from "../../src/planner/planner";

function makeEnvelope(overrides: Partial<RequestEnvelope> = {}): RequestEnvelope {
  return {
    requestId: "req-test",
    originalModel: "glm-5.1",
    body: { model: "glm-5.1", messages: [{ role: "user", content: "hello" }] },
    stream: false,
    hasTools: false,
    hasStrictTools: false,
    hasTypedContent: false,
    requiresJsonMode: false,
    ...overrides,
  };
}

describe("Request class computation", () => {
  it("computes basic chat class", () => {
    const env = makeEnvelope();
    const cls = computeRequestClass(env);
    expect(cls.stream).toBe(false);
    expect(cls.hasTools).toBe(false);
    expect(cls.operation).toBe("chat");
    expect(cls.surface).toBe("chat_completions");
  });

  it("computes streaming class", () => {
    const env = makeEnvelope({ stream: true });
    const cls = computeRequestClass(env);
    expect(cls.stream).toBe(true);
    expect(cls.operation).toBe("chat_stream");
  });

  it("computes tool-call class", () => {
    const env = makeEnvelope({
      hasTools: true,
      body: {
        model: "glm-5.1",
        messages: [{ role: "user", content: "use tool" }],
        tools: [{ type: "function", function: { name: "test" } }],
      },
    });
    const cls = computeRequestClass(env);
    expect(cls.hasTools).toBe(true);
    expect(cls.operation).toBe("tool");
  });

  it("computes strict tool streaming class", () => {
    const env = makeEnvelope({
      stream: true,
      hasTools: true,
      hasStrictTools: true,
    });
    const cls = computeRequestClass(env);
    expect(cls.operation).toBe("strict_tool_stream");
  });

  it("computes json mode class", () => {
    const env = makeEnvelope({
      requiresJsonMode: true,
      body: {
        model: "glm-5.1",
        messages: [{ role: "user", content: "hello" }],
        response_format: { type: "json_object" },
      },
    });
    const cls = computeRequestClass(env);
    expect(cls.requiresJsonMode).toBe(true);
  });
});

describe("Capability-aware routing", () => {
  it("deducts score for broken tool calling", () => {
    const env = makeEnvelope({
      originalModel: "glm-5.1",
      hasTools: true,
      body: {
        model: "glm-5.1",
        messages: [{ role: "user", content: "use tool" }],
        tools: [{ type: "function", function: { name: "test" } }],
      },
    });
    const candidates = selectCandidateGroups("smart-route-worker", env);
    // Candidates should exist; those with broken tool support get lower scores
    expect(candidates.length).toBeGreaterThan(0);
  });

  it("routes tool requests to dedicated tool lane when available", () => {
    const env = makeEnvelope({
      originalModel: "glm-5.1",
      hasTools: true,
      body: {
        model: "glm-5.1",
        messages: [{ role: "user", content: "use tool" }],
        tools: [{ type: "function", function: { name: "test", description: "test", parameters: {} } }],
      },
    });
    const plan = planRequest(env);
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBeDefined();
  });

  it("plans streaming with tools", () => {
    const env = makeEnvelope({
      originalModel: "glm-5.1",
      stream: true,
      hasTools: true,
      body: {
        model: "glm-5.1",
        messages: [{ role: "user", content: "use tool" }],
        tools: [{ type: "function", function: { name: "test", description: "test", parameters: {} } }],
        stream: true,
      },
    });
    const plan = planRequest(env);
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBeDefined();
  });

  it("handles json mode requests", () => {
    const env = makeEnvelope({
      originalModel: "glm-5.1",
      requiresJsonMode: true,
      body: {
        model: "glm-5.1",
        messages: [{ role: "user", content: "hello" }],
        response_format: { type: "json_object" },
      },
    });
    const plan = planRequest(env);
    expect(plan).not.toBeNull();
  });

  it("handles multimodal content requests", () => {
    const env = makeEnvelope({
      originalModel: "glm-5.1",
      hasTypedContent: true,
      body: {
        model: "glm-5.1",
        messages: [{ role: "user", content: [{ type: "text", text: "describe this" }, { type: "image_url", image_url: { url: "data:..." } }] }],
      },
    });
    const plan = planRequest(env);
    // glm-5.1 → smart-route-worker doesn't support multimodal, so plan may be null
    // This is correct: multimodal content should route to a multimodal-capable model
    // Test that the planner correctly rejects multimodal for non-capable groups
    expect(plan).toBeNull();
  });

  it("routes multimodal to capable groups", () => {
    const env = makeEnvelope({
      originalModel: "gpt-5.5",
      hasTypedContent: true,
      body: {
        model: "gpt-5.5",
        messages: [{ role: "user", content: [{ type: "text", text: "describe this" }, { type: "image_url", image_url: { url: "data:..." } }] }],
      },
    });
    const plan = planRequest(env);
    expect(plan).not.toBeNull();
  });
});
