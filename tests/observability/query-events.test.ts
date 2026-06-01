import { describe, expect, it } from "vitest";
import {
  buildQueryEvent,
  DEFAULT_QUERY_CAPTURE_MAX_EVENTS,
  MAX_QUERY_CAPTURE_MAX_EVENTS,
  parseQueryCaptureMaxEvents,
  resolveQueryCaptureConfig,
  sanitizeQueryEventBody,
  trimQueryEventsForRetention,
  isQueryCaptureEnabled,
  type QueryShape,
} from "../../src/observability/query-events";

describe("query visibility events", () => {
  it("defaults to shape-only metadata without prompt text", async () => {
    const event = await buildQueryEvent({
      requestId: "req-query-shape",
      stage: "incoming",
      surface: "chat_completions",
      config: resolveQueryCaptureConfig({}),
      body: {
        model: "smart-route",
        messages: [{ role: "user", content: "do not leak this prompt" }],
        tools: [{ type: "function", function: { name: "lookup_secret" } }],
      },
    });

    const serialized = JSON.stringify(event);
    expect(event.effectiveTier).toBe("shape");
    expect(event.event.shape.messages).toMatchObject({ count: 1, roles: ["user"], stringContentCount: 1 });
    expect(event.event.shape.tools).toMatchObject({ count: 1, names: ["lookup_secret"] });
    expect(serialized).not.toContain("do not leak this prompt");
    expect(serialized).not.toContain("messages\":[{\"role\"");
  });

  it("does not enable raw capture without the explicit raw gate and key", async () => {
    const config = resolveQueryCaptureConfig({ SWITCHBOARD_QUERY_CAPTURE_TIER: "raw" });
    const event = await buildQueryEvent({
      requestId: "req-query-raw-disabled",
      stage: "incoming",
      config,
      body: { model: "smart-route", messages: [{ role: "user", content: "plaintext prompt" }] },
    });

    expect(event.visibilityTier).toBe("raw");
    expect(event.effectiveTier).toBe("shape");
    expect(event.rawDisabledReason).toBe("raw capture disabled");
    expect(event.event.encryptedRaw).toBeUndefined();
    expect(JSON.stringify(event)).not.toContain("plaintext prompt");
  });

  it("does not enable raw capture without a policy gate even when env is enabled", async () => {
    const config = resolveQueryCaptureConfig({
      SWITCHBOARD_QUERY_CAPTURE_TIER: "raw",
      SWITCHBOARD_QUERY_CAPTURE_RAW_ENABLED: "true",
      SWITCHBOARD_QUERY_CAPTURE_RAW_KEY: "test-key",
    });

    expect(config.effectiveTier).toBe("shape");
    expect(config.rawDisabledReason).toBe("raw capture policy not allowed");
  });

  it("encrypts raw payloads only when raw capture is explicitly enabled", async () => {
    const config = resolveQueryCaptureConfig({
      SWITCHBOARD_QUERY_CAPTURE_TIER: "raw",
      SWITCHBOARD_QUERY_CAPTURE_RAW_ENABLED: "true",
      SWITCHBOARD_QUERY_CAPTURE_RAW_KEY: "test-key",
    }, true);
    const event = await buildQueryEvent({
      requestId: "req-query-raw-enabled",
      stage: "incoming",
      config,
      body: { model: "smart-route", messages: [{ role: "user", content: "raw prompt" }] },
    });

    expect(event.effectiveTier).toBe("raw");
    expect(event.event.encryptedRaw?.alg).toBe("AES-GCM");
    expect(JSON.stringify(event)).not.toContain("raw prompt");
  });

  it("redacted tier summarizes prompt-like fields without excerpts", async () => {
    const event = await buildQueryEvent({
      requestId: "req-query-redacted",
      stage: "incoming",
      config: resolveQueryCaptureConfig({ SWITCHBOARD_QUERY_CAPTURE_TIER: "redacted" }),
      body: {
        model: "smart-route",
        instructions: "do not leak this instruction",
        messages: [{ role: "user", content: "do not leak this prompt either" }],
      },
    });

    const serialized = JSON.stringify(event);
    expect(event.effectiveTier).toBe("redacted");
    expect(serialized).not.toContain("do not leak this instruction");
    expect(serialized).not.toContain("do not leak this prompt either");
    expect(serialized).not.toContain("preview");
    expect(event.event.redacted).toMatchObject({
      instructions: { redacted: true, type: "string", length: 28 },
    });
  });

  it("sanitizeQueryEventBody strips nested prompt fields and preserves encryptedRaw", () => {
    const shape: QueryShape = {
      bodyBytes: 128,
      bodySha256: "abc123",
      topLevelKeys: ["messages"],
    };
    const encryptedRaw = {
      alg: "AES-GCM" as const,
      iv: "iv-value",
      ciphertext: "cipher-value",
    };
    const sanitized = sanitizeQueryEventBody({
      shape,
      redacted: {
        messages: [
          {
            role: "user",
            content: "nested prompt text",
            metadata: { system: "nested system prompt" },
          },
        ],
      },
      encryptedRaw,
    });

    expect(sanitized.encryptedRaw).toEqual(encryptedRaw);
    expect(JSON.stringify(sanitized)).not.toContain("nested prompt text");
    expect(JSON.stringify(sanitized)).not.toContain("nested system prompt");
    expect(sanitized.redacted).toMatchObject({
      messages: {
        redacted: true,
        type: "array",
        count: 1,
        items: [
          {
            role: "user",
            keys: expect.arrayContaining(["content", "metadata", "role"]),
            content: { type: "string", length: 18 },
          },
        ],
      },
    });
    expect((sanitized.redacted as { messages: { items: Array<{ keys: string[] }> } }).messages.items[0].keys)
      .toContain("metadata");
  });

  it("sanitizeQueryEventBody redacts prompt-like keys inside non-prompt parent objects", () => {
    const sanitized = sanitizeQueryEventBody({
      shape: { bodyBytes: 1, bodySha256: "x", topLevelKeys: [] },
      redacted: {
        tool_choice: {
          type: "function",
          function: { name: "lookup" },
          input: "secret tool input",
        },
      },
    });

    expect(JSON.stringify(sanitized)).not.toContain("secret tool input");
    expect(sanitized.redacted).toMatchObject({
      tool_choice: {
        type: "function",
        function: { name: "lookup" },
        input: { redacted: true, type: "string", length: 17 },
      },
    });
  });
});

describe("isQueryCaptureEnabled", () => {
  it("is off by default", () => {
    expect(isQueryCaptureEnabled({})).toBe(false);
    expect(isQueryCaptureEnabled(undefined)).toBe(false);
  });

  it("is on when enabled flag or tier env is set", () => {
    expect(isQueryCaptureEnabled({ SWITCHBOARD_QUERY_CAPTURE_ENABLED: "true" })).toBe(true);
    expect(isQueryCaptureEnabled({ SWITCHBOARD_QUERY_CAPTURE_TIER: "shape" })).toBe(false);
    expect(isQueryCaptureEnabled({ SWITCHBOARD_QUERY_CAPTURE_TIER: "redacted" })).toBe(false);
  });
});

describe("parseQueryCaptureMaxEvents", () => {
  it("defaults to 50 when unset or invalid", () => {
    expect(DEFAULT_QUERY_CAPTURE_MAX_EVENTS).toBe(50);
    expect(parseQueryCaptureMaxEvents(undefined)).toBe(50);
    expect(parseQueryCaptureMaxEvents({})).toBe(50);
    expect(parseQueryCaptureMaxEvents({ QUERY_CAPTURE_MAX_EVENTS: "0" })).toBe(50);
    expect(parseQueryCaptureMaxEvents({ QUERY_CAPTURE_MAX_EVENTS: "not-a-number" })).toBe(50);
  });

  it("reads QUERY_CAPTURE_MAX_EVENTS or SWITCHBOARD_QUERY_CAPTURE_MAX_EVENTS", () => {
    expect(parseQueryCaptureMaxEvents({ QUERY_CAPTURE_MAX_EVENTS: "25" })).toBe(25);
    expect(parseQueryCaptureMaxEvents({ SWITCHBOARD_QUERY_CAPTURE_MAX_EVENTS: "100" })).toBe(100);
    expect(parseQueryCaptureMaxEvents({
      QUERY_CAPTURE_MAX_EVENTS: "10",
      SWITCHBOARD_QUERY_CAPTURE_MAX_EVENTS: "100",
    })).toBe(100);
  });

  it("caps configured max at MAX_QUERY_CAPTURE_MAX_EVENTS", () => {
    expect(MAX_QUERY_CAPTURE_MAX_EVENTS).toBe(200);
    expect(parseQueryCaptureMaxEvents({ QUERY_CAPTURE_MAX_EVENTS: "100000" })).toBe(200);
  });
});

describe("trimQueryEventsForRetention", () => {
  it("keeps the newest max events per requestId group", () => {
    const events = [
      { requestId: "req-a", stage: "incoming", n: 1 },
      { requestId: "req-a", stage: "post_transform", n: 2 },
      { requestId: "req-a", stage: "provider_request", n: 3 },
      { requestId: "req-b", stage: "incoming", n: 4 },
      { requestId: "req-b", stage: "post_transform", n: 5 },
    ];

    expect(trimQueryEventsForRetention(events, 2)).toEqual([
      { requestId: "req-a", stage: "post_transform", n: 2 },
      { requestId: "req-a", stage: "provider_request", n: 3 },
      { requestId: "req-b", stage: "incoming", n: 4 },
      { requestId: "req-b", stage: "post_transform", n: 5 },
    ]);
    expect(trimQueryEventsForRetention(events, 1)).toEqual([
      { requestId: "req-a", stage: "provider_request", n: 3 },
      { requestId: "req-b", stage: "post_transform", n: 5 },
    ]);
  });

  it("returns empty array when max is zero or negative", () => {
    const events = [{ requestId: "req-a", stage: "incoming" }];
    expect(trimQueryEventsForRetention(events, 0)).toEqual([]);
    expect(trimQueryEventsForRetention(events, -1)).toEqual([]);
  });
});
