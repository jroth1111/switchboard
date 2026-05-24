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
    requiresReasoning: false,
    isMultiTool: false,
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

  it("keeps multi-tool and reasoning flags in request class receipts", () => {
    const env = makeEnvelope({
      hasTools: true,
      isMultiTool: true,
      requiresReasoning: true,
      body: {
        model: "glm-5.1",
        messages: [{ role: "user", content: "use tools and reason" }],
        tools: [
          { type: "function", function: { name: "one" } },
          { type: "function", function: { name: "two" } },
        ],
        reasoning_effort: "high",
      },
    });

    const cls = computeRequestClass(env);

    expect(cls.isMultiTool).toBe(true);
    expect(cls.requiresReasoning).toBe(true);
  });
});

describe("Capability-aware routing", () => {
  it("routes tool requests through the dedicated tool lane before general fallbacks", () => {
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
    expect(candidates[0].group).toBe("nim-tool-primary");
    expect(candidates[0].score).toBe(100);

    const plan = planRequest(env);
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBe("nim-tool-primary");
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
    expect(plan!.selectedGroup).toBe("nim-tool-primary");
    expect(plan!.routeDecision.candidates[0]).toMatchObject({
      group: "nim-tool-primary",
      viable: true,
    });
  });

  it("keeps streaming tool requests off the non-streaming dedicated tool lane", () => {
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
    expect(plan!.selectedGroup).toBe("smart-route-worker");
    expect(plan!.routeDecision.candidates.find((candidate) => candidate.group === "nim-tool-primary")).toMatchObject({
      viable: false,
      rejectionReason: "operation tool_stream not supported",
    });
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

  it("routes direct NIM json-mode requests away from deployments with broken json mode", () => {
    const env = makeEnvelope({
      originalModel: "nim-primary",
      requiresJsonMode: true,
      body: {
        model: "nim-primary",
        messages: [{ role: "user", content: "json please" }],
        response_format: { type: "json_object" },
      },
    });

    const plan = planRequest(env);

    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBe("zai-glm-5.1-terminal-fallback");
    expect(plan!.selectedDeployments.every((deployment) => deployment.capabilities.jsonMode !== "broken")).toBe(true);
    expect(plan!.routeDecision.candidates.find((candidate) => candidate.group === "nim-primary")).toMatchObject({
      viable: false,
      rejectionReason: "json mode not supported",
      deploymentCount: 0,
    });
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

  it("can produce deterministic plans when the caller injects the timestamp", () => {
    const env = makeEnvelope();

    const first = planRequest(env, 1234567890);
    const second = planRequest(env, 1234567890);

    expect(first).toEqual(second);
    expect(first!.receipt.timestamp).toBe(1234567890);
  });
});
