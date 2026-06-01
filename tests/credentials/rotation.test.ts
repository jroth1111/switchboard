import { describe, it, expect, vi } from "vitest";
import { executeWithCredentialRotation } from "../../src/credentials/rotation";
import type { ResolvedCredentialRotationSettings } from "../../src/credentials/types";
import type { ApiKeyCredentialSlot } from "../../src/credentials/types";
import type { Deployment } from "../../src/config/schema";

const deployment: Deployment = {
  id: "nim-primary-key-1",
  group: "nim-primary",
  provider: "nvidia_nim",
  model: "glm-5.1",
  providerModel: "z-ai/glm-5.1",
  keyRef: "NIM_KEY_1",
  rpm: 35,
  maxParallelRequests: 2,
  timeout: 500,
  streamTimeout: 500,
  supportsStreaming: true,
  capabilities: {
    toolCalling: "best_effort",
    streamingWithTools: "best_effort",
    jsonMode: "broken",
    reasoning: "native",
    multimodal: "none",
  },
  contextWindow: 128000,
  hidden: false,
};

const settings: ResolvedCredentialRotationSettings = {
  enabled: true,
  strategy: "spread",
  maxAttempts: 2,
  rateLimitCooldownSeconds: 10,
  authFailureCooldownSeconds: 60,
  subscriptionLimitCooldownSeconds: 300,
  networkRetryAttempts: 0,
  rotateOnStatus: [429, 401, 403, 402],
  rotateOnFailureClass: ["rate_limit_overload", "auth_failure"],
};

function slot(id: string): ApiKeyCredentialSlot {
  return { kind: "api_key", credentialId: id, keyRef: id, secret: `secret-${id}` };
}

describe("executeWithCredentialRotation", () => {
  it("rotates to second credential on 429", async () => {
    const pool = [slot("NIM_KEY_1"), slot("NIM_KEY_2")];
    const execute = vi.fn()
      .mockResolvedValueOnce({
        status: 429,
        headers: { "retry-after": "1" },
        body: "rate limited",
        json: null,
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: "{}",
        json: {},
      });

    const health = {
      setCredentialCooldown: vi.fn().mockResolvedValue(undefined),
      clearCredentialCooldown: vi.fn().mockResolvedValue(undefined),
      getCredentialCooldown: vi.fn().mockResolvedValue(null),
    };

    const result = await executeWithCredentialRotation({
      pool,
      settings,
      requestId: "req-rotate",
      deployment,
      health,
      buildRequest: async (s) => ({
        url: "https://example.com",
        method: "POST",
        headers: {},
        body: s.secret,
      }),
      execute,
      getHttpError: (r) => (r.status >= 400 ? r : null),
    });

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(health.setCredentialCooldown).toHaveBeenCalled();
    const bodies = execute.mock.calls.map((call) => call[0].body);
    expect(new Set(bodies)).toEqual(new Set(["secret-NIM_KEY_1", "secret-NIM_KEY_2"]));
  });

  it("loads persisted order for sequential_exhaust", async () => {
    const pool = [slot("NIM_KEY_1"), slot("NIM_KEY_2")];
    const execute = vi.fn().mockResolvedValue({
      status: 200,
      headers: {},
      body: "{}",
      json: {},
    });
    const getCredentialPoolOrder = vi.fn().mockResolvedValue(["NIM_KEY_2", "NIM_KEY_1"]);
    const setCredentialPoolOrder = vi.fn().mockResolvedValue(undefined);

    await executeWithCredentialRotation({
      pool,
      settings: { ...settings, strategy: "sequential_exhaust", maxAttempts: 1 },
      requestId: "req-seq",
      deployment,
      health: {
        getCredentialPoolOrder,
        setCredentialPoolOrder,
        getCredentialCooldown: vi.fn().mockResolvedValue(null),
      },
      buildRequest: async (s) => ({
        url: "https://example.com",
        method: "POST",
        headers: {},
        body: s.secret,
      }),
      execute,
      getHttpError: (r) => (r.status >= 400 ? r : null),
    });

    expect(getCredentialPoolOrder).toHaveBeenCalledWith(deployment.id);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0][0].body).toBe("secret-NIM_KEY_2");
  });

  it("skips credentials when beforeExecute returns false and tries the next key", async () => {
    const pool = [slot("NIM_KEY_1"), slot("NIM_KEY_2")];
    const execute = vi.fn().mockResolvedValue({
      status: 200,
      headers: {},
      body: "{}",
      json: {},
    });
    const beforeExecute = vi.fn(async (s) => s.credentialId !== "NIM_KEY_1");

    const result = await executeWithCredentialRotation({
      pool,
      settings: { ...settings, strategy: "sequential_exhaust" },
      requestId: "req-before-exec-skip",
      deployment,
      buildRequest: async (s) => ({
        url: "https://example.com",
        method: "POST",
        headers: {},
        body: s.secret,
      }),
      execute,
      getHttpError: (r) => (r.status >= 400 ? r : null),
      beforeExecute,
    });

    expect(result.ok).toBe(true);
    expect(beforeExecute).toHaveBeenCalledTimes(2);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(execute.mock.calls[0]?.[0].body).toBe("secret-NIM_KEY_2");
    expect(beforeExecute).toHaveBeenCalledWith(expect.objectContaining({ credentialId: "NIM_KEY_1" }));
    expect(beforeExecute).toHaveBeenCalledWith(expect.objectContaining({ credentialId: "NIM_KEY_2" }));
  });

  it("exhausts with rate_limit_quota_window when beforeExecute rejects all credentials", async () => {
    const pool = [slot("NIM_KEY_1"), slot("NIM_KEY_2")];
    const execute = vi.fn();

    const result = await executeWithCredentialRotation({
      pool,
      settings,
      requestId: "req-before-exec-exhaust",
      deployment,
      buildRequest: async (s) => ({
        url: "https://example.com",
        method: "POST",
        headers: {},
        body: s.secret,
      }),
      execute,
      getHttpError: (r) => (r.status >= 400 ? r : null),
      beforeExecute: vi.fn().mockResolvedValue(false),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exhausted).toBe(true);
      expect(result.lastClassification?.failureClass).toBe("rate_limit_quota_window");
      expect(result.lastClassification?.details).toBe("per_key_token_budget_exhausted");
    }
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns exhausted when all credentials fail", async () => {
    const pool = [slot("NIM_KEY_1"), slot("NIM_KEY_2")];
    const execute = vi.fn().mockResolvedValue({
      status: 429,
      headers: {},
      body: "rate limited",
      json: null,
    });

    const result = await executeWithCredentialRotation({
      pool,
      settings,
      requestId: "req-exhaust",
      deployment,
      buildRequest: async (s) => ({
        url: "https://example.com",
        method: "POST",
        headers: {},
        body: s.secret,
      }),
      execute,
      getHttpError: (r) => (r.status >= 400 ? r : null),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.exhausted).toBe(true);
    }
    expect(execute).toHaveBeenCalledTimes(2);
  });

  it("refreshes the same credential on 401 then succeeds on retry", async () => {
    const pool = [slot("NIM_KEY_1"), slot("NIM_KEY_2")];
    const sequentialSettings: ResolvedCredentialRotationSettings = {
      ...settings,
      strategy: "sequential_exhaust",
    };
    const execute = vi.fn()
      .mockResolvedValueOnce({
        status: 401,
        headers: {},
        body: "unauthorized",
        json: null,
      })
      .mockResolvedValueOnce({
        status: 200,
        headers: {},
        body: "{}",
        json: { ok: true },
      });

    const refresh = vi.fn(async (s: ApiKeyCredentialSlot) => ({
      url: "https://example.com",
      method: "POST" as const,
      headers: { Authorization: `Bearer refreshed-${s.credentialId}` },
      body: `refreshed-${s.credentialId}`,
    }));

    const health = {
      setCredentialCooldown: vi.fn().mockResolvedValue(undefined),
      clearCredentialCooldown: vi.fn().mockResolvedValue(undefined),
      getCredentialCooldown: vi.fn().mockResolvedValue(null),
    };

    const result = await executeWithCredentialRotation({
      pool,
      settings: sequentialSettings,
      requestId: "req-refresh-same",
      deployment,
      health,
      buildRequest: async (s) => ({
        url: "https://example.com",
        method: "POST",
        headers: { Authorization: `Bearer ${s.secret}` },
        body: s.secret,
      }),
      execute,
      refresh,
      getHttpError: (r) => (r.status >= 400 ? r : null),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slot.credentialId).toBe("NIM_KEY_1");
      expect(result.keyRef).toBe("NIM_KEY_1");
    }
    expect(execute).toHaveBeenCalledTimes(2);
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(refresh).toHaveBeenCalledWith(pool[0]);
    expect(execute.mock.calls[1][0].headers.Authorization).toBe("Bearer refreshed-NIM_KEY_1");
    expect(health.clearCredentialCooldown).toHaveBeenCalledWith("NIM_KEY_1");
  });

  it("does not count cooldown skips against maxAttempts", async () => {
    const pool = [slot("NIM_KEY_1"), slot("NIM_KEY_2"), slot("NIM_KEY_3")];
    const execute = vi.fn().mockResolvedValue({
      status: 200,
      headers: {},
      body: "{}",
      json: {},
    });
    const cooledUntil = Date.now() + 60_000;
    const getCredentialCooldown = vi.fn(async (credentialId: string) => {
      if (credentialId === "NIM_KEY_3") return null;
      return { until: cooledUntil, failureClass: "rate_limit_overload" as const };
    });

    const result = await executeWithCredentialRotation({
      pool,
      settings: { ...settings, maxAttempts: 1 },
      requestId: "req-cooldown-skip",
      deployment,
      health: { getCredentialCooldown },
      buildRequest: async (s) => ({
        url: "https://example.com",
        method: "POST",
        headers: {},
        body: s.secret,
      }),
      execute,
      getHttpError: (r) => (r.status >= 400 ? r : null),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slot.credentialId).toBe("NIM_KEY_3");
    }
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("resets transport retries for each credential in the pool", async () => {
    const pool = [slot("NIM_KEY_1"), slot("NIM_KEY_2")];
    const execute = vi.fn()
      .mockRejectedValueOnce(new Error("network blip"))
      .mockRejectedValueOnce(new Error("network blip"))
      .mockResolvedValue({
        status: 200,
        headers: {},
        body: "{}",
        json: {},
      });

    const result = await executeWithCredentialRotation({
      pool,
      settings: { ...settings, networkRetryAttempts: 1, maxAttempts: 2 },
      requestId: "req-transport-per-cred",
      deployment,
      buildRequest: async (s) => ({
        url: "https://example.com",
        method: "POST",
        headers: {},
        body: s.secret,
      }),
      execute,
      getHttpError: (r) => (r.status >= 400 ? r : null),
    });

    expect(result.ok).toBe(true);
    expect(execute).toHaveBeenCalledTimes(3);
    const bodies = execute.mock.calls.map((call) => call[0].body);
    expect(bodies[0]).toBe("secret-NIM_KEY_1");
    expect(bodies[1]).toBe("secret-NIM_KEY_1");
    expect(bodies[2]).toBe("secret-NIM_KEY_2");
  });
});
