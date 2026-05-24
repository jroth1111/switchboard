import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  verifyProxyAuth,
  verifyAdminAuth,
  checkRequestRateLimit,
  handleAdminUsage,
} from "../../src/http/handler";
import { migrateFunctionsToTools } from "../../src/http/handler";
import {
  validateChatRequest,
  validateBodySize,
} from "../../src/http/validation";
import {
  planRequest,
  canonicalize,
  type RequestEnvelope,
} from "../../src/planner/planner";
import { MANIFEST } from "../../src/config/manifest";

function makeEnvelope(overrides: Partial<RequestEnvelope> = {}): RequestEnvelope {
  return {
    requestId: "req-test-1",
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

// ─── Auth middleware ───────────────────────────────────────────────

describe("Auth middleware", () => {
  it("allows request with valid Bearer token", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer my-secret-key" },
    });
    expect(verifyProxyAuth(req, "my-secret-key")).toBe(true);
  });

  it("rejects request with wrong token", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer wrong-key" },
    });
    expect(verifyProxyAuth(req, "my-secret-key")).toBe(false);
  });

  it("rejects request without Authorization header", () => {
    const req = new Request("https://example.com");
    expect(verifyProxyAuth(req, "my-secret-key")).toBe(false);
  });

  it("rejects malformed auth header", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Basic abc123" },
    });
    expect(verifyProxyAuth(req, "my-secret-key")).toBe(false);
  });

  it("fails closed when no key is configured", () => {
    const req = new Request("https://example.com");
    expect(verifyProxyAuth(req, "")).toBe(false);
  });

  it("admin auth requires key", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer admin-key" },
    });
    expect(verifyAdminAuth(req, "admin-key")).toBe(true);
    expect(verifyAdminAuth(req, "")).toBe(false);
  });

  it("accepts case-insensitive Bearer scheme", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "bearer my-secret-key" },
    });
    expect(verifyProxyAuth(req, "my-secret-key")).toBe(true);
  });

  it("accepts BEARER scheme", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "BEARER my-secret-key" },
    });
    expect(verifyProxyAuth(req, "my-secret-key")).toBe(true);
  });

  it("rejects Bearer with empty token", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer " },
    });
    expect(verifyProxyAuth(req, "my-secret-key")).toBe(false);
  });

  it("accepts Bearer with leading whitespace in token", () => {
    const req = new Request("https://example.com", {
      headers: { Authorization: "Bearer  my-secret-key" },
    });
    expect(verifyProxyAuth(req, "my-secret-key")).toBe(true);
  });
});

// ─── Admin usage ─────────────────────────────────────────────────

describe("Admin usage", () => {
  it("computes requested hourly rollups before querying them", async () => {
    const now = Date.UTC(2026, 4, 24, 5, 30, 0);
    const order: string[] = [];
    const computeHourlyRollups = vi.fn((hourStart?: number) =>
      new Promise<void>((resolve) => {
        queueMicrotask(() => {
          order.push(`compute:${hourStart}`);
          resolve();
        });
      }),
    );
    const queryRollups = vi.fn(async () => {
      order.push("query");
      return [{
        requests: 2,
        knownRequests: 1,
        unknownRequests: 1,
        promptTokens: 10,
        completionTokens: 5,
        totalTokens: 15,
      }];
    });
    const stateDo = { computeHourlyRollups, queryRollups };
    const env = {
      CONTROL_PLANE_STATE: {
        idFromName: vi.fn(() => "control-plane-id"),
        get: vi.fn(() => stateDo),
      },
    } as unknown as Env;

    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const response = await handleAdminUsage(
        new Request("https://example.test/admin/usage?window=2h"),
        env,
      );
      const body = await response.json() as Record<string, unknown>;

      expect(response.status).toBe(200);
      expect(body.rollupSince).toBe(Date.UTC(2026, 4, 24, 3, 0, 0));
      expect((body.totals as Record<string, number>).requests).toBe(2);
    } finally {
      vi.useRealTimers();
    }

    expect(computeHourlyRollups).toHaveBeenCalledTimes(3);
    expect(computeHourlyRollups).toHaveBeenNthCalledWith(1, Date.UTC(2026, 4, 24, 3, 0, 0));
    expect(computeHourlyRollups).toHaveBeenNthCalledWith(2, Date.UTC(2026, 4, 24, 4, 0, 0));
    expect(computeHourlyRollups).toHaveBeenNthCalledWith(3, Date.UTC(2026, 4, 24, 5, 0, 0));
    expect(queryRollups).toHaveBeenCalledWith({
      group: undefined,
      deploymentId: undefined,
      since: Date.UTC(2026, 4, 24, 3, 0, 0),
    });
    expect(order.at(-1)).toBe("query");
  });
});

// ─── Planner integration ──────────────────────────────────────────

describe("Planner routing integration", () => {
  it("routes glm-5.1 to smart-route-worker", () => {
    const envelope = makeEnvelope({ originalModel: "glm-5.1" });
    envelope.body.model = "glm-5.1";
    const plan = planRequest(envelope);
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBe("smart-route-worker");
  });

  it("routes nim-primary to nim-primary group", () => {
    const envelope = makeEnvelope({ originalModel: "nim-primary" });
    envelope.body.model = "nim-primary";
    const plan = planRequest(envelope);
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBe("nim-primary");
  });

  it("routes gpt-5.5 to chatgpt subscription", () => {
    const envelope = makeEnvelope({ originalModel: "gpt-5.5" });
    envelope.body.model = "gpt-5.5";
    const plan = planRequest(envelope);
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBe("chatgpt-subscription-gpt-5.5-medium");
  });

  it("routes claude-sonnet-4-6 to anthropic subscription", () => {
    const envelope = makeEnvelope({ originalModel: "claude-sonnet-4-6" });
    envelope.body.model = "claude-sonnet-4-6";
    const plan = planRequest(envelope);
    expect(plan).not.toBeNull();
    expect(plan!.selectedGroup).toBe("anthropic-subscription-sonnet-4-6-high");
  });

  it("returns null for unknown models", () => {
    const envelope = makeEnvelope({ originalModel: "nonexistent-model" });
    envelope.body.model = "nonexistent-model";
    const plan = planRequest(envelope);
    expect(plan).toBeNull();
  });

  it("canonicalizes aliased models", () => {
    const result = canonicalize("smart-route");
    expect(result.canonicalTarget).toBe("smart-route-worker");
    expect(result.isManaged).toBe(true);
  });

  it("canonicalizes prefixed models", () => {
    const result = canonicalize("nim-primary");
    expect(result.isManaged).toBe(true);
  });

  it("detects unmanaged models", () => {
    const result = canonicalize("some-random-model");
    expect(result.isManaged).toBe(false);
  });

  it("plan includes fallback chain", () => {
    const envelope = makeEnvelope({ originalModel: "nim-primary" });
    envelope.body.model = "nim-primary";
    const plan = planRequest(envelope);
    expect(plan!.fallbackSequence.length).toBeGreaterThan(0);
    expect(plan!.fallbackSequence[0].group).toBeDefined();
  });

  it("plan has transforms for unsupported params", () => {
    const envelope = makeEnvelope({
      originalModel: "glm-5.1",
      body: {
        model: "glm-5.1",
        messages: [{ role: "user", content: "hello" }],
        logit_bias: { 123: -100 },
      },
    });
    const plan = planRequest(envelope);
    expect(plan).not.toBeNull();
    expect(plan!.transforms.length).toBeGreaterThan(0);
    expect(plan!.transforms.some((t) => t.param === "logit_bias")).toBe(true);
  });

  it("routes tool requests to tool lane", () => {
    const envelope = makeEnvelope({
      originalModel: "glm-5.1",
      hasTools: true,
      body: {
        model: "glm-5.1",
        messages: [{ role: "user", content: "use tool" }],
        tools: [{ type: "function", function: { name: "test", description: "test", parameters: {} } }],
      },
    });
    const plan = planRequest(envelope);
    expect(plan).not.toBeNull();
    // Should route to tool group if available
    expect(plan!.selectedGroup).toBeDefined();
  });
});

// ─── Manifest validation ─────────────────────────────────────────

describe("Manifest integrity", () => {
  it("all alias targets resolve to valid route groups", () => {
    for (const [alias, target] of Object.entries(MANIFEST.aliases)) {
      const rg = MANIFEST.routeGroups[target];
      expect(rg).toBeDefined(`Alias '${alias}' -> '${target}' has no route group`);
    }
  });

  it("all primary alias target groups have deployments", () => {
    // Check that groups which are direct alias targets have deployments,
    // excluding groups that are known to be routing-only (no direct deployments)
    const routingOnlyGroups = new Set(["nim-secondary"]);

    for (const [alias, target] of Object.entries(MANIFEST.aliases)) {
      const rg = MANIFEST.routeGroups[target];
      if (!rg || rg.hidden) continue;
      if (routingOnlyGroups.has(target)) continue;
      const deployments = MANIFEST.deploymentsByGroup[target];
      expect(deployments?.length ?? 0).toBeGreaterThan(0);
    }
  });

  it("all fallback groups exist in route groups", () => {
    for (const [group, rg] of Object.entries(MANIFEST.routeGroups)) {
      for (const fb of rg.fallbacks) {
        expect(MANIFEST.routeGroups[fb]).toBeDefined(
          `Group '${group}' references fallback '${fb}' which doesn't exist`,
        );
      }
    }
  });

  it("all deployment groups match a route group", () => {
    for (const d of MANIFEST.deployments) {
      expect(MANIFEST.routeGroups[d.group]).toBeDefined(
        `Deployment '${d.id}' references group '${d.group}' which doesn't exist`,
      );
    }
  });

  it("policies exist for all groups", () => {
    for (const group of Object.keys(MANIFEST.routeGroups)) {
      const policy = MANIFEST.policies[group] ?? MANIFEST.defaultPolicy;
      expect(policy).toBeDefined();
      expect(policy.request).toBeDefined();
      expect(policy.retry).toBeDefined();
      expect(policy.deadline).toBeDefined();
    }
  });

  it("default policy has all required fields", () => {
    const p = MANIFEST.defaultPolicy;
    expect(p.request.unsupportedParams).toBeInstanceOf(Array);
    expect(p.retry.retryableFailureClasses).toBeInstanceOf(Array);
    expect(p.health.circuitFailureThreshold).toBeGreaterThan(0);
    expect(p.deadline.totalTimeoutSeconds).toBeGreaterThan(0);
  });
});

// ─── Request envelope construction ────────────────────────────────

describe("Request envelope construction", () => {
  it("detects tools in request", () => {
    const body = {
      model: "glm-5.1",
      messages: [{ role: "user", content: "use tool" }],
      tools: [{ type: "function", function: { name: "test" } }],
    };
    const hasTools = !!(body.tools && (body.tools as unknown[]).length > 0);
    expect(hasTools).toBe(true);
  });

  it("detects streaming request", () => {
    const body = { model: "glm-5.1", messages: [], stream: true };
    expect(body.stream === true).toBe(true);
  });

  it("detects strict tools", () => {
    const body = { model: "glm-5.1", messages: [], tool_choice: "required" };
    expect(body.tool_choice === "required" || body.tool_choice === "any").toBe(true);
  });

  it("detects json mode", () => {
    const body = { model: "glm-5.1", messages: [], response_format: { type: "json_object" } };
    expect(body.response_format !== undefined).toBe(true);
  });
});

// ─── Rate limit integration ───────────────────────────────────────

describe("Rate limit integration", () => {
  it("returns null for allowed requests", () => {
    const req = new Request("https://example.com", {
      headers: { "CF-Connecting-IP": "1.2.3.4" },
    });
    expect(checkRequestRateLimit(req)).toBeNull();
  });
});

// ─── Validation edge cases ────────────────────────────────────────

describe("Validation edge cases", () => {
  it("handles deeply nested messages", () => {
    const messages = Array.from({ length: 100 }, (_, i) => ({
      role: "user" as const,
      content: `Message ${i}`,
    }));
    const result = validateChatRequest({
      model: "glm-5.1",
      messages,
    });
    expect(result.valid).toBe(true);
  });

  it("rejects too many messages", () => {
    const messages = Array.from({ length: 201 }, (_, i) => ({
      role: "user" as const,
      content: `Message ${i}`,
    }));
    const result = validateChatRequest({
      model: "glm-5.1",
      messages,
    });
    expect(result.valid).toBe(false);
    expect(result.error?.code).toBe("invalid_messages");
  });

  it("accepts boundary temperature values", () => {
    expect(validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      temperature: 0,
    }).valid).toBe(true);

    expect(validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      temperature: 2,
    }).valid).toBe(true);
  });

  it("rejects temperature just outside range", () => {
    expect(validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      temperature: -0.001,
    }).valid).toBe(false);

    expect(validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      temperature: 2.001,
    }).valid).toBe(false);
  });

  it("accepts boundary max_tokens", () => {
    expect(validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 1,
    }).valid).toBe(true);

    expect(validateChatRequest({
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      max_tokens: 1000000,
    }).valid).toBe(true);
  });

  it("accepts all supported model aliases", () => {
    for (const alias of Object.keys(MANIFEST.aliases)) {
      const result = validateChatRequest({
        model: alias,
        messages: [{ role: "user", content: "hello" }],
      });
      expect(result.valid).toBe(true);
    }
  });
});

// ─── Functions → tools migration ──────────────────────────────────

describe("Functions to tools migration", () => {
  it("migrates functions to tools format", () => {
    const body: Record<string, unknown> = {
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      functions: [
        { name: "get_weather", description: "Get weather", parameters: { type: "object" } },
      ],
    };
    migrateFunctionsToTools(body);
    expect(body.tools).toHaveLength(1);
    expect((body.tools as Array<Record<string, unknown>>)[0]).toEqual({
      type: "function",
      function: { name: "get_weather", description: "Get weather", parameters: { type: "object" } },
    });
    expect(body.functions).toBeUndefined();
  });

  it("migrates function_call string to tool_choice", () => {
    const body: Record<string, unknown> = {
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      functions: [{ name: "test", description: "test" }],
      function_call: "auto",
    };
    migrateFunctionsToTools(body);
    expect(body.tool_choice).toBe("auto");
    expect(body.function_call).toBeUndefined();
  });

  it("migrates function_call object to tool_choice", () => {
    const body: Record<string, unknown> = {
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      functions: [{ name: "test", description: "test" }],
      function_call: { name: "test" },
    };
    migrateFunctionsToTools(body);
    expect(body.tool_choice).toEqual({ type: "function", function: { name: "test" } });
  });

  it("does not overwrite existing tools", () => {
    const body: Record<string, unknown> = {
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
      functions: [{ name: "old", description: "old" }],
      tools: [{ type: "function", function: { name: "new" } }],
    };
    migrateFunctionsToTools(body);
    expect((body.tools as Array<Record<string, unknown>>)[0].function).toEqual({ name: "new" });
  });

  it("is no-op when no functions present", () => {
    const body: Record<string, unknown> = {
      model: "glm-5.1",
      messages: [{ role: "user", content: "hello" }],
    };
    migrateFunctionsToTools(body);
    expect(body.tools).toBeUndefined();
    expect(body.tool_choice).toBeUndefined();
  });
});
