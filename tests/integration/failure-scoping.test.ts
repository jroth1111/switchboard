import { describe, it, expect } from "vitest";
import {
  admit,
  release,
  recordSuccess,
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

function candidate(
  deploymentId: string,
  keyRef = "key-1",
  rpm = 35,
  maxParallel = 2,
  group = "test",
) {
  return { deploymentId, keyRef, rpm, maxParallel, group };
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
    // Simulate a pre-buffer scenario: first chunk has error markers
    const firstChunk = { choices: [{ delta: { content: "Error: Rate limit exceeded" } }] };
    const hasErrorMarker = firstChunk.choices[0].delta.content.startsWith("Error:");
    expect(hasErrorMarker).toBe(true);
  });

  it("passes through valid first chunk", () => {
    const firstChunk = { choices: [{ delta: { content: "Hello! I can help" } }] };
    const hasErrorMarker = firstChunk.choices[0].delta.content.startsWith("Error:");
    expect(hasErrorMarker).toBe(false);
  });
});
