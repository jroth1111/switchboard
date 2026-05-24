import { describe, it, expect } from "vitest";
import {
  failedRequestSummaryFromReceipt,
  finalizeFailedRequest,
} from "../../src/observability/failed-request-finalizer";
import type { RouteReceipt } from "../../src/observability/receipt";

function makeReceipt(overrides: Partial<RouteReceipt> = {}): RouteReceipt {
  return {
    requestId: "req-finalize-1",
    timestamp: Date.now(),
    originalModel: "glm-5.1",
    canonicalTarget: "nim-primary",
    selectedGroup: "nim-primary",
    fallbackGroups: ["nim-deepseek-v4-pro"],
    attempts: [{
      group: "nim-primary",
      deploymentId: "nim-primary-key-1",
      failureClass: "server_5xx",
      failureMessage: "Internal Server Error",
      durationMs: 500,
      action: "retry_fallback",
    }, {
      group: "nim-deepseek-v4-pro",
      deploymentId: "nim-deepseek-v4-pro-key-1",
      failureClass: "exhausted",
      failureMessage: "All retries exhausted",
      durationMs: 1200,
      action: "exhausted",
    }],
    finalOutcome: "exhausted",
    stream: false,
    ...overrides,
  };
}

describe("failedRequestSummaryFromReceipt", () => {
  it("returns null for successful receipts", () => {
    const receipt = makeReceipt({ finalOutcome: "success" });
    expect(failedRequestSummaryFromReceipt(receipt)).toBeNull();
  });

  it("returns null for repaired success receipts", () => {
    const receipt = makeReceipt({ finalOutcome: "repaired_success" });
    expect(failedRequestSummaryFromReceipt(receipt)).toBeNull();
  });

  it("extracts summary from exhausted receipt", () => {
    const receipt = makeReceipt({ finalOutcome: "exhausted" });
    const summary = failedRequestSummaryFromReceipt(receipt);

    expect(summary).not.toBeNull();
    expect(summary!.requestId).toBe("req-finalize-1");
    expect(summary!.route).toBe("nim-primary");
    expect(summary!.finalOutcome).toBe("exhausted");
    expect(summary!.selectedModel).toBe("nim-deepseek-v4-pro-key-1");
    expect(summary!.selectedDeploymentId).toBe("nim-deepseek-v4-pro-key-1");
    expect(summary!.requestSource).toBe("unknown");
    expect(summary!.failureClass).toBe("exhausted");
    expect(summary!.issueCode).toBe("all_groups_exhausted");
    expect(summary!.attemptsCount).toBe(2);
    expect(summary!.attempts).toHaveLength(2);
    expect(summary!.attempts[0].failureClass).toBe("server_5xx");
    expect(summary!.attempts[0].action).toBe("retry_fallback");
  });

  it("extracts summary from client_error receipt", () => {
    const receipt = makeReceipt({
      finalOutcome: "client_error",
      attempts: [{
        group: "nim-primary",
        deploymentId: "nim-primary-key-1",
        failureClass: "client_4xx",
        durationMs: 100,
        action: "fail_client",
      }],
    });
    const summary = failedRequestSummaryFromReceipt(receipt);

    expect(summary).not.toBeNull();
    expect(summary!.finalOutcome).toBe("client_error");
    expect(summary!.failureClass).toBe("client_4xx");
    expect(summary!.issueCode).toBeUndefined();
  });

  it("uses first failure class when last attempt has none", () => {
    const receipt = makeReceipt({
      finalOutcome: "exhausted",
      attempts: [{
        group: "nim-primary",
        deploymentId: "nim-primary-key-1",
        failureClass: "rate_limit_overload",
        durationMs: 100,
        action: "retry_fallback",
      }, {
        group: "nim-deepseek-v4-pro",
        deploymentId: "nim-deepseek-v4-pro-key-1",
        durationMs: 200,
        action: "exhausted",
      }],
    });
    const summary = failedRequestSummaryFromReceipt(receipt);

    expect(summary!.failureClass).toBe("rate_limit_overload");
  });

  it("omits failureMessage from attempt summaries", () => {
    const receipt = makeReceipt();
    const summary = failedRequestSummaryFromReceipt(receipt);

    for (const attempt of summary!.attempts) {
      expect(attempt).not.toHaveProperty("failureMessage");
    }
  });

  it("preserves stream flag", () => {
    const receipt = makeReceipt({ finalOutcome: "exhausted", stream: true });
    const summary = failedRequestSummaryFromReceipt(receipt);
    expect(summary!.stream).toBe(true);
  });

  it("derives request source from app id before client id", () => {
    const receipt = makeReceipt({
      finalOutcome: "exhausted",
      appId: "hermes",
      clientId: "hermes-alice",
    });
    const summary = failedRequestSummaryFromReceipt(receipt);
    expect(summary!.requestSource).toBe("hermes");
  });
});

describe("finalizeFailedRequest", () => {
  it("returns null for successful receipts", () => {
    const receipt = makeReceipt({ finalOutcome: "success" });
    expect(finalizeFailedRequest(receipt)).toBeNull();
  });

  it("returns summary and sanitized receipt for exhausted", () => {
    const receipt = makeReceipt({ finalOutcome: "exhausted" });
    const result = finalizeFailedRequest(receipt);

    expect(result).not.toBeNull();
    expect(result!.summary.requestId).toBe("req-finalize-1");
    expect(result!.sanitizedReceipt).toBeDefined();
    // Sanitized receipt should be an object
    expect(typeof result!.sanitizedReceipt).toBe("object");
  });

  it("sanitizes secret fields in the receipt", () => {
    const receipt = makeReceipt({
      finalOutcome: "exhausted",
      attempts: [{
        group: "test",
        deploymentId: "deploy-1",
        failureMessage: "database connection failed",
        durationMs: 100,
        action: "retry_fallback",
      }],
    });
    const result = finalizeFailedRequest(receipt);
    const sanitized = result!.sanitizedReceipt as Record<string, unknown>;
    expect(sanitized.requestId).toBe("req-finalize-1");
    const attempts = sanitized.attempts as Array<Record<string, unknown>>;
    const failureMessage = attempts[0].failureMessage as Record<string, unknown>;
    expect(failureMessage.redacted).toBe(true);
    expect(JSON.stringify(sanitized)).not.toContain("database connection failed");
  });
});
