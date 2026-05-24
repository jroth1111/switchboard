import { describe, it, expect } from "vitest";
import {
  recordReceipt,
  getReceipt,
  getAllReceipts,
  redact,
  sanitizeReceipt,
  type RouteReceipt,
} from "../../src/observability/receipt";
import {
  admit,
  release,
  recordFailure,
} from "../../src/state/admission-engine";
import { InMemoryStorageAdapter } from "../../src/state/storage-adapter";

function makeReceipt(overrides: Partial<RouteReceipt> = {}): RouteReceipt {
  return {
    requestId: `req-${Math.random().toString(36).slice(2, 8)}`,
    timestamp: Date.now(),
    originalModel: "glm-5.1",
    canonicalTarget: "nim-primary",
    selectedGroup: "nim-primary",
    fallbackGroups: ["nim-secondary"],
    attempts: [{
      group: "nim-primary",
      deploymentId: "nim-primary-key-1",
      durationMs: 150,
      action: "accept",
    }],
    finalOutcome: "success",
    stream: false,
    ...overrides,
  };
}

// ─── In-memory receipt storage ────────────────────────────────────

describe("Receipt storage (in-memory)", () => {
  it("stores and retrieves a receipt", () => {
    const receipt = makeReceipt({ requestId: "req-test-1" });
    recordReceipt(receipt);

    const retrieved = getReceipt("req-test-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.requestId).toBe("req-test-1");
    expect(retrieved!.finalOutcome).toBe("success");
    expect(retrieved!.attempts).toHaveLength(1);
  });

  it("returns undefined for unknown request", () => {
    expect(getReceipt("nonexistent")).toBeUndefined();
  });

  it("lists all receipts", () => {
    recordReceipt(makeReceipt({ requestId: "req-list-1" }));
    recordReceipt(makeReceipt({ requestId: "req-list-2" }));

    const all = getAllReceipts();
    expect(all.length).toBeGreaterThanOrEqual(2);
    expect(all.some((r) => r.requestId === "req-list-1")).toBe(true);
    expect(all.some((r) => r.requestId === "req-list-2")).toBe(true);
  });

  it("overwrites receipt on duplicate requestId", () => {
    recordReceipt(makeReceipt({ requestId: "req-dup", finalOutcome: "success" }));
    recordReceipt(makeReceipt({ requestId: "req-dup", finalOutcome: "exhausted" }));

    const retrieved = getReceipt("req-dup");
    expect(retrieved!.finalOutcome).toBe("exhausted");
  });
});

// ─── Redaction ────────────────────────────────────────────────────

describe("Receipt redaction", () => {
  it("redacts API keys", () => {
    expect(redact('api_key="sk-abc1234567890123456789"')).toContain("***REDACTED***");
    expect(redact("Bearer sk-abc1234567890123456789")).toContain("***REDACTED***");
  });

  it("redacts Authorization headers", () => {
    expect(redact("Authorization: Bearer my-secret-token\n")).toContain("***REDACTED***");
  });

  it("leaves normal text unchanged", () => {
    expect(redact("Hello world")).toBe("Hello world");
  });

  it("redacts embedded secrets in otherwise safe text", () => {
    expect(redact("prefix sk-abcdefghijklmnop suffix")).toContain("***REDACTED***");
    expect(redact("prefix sk-abcdefghijklmnop suffix")).not.toContain("sk-abcdefghijklmnop");
  });
});

// ─── Structured sanitization ──────────────────────────────────────

describe("Structured receipt sanitization", () => {
  it("redacts secret fields", () => {
    const input = {
      api_key: "sk-supersecret123456789012345",
      authorization: "Bearer token123",
      password: "hunter2",
      safe_field: "visible",
    };
    const result = sanitizeReceipt(input) as Record<string, unknown>;
    expect(result.api_key).toBe("<redacted>");
    expect(result.authorization).toBe("<redacted>");
    expect(result.password).toBe("<redacted>");
    expect(result.safe_field).toBe("visible");
  });

  it("redacts fields ending with _api_key or _token", () => {
    const input = {
      my_api_key: "secret",
      user_token: "secret",
      safe_name: "visible",
    };
    const result = sanitizeReceipt(input) as Record<string, unknown>;
    expect(result.my_api_key).toBe("<redacted>");
    expect(result.user_token).toBe("<redacted>");
    expect(result.safe_name).toBe("visible");
  });

  it("hashes diagnostic detail fields", () => {
    const input = {
      error_body: "Internal Server Error: database connection failed",
      issue_detail: "timeout exceeded",
      failureMessage: "provider body included prompt text",
      safe_field: "keep me",
    };
    const result = sanitizeReceipt(input) as Record<string, unknown>;
    const errorBody = result.error_body as Record<string, unknown>;
    expect(errorBody.redacted).toBe(true);
    expect(errorBody.fingerprint).toBeDefined();
    expect(typeof errorBody.fingerprint).toBe("string");
    expect(errorBody.length).toBe(
      "Internal Server Error: database connection failed".length,
    );

    const issueDetail = result.issue_detail as Record<string, unknown>;
    expect(issueDetail.redacted).toBe(true);
    expect(issueDetail.length).toBe("timeout exceeded".length);

    const failureMessage = result.failureMessage as Record<string, unknown>;
    expect(failureMessage.redacted).toBe(true);
    expect(failureMessage.length).toBe("provider body included prompt text".length);

    expect(result.safe_field).toBe("keep me");
  });

  it("redacts string values with secret prefixes", () => {
    expect(sanitizeReceipt("sk-abc123")).toBe("<redacted>");
    expect(sanitizeReceipt("sk_prod_key123")).toBe("<redacted>");
    expect(sanitizeReceipt("Bearer token123")).toBe("<redacted>");
    expect(sanitizeReceipt("basic dXNlcjpwYXNz")).toBe("<redacted>");
    expect(sanitizeReceipt("normal text")).toBe("normal text");
  });

  it("redacts embedded secrets in non-secret field values", () => {
    const result = sanitizeReceipt({
      safe_field: "prefix sk-abcdefghijklmnop suffix",
    }) as Record<string, unknown>;
    expect(result.safe_field).toContain("***REDACTED***");
    expect(String(result.safe_field)).not.toContain("sk-abcdefghijklmnop");
  });

  it("redacts private file paths", () => {
    expect(sanitizeReceipt("/users/admin/.ssh/id_rsa")).toBe("<redacted>");
    expect(sanitizeReceipt("/private/tmp/secret.txt")).toBe("<redacted>");
    expect(sanitizeReceipt("/tmp/sensitive.dat")).toBe("<redacted>");
    expect(sanitizeReceipt("/var/folders/abc/data")).toBe("<redacted>");
    expect(sanitizeReceipt("/etc/config.yaml")).toBe("/etc/config.yaml");
  });

  it("recursively sanitizes nested objects", () => {
    const input = {
      level1: {
        api_key: "sk-secret",
        nested: {
          password: "hidden",
          safe: "visible",
          deep: {
            token: "abc",
            also_safe: 42,
          },
        },
      },
    };
    const result = sanitizeReceipt(input) as Record<string, unknown>;
    const l1 = result.level1 as Record<string, unknown>;
    expect(l1.api_key).toBe("<redacted>");
    const nested = l1.nested as Record<string, unknown>;
    expect(nested.password).toBe("<redacted>");
    expect(nested.safe).toBe("visible");
    const deep = nested.deep as Record<string, unknown>;
    expect(deep.token).toBe("<redacted>");
    expect(deep.also_safe).toBe(42);
  });

  it("recursively sanitizes arrays", () => {
    const input = {
      items: [
        { api_key: "sk-key1", name: "item1" },
        { api_key: "sk-key2", name: "item2" },
      ],
    };
    const result = sanitizeReceipt(input) as Record<string, unknown>;
    const items = result.items as Array<Record<string, unknown>>;
    expect(items[0].api_key).toBe("<redacted>");
    expect(items[0].name).toBe("item1");
    expect(items[1].api_key).toBe("<redacted>");
    expect(items[1].name).toBe("item2");
  });

  it("passes through primitives unchanged", () => {
    expect(sanitizeReceipt(42)).toBe(42);
    expect(sanitizeReceipt(true)).toBe(true);
    expect(sanitizeReceipt(null)).toBe(null);
    expect(sanitizeReceipt(undefined)).toBe(undefined);
  });

  it("handles null/empty diagnostic details", () => {
    const input = { error_body: null, response_body: "" };
    const result = sanitizeReceipt(input) as Record<string, unknown>;
    const errorBody = result.error_body as Record<string, unknown>;
    expect(errorBody.redacted).toBe(true);
    expect(errorBody.length).toBe(0);

    const responseBody = result.response_body as Record<string, unknown>;
    expect(responseBody.redacted).toBe(true);
    expect(responseBody.length).toBe(0);
  });

  it("is case-insensitive for field matching", () => {
    const input = {
      API_KEY: "secret",
      Authorization: "Bearer tok",
      ERROR_BODY: "details",
    };
    const result = sanitizeReceipt(input) as Record<string, unknown>;
    expect(result.API_KEY).toBe("<redacted>");
    expect(result.Authorization).toBe("<redacted>");
    const errorBody = result.ERROR_BODY as Record<string, unknown>;
    expect(errorBody.redacted).toBe(true);
  });
});

// ─── Receipt structure ────────────────────────────────────────────

describe("Receipt structure", () => {
  it("captures full attempt details", () => {
    const receipt = makeReceipt({
      attempts: [
        {
          group: "nim-primary",
          deploymentId: "nim-primary-key-1",
          failureClass: "server_5xx",
          failureMessage: "Internal Server Error",
          durationMs: 120,
          action: "retry_fallback" as const,
        },
        {
          group: "nim-deepseek-v4-pro",
          deploymentId: "nim-deepseek-v4-pro-key-1",
          durationMs: 340,
          action: "accept" as const,
        },
      ],
      finalOutcome: "repaired_success",
    });

    recordReceipt(receipt);
    const retrieved = getReceipt(receipt.requestId);
    expect(retrieved!.attempts).toHaveLength(2);
    expect(retrieved!.attempts[0].failureClass).toBe("server_5xx");
    expect(retrieved!.attempts[1].action).toBe("accept");
    expect(retrieved!.finalOutcome).toBe("repaired_success");
  });

  it("captures all outcome types", () => {
    const outcomes: RouteReceipt["finalOutcome"][] = [
      "success", "repaired_success", "client_error", "exhausted",
    ];
    for (const outcome of outcomes) {
      const receipt = makeReceipt({ requestId: `req-outcome-${outcome}`, finalOutcome: outcome });
      recordReceipt(receipt);
      expect(getReceipt(`req-outcome-${outcome}`)!.finalOutcome).toBe(outcome);
    }
  });
});

// ─── Receipt + state engine integration ───────────────────────────

describe("Receipt + state engine flow", () => {
  it("records receipt after successful admission flow", () => {
    const store = new InMemoryStorageAdapter();
    const c = { deploymentId: "deploy-1", keyRef: "key-1", rpm: 35, maxParallel: 2, group: "test" };
    const result = admit(store, { requestId: "req-integ-1", candidates: [c] });

    const receipt = makeReceipt({
      requestId: "req-integ-1",
      selectedGroup: "test",
      attempts: [{
        group: "test",
        deploymentId: result.deploymentId,
        durationMs: 200,
        action: "accept",
      }],
      finalOutcome: "success",
    });
    recordReceipt(receipt);

    const retrieved = getReceipt("req-integ-1");
    expect(retrieved).toBeDefined();
    expect(retrieved!.attempts[0].deploymentId).toBe("deploy-1");
  });

  it("records receipt after failure and fallback", () => {
    const store = new InMemoryStorageAdapter();

    // First deployment fails
    recordFailure(store, "deploy-1", "rate_limit_overload", 30, 5, 300);

    // Fallback to second
    const result = admit(store, {
      requestId: "req-integ-2",
      candidates: [
        { deploymentId: "deploy-1", keyRef: "key-1", rpm: 35, maxParallel: 2, group: "primary" },
        { deploymentId: "deploy-2", keyRef: "key-2", rpm: 35, maxParallel: 2, group: "fallback" },
      ],
    });

    expect(result.deploymentId).toBe("deploy-2");

    const receipt = makeReceipt({
      requestId: "req-integ-2",
      attempts: [
        { group: "primary", deploymentId: "deploy-1", failureClass: "rate_limit_overload", durationMs: 50, action: "retry_fallback" },
        { group: "fallback", deploymentId: "deploy-2", durationMs: 300, action: "accept" },
      ],
      finalOutcome: "success",
    });
    recordReceipt(receipt);

    const retrieved = getReceipt("req-integ-2");
    expect(retrieved!.attempts).toHaveLength(2);
    expect(retrieved!.attempts[0].failureClass).toBe("rate_limit_overload");
  });
});
