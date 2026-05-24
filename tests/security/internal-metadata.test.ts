import { describe, it, expect } from "vitest";
import { sanitizeClientMetadata, signMetadata, verifyMetadataSignature } from "../../src/security/internal-metadata";

describe("sanitizeClientMetadata", () => {
  it("strips x-nim- prefixed metadata keys", () => {
    const body = {
      model: "glm-5.1",
      messages: [],
      metadata: { "x-nim-trace": "abc", user_id: "123" },
    };
    const result = sanitizeClientMetadata(body);
    expect((result.metadata as Record<string, unknown>)["x-nim-trace"]).toBeUndefined();
    expect((result.metadata as Record<string, unknown>).user_id).toBe("123");
  });

  it("strips x-route- prefixed metadata keys", () => {
    const body = {
      model: "glm-5.1",
      messages: [],
      metadata: { "x-route-group": "g1" },
    };
    const result = sanitizeClientMetadata(body);
    expect((result.metadata as Record<string, unknown>)["x-route-group"]).toBeUndefined();
  });

  it("hoists extra_body fields to top level and removes extra_body key", () => {
    const body = {
      model: "glm-5.1",
      messages: [],
      extra_body: { reasoning_effort: "high", custom_param: 42 },
    };
    const result = sanitizeClientMetadata(body);
    expect(result.extra_body).toBeUndefined();
    expect(result.reasoning_effort).toBe("high");
    expect(result.custom_param).toBe(42);
  });

  it("does not overwrite existing top-level fields with extra_body", () => {
    const body = {
      model: "glm-5.1",
      messages: [],
      temperature: 0.5,
      extra_body: { temperature: 0.9, new_param: true },
    };
    const result = sanitizeClientMetadata(body);
    expect(result.temperature).toBe(0.5);
    expect(result.new_param).toBe(true);
  });

  it("handles body without metadata or extra_body", () => {
    const body = { model: "glm-5.1", messages: [] };
    const result = sanitizeClientMetadata(body);
    expect(result).toEqual(body);
  });
});

describe("metadata signing", () => {
  it("signs and verifies a payload", async () => {
    const payload = { requestId: "req_123", model: "glm-5.1" };
    const key = "test-signing-key";
    const sig = await signMetadata(payload, key);
    expect(await verifyMetadataSignature(payload, sig, key)).toBe(true);
  });

  it("rejects tampered payload", async () => {
    const payload = { requestId: "req_123" };
    const key = "test-signing-key";
    const sig = await signMetadata(payload, key);
    const tampered = { requestId: "req_456" };
    expect(await verifyMetadataSignature(tampered, sig, key)).toBe(false);
  });

  it("rejects wrong key", async () => {
    const payload = { requestId: "req_123" };
    const sig = await signMetadata(payload, "key-a");
    expect(await verifyMetadataSignature(payload, sig, "key-b")).toBe(false);
  });
});
