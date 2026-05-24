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

  it("strips top-level internal-prefixed keys (case-insensitive)", () => {
    const body = {
      model: "glm-5.1",
      messages: [],
      "x-nim-forged": "a",
      "X-ROUTE-FORGE": "b",
      "x-control-flag": true,
      safe: "ok",
    };
    const result = sanitizeClientMetadata(body);
    expect(result["x-nim-forged"]).toBeUndefined();
    expect(result["X-ROUTE-FORGE"]).toBeUndefined();
    expect(result["x-control-flag"]).toBeUndefined();
    expect(result.safe).toBe("ok");
  });

  it("replaces array metadata with an empty object", () => {
    const body = {
      model: "glm-5.1",
      messages: [],
      metadata: [{ "x-nim-nested": "forged" }],
    };
    const result = sanitizeClientMetadata(body);
    expect(Array.isArray(result.metadata)).toBe(false);
    expect(result.metadata).toEqual({});
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

  it("strips internal-prefixed fields hoisted from extra_body", () => {
    const body = {
      model: "glm-5.1",
      messages: [],
      extra_body: {
        "x-nim-signature": "client-forged-signature",
        "x-route-group": "client-forged-group",
        allowed_param: true,
      },
    };
    const result = sanitizeClientMetadata(body);
    expect(result["x-nim-signature"]).toBeUndefined();
    expect(result["x-route-group"]).toBeUndefined();
    expect(result.allowed_param).toBe(true);
  });

  it("drops prototype-polluting keys from metadata and extra_body", () => {
    const protoKey = ["__", "proto__"].join("");
    const metadata: Record<string, unknown> = Object.create(null);
    metadata[protoKey] = { polluted: true };
    metadata.constructor = { prototype: { polluted: true } };
    metadata.safe = "value";
    const extraBody: Record<string, unknown> = Object.create(null);
    extraBody[protoKey] = { polluted: true };
    extraBody.prototype = { polluted: true };
    extraBody.safe_extra = 42;
    const body = {
      model: "glm-5.1",
      messages: [],
      metadata,
      extra_body: extraBody,
    };

    const result = sanitizeClientMetadata(body);

    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect((result.metadata as Record<string, unknown>).safe).toBe("value");
    expect(Object.prototype.hasOwnProperty.call(result.metadata, protoKey)).toBe(false);
    expect(result.prototype).toBeUndefined();
    expect(result.safe_extra).toBe(42);
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
