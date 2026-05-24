import { describe, it, expect } from "vitest";
import {
  selectCandidateGroups,
  planRequest,
} from "../../src/planner/planner";

function makeEnvelope(overrides: Record<string, unknown> = {}) {
  return {
    requestId: "test",
    originalModel: "glm-5.1",
    body: { model: "glm-5.1", messages: [{ role: "user", content: "hi" }] },
    stream: false,
    hasTools: false,
    hasStrictTools: false,
    hasTypedContent: false,
    requiresJsonMode: false,
    requiresReasoning: false,
    ...overrides,
  };
}

describe("Hard capability: strict tools rejection", () => {
  it("rejects strict tools for deployments with best_effort tool calling", () => {
    // nim-primary has toolCalling: "best_effort" — strict tools require "native"
    const candidates = selectCandidateGroups(
      "nim-primary",
      makeEnvelope({
        hasTools: true,
        hasStrictTools: true,
        body: {
          model: "nim-primary",
          messages: [{ role: "user", content: "use the tool" }],
          tools: [{ type: "function", function: { name: "test" } }],
          tool_choice: "required",
        },
      }),
    );
    const nimPrimary = candidates.find((c) => c.group === "nim-primary");
    expect(nimPrimary?.rejectionReason).toBe("non_native_strict_tools");
  });

  it("does not reject non-strict tool requests with best_effort tool calling", () => {
    const candidates = selectCandidateGroups(
      "nim-primary",
      makeEnvelope({
        hasTools: true,
        hasStrictTools: false,
        body: {
          model: "nim-primary",
          messages: [{ role: "user", content: "use the tool" }],
          tools: [{ type: "function", function: { name: "test" } }],
        },
      }),
    );
    const nimPrimary = candidates.find((c) => c.group === "nim-primary");
    expect(nimPrimary?.rejectionReason).not.toBe("non_native_strict_tools");
  });

  it("allows strict tools for deployments with native tool calling", () => {
    // nim-tool-primary has toolCalling: "native"
    const candidates = selectCandidateGroups(
      "nim-tool-primary",
      makeEnvelope({
        hasTools: true,
        hasStrictTools: true,
        body: {
          model: "nim-tool-primary",
          messages: [{ role: "user", content: "use the tool" }],
          tools: [{ type: "function", function: { name: "test" } }],
          tool_choice: "required",
        },
      }),
    );
    const toolPrimary = candidates.find((c) => c.group === "nim-tool-primary");
    expect(toolPrimary?.rejectionReason).not.toBe("non_native_strict_tools");
  });
});

describe("Hard capability: reasoning rejection", () => {
  it("allows reasoning for deployments with native reasoning", () => {
    // All current manifest deployments have reasoning: "native"
    const candidates = selectCandidateGroups(
      "nim-primary",
      makeEnvelope({ requiresReasoning: true }),
    );
    const nimPrimary = candidates.find((c) => c.group === "nim-primary");
    // Should NOT be rejected since nim-primary has reasoning: "native"
    expect(nimPrimary?.rejectionReason).not.toBe("unsupported_reasoning");
  });

  it("requiresReasoning field propagates through envelope", () => {
    // Verify that setting requiresReasoning: true on the envelope is accepted
    // by planRequest without crashing
    const plan = planRequest(
      makeEnvelope({
        requiresReasoning: true,
        body: {
          model: "glm-5.1",
          messages: [{ role: "user", content: "think step by step" }],
          reasoning_effort: "high",
        },
      }),
    );
    // All deployments have native reasoning, so plan should succeed
    expect(plan).not.toBeNull();
  });
});
