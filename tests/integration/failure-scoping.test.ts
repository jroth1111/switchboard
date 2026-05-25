import { describe, it, expect } from "vitest";
import {
  admit,
  release,
  recordFailure,
} from "../../src/state/admission-engine";
import { InMemoryStorageAdapter } from "../../src/state/storage-adapter";
import { classifyProviderFailure } from "../../src/nim/classify/provider-failure";
import { classifyChatGPTFailure } from "../../src/providers/chatgpt-failure";
import { classifyAnthropicFailure } from "../../src/providers/anthropic-failure";
import {
  encrypt,
  decrypt,
} from "../../src/security/encryption";
import { executeStreamWithPreBuffer } from "../../src/streaming/pre-buffer";

function candidate(
  deploymentId: string,
  keyRef = "key-1",
  rpm = 35,
  maxParallel = 2,
  group = "test",
) {
  return { deploymentId, keyRef, rpm, maxParallel, group };
}

function streamFromSseData(...payloads: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const payload of payloads) {
        const data = typeof payload === "string" ? payload : JSON.stringify(payload);
        controller.enqueue(encoder.encode(`data: ${data}\n\n`));
      }
      controller.close();
    },
  });
}

function preBufferConfig() {
  return {
    preBufferChunks: 1,
    enableThinkingLeakStripping: true,
    enableSpecialTokenRepair: true,
    heartbeatIntervalMs: 0,
    maxSilenceMs: 0,
    firstTokenTimeoutMs: 100,
    hardTimeoutMs: 1000,
  };
}

describe("Provider-specific failure scoping integration", () => {
  it("ChatGPT session failure does not affect provider health", () => {
    const result = classifyChatGPTFailure(401, "session expired");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(true);
    expect(result.failureClass).toBe("oauth_session_failure");
  });

  it("ChatGPT subscription limit is account-scoped", () => {
    const result = classifyChatGPTFailure(403, "subscription limit");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(true);
    expect(result.failureClass).toBe("subscription_limit");
  });

  it("ChatGPT rate limit DOES affect health", () => {
    const result = classifyChatGPTFailure(429, "rate limited");
    expect(result.affectsHealth).toBe(true);
    expect(result.affectsAccount).toBe(true);
  });

  it("Anthropic OAuth failure is health-neutral", () => {
    const result = classifyAnthropicFailure(401, "invalid x-api-key");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(true);
    expect(result.failureClass).toBe("oauth_refresh_failure");
  });

  it("Anthropic usage limit is account-scoped not health-affecting", () => {
    const result = classifyAnthropicFailure(429, "usage limit for tier");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(true);
    expect(result.failureClass).toBe("subscription_limit");
  });

  it("Anthropic overloaded DOES affect health", () => {
    const result = classifyAnthropicFailure(529, "overloaded");
    expect(result.affectsHealth).toBe(true);
    expect(result.affectsAccount).toBe(false);
  });

  it("generic provider 5xx affects health but not specific account", () => {
    const result = classifyProviderFailure(500, "internal server error", "nvidia_nim");
    expect(result.affectsHealth).toBe(true);
    expect(result.affectsAccount).toBe(false);
    expect(result.failureClass).toBe("server_5xx");
  });

  it("generic auth failure is health-neutral but account-affecting", () => {
    const result = classifyProviderFailure(401, "unauthorized", "nvidia_nim");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(true);
    expect(result.failureClass).toBe("auth_failure");
  });

  it("context length exceeded is neither health nor account affecting", () => {
    const result = classifyProviderFailure(400, "context too long", "nvidia_nim");
    expect(result.affectsHealth).toBe(false);
    expect(result.affectsAccount).toBe(false);
    expect(result.failureClass).toBe("context_length_exceeded");
  });
});

describe("Account rotation after session expiry", () => {
  it("rotates to second account when first has session failure", () => {
    const store = new InMemoryStorageAdapter();
    const c1 = candidate("chatgpt-1", "chatgpt-oauth-1", 10, 1, "chatgpt-sub");
    const c2 = candidate("chatgpt-2", "chatgpt-oauth-2", 10, 1, "chatgpt-sub");

    // First account succeeds initially
    const r1 = admit(store, { requestId: "req-1", candidates: [c1, c2] });
    expect(r1.deploymentId).toBe("chatgpt-1");

    // Session failure — cooldown the account
    release(store, r1.reservationId!);
    recordFailure(store, "chatgpt-1", "oauth_session_failure", 60, 5, 300);

    // Next request should rotate to second account
    const r2 = admit(store, { requestId: "req-2", candidates: [c1, c2] });
    expect(r2.deploymentId).toBe("chatgpt-2");
  });

  it("subscription limit causes longer cooldown", () => {
    const store = new InMemoryStorageAdapter();
    const c1 = candidate("chatgpt-1", "chatgpt-oauth-1", 10, 1, "chatgpt-sub");
    const c2 = candidate("chatgpt-2", "chatgpt-oauth-2", 10, 1, "chatgpt-sub");

    // Subscription limit cooldown
    recordFailure(store, "chatgpt-1", "subscription_limit", 300, 5, 300);

    const r = admit(store, { requestId: "req-1", candidates: [c1, c2] });
    expect(r.deploymentId).toBe("chatgpt-2");
  });

  it("health-neutral failures don't affect global health score", () => {
    const store = new InMemoryStorageAdapter();
    const c = candidate("chatgpt-1", "chatgpt-oauth-1", 10, 1, "chatgpt-sub");

    admit(store, { requestId: "req-1", candidates: [c] });

    // Session failure with 0 cooldown (so it doesn't block admission)
    recordFailure(store, "chatgpt-1", "oauth_session_failure", 0, 5, 300);

    // Health-neutral auth/session failures must not punish provider health.
    const health = store.getHealthScore("chatgpt-1");
    expect(health).toBeNull();

    // No cooldown means the deployment can still be used
    const hasCooldown = store.getCooldown("chatgpt-1", Date.now());
    expect(hasCooldown).toBe(false);
  });
});

describe("OAuth token encryption round-trip", () => {
  it("encrypts and decrypts OAuth token correctly", async () => {
    const token = "sk-ant-oauth-token-abc123def456";
    const key = "worker-encryption-key-from-secret";
    const ciphertext = await encrypt(token, key);
    const decrypted = await decrypt(ciphertext, key);
    expect(decrypted).toBe(token);
  });

  it("each encryption produces unique ciphertext", async () => {
    const token = "same-token";
    const key = "encryption-key";
    const c1 = await encrypt(token, key);
    const c2 = await encrypt(token, key);
    expect(c1).not.toBe(c2);
    expect(await decrypt(c1, key)).toBe(await decrypt(c2, key));
  });
});

describe("Streaming pre-buffer integration", () => {
  it("detects invalid first chunk before committing", async () => {
    const result = executeStreamWithPreBuffer(
      {
        body: streamFromSseData({ error: { message: "Rate limit exceeded" } }, "[DONE]"),
        status: 200,
        headers: new Headers(),
      },
      preBufferConfig(),
    );

    await expect(result.ready).resolves.toEqual({
      committed: false,
      abortReason: "stream_error_payload",
    });
    await expect(result.done).resolves.toMatchObject({
      wasAborted: true,
      abortReason: "stream_error_payload",
      totalChunks: 1,
    });
    await expect(new Response(result.readable).text()).resolves.not.toContain("Rate limit exceeded");
  });

  it("passes through valid first chunk", async () => {
    const result = executeStreamWithPreBuffer(
      {
        body: streamFromSseData(
          { choices: [{ delta: { content: "Hello! I can help" }, finish_reason: null }] },
          "[DONE]",
        ),
        status: 200,
        headers: new Headers(),
      },
      preBufferConfig(),
    );

    await expect(result.ready).resolves.toEqual({ committed: true });
    await expect(new Response(result.readable).text()).resolves.toContain("Hello! I can help");
    await expect(result.done).resolves.toMatchObject({
      wasAborted: false,
      finishReason: "done",
    });
  });
});
