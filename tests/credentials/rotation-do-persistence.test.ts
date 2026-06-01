import { describe, it, expect } from "vitest";
import { env } from "cloudflare:test";
import type { ControlPlaneStateDO } from "../../src/state/control-plane-state";
import { executeWithCredentialRotation } from "../../src/credentials/rotation";
import type { ApiKeyCredentialSlot } from "../../src/credentials/types";
import type { Deployment } from "../../src/config/schema";

function getDoStub(name: string): ControlPlaneStateDO {
  const id = env.CONTROL_PLANE_STATE.idFromName(name);
  return env.CONTROL_PLANE_STATE.get(id) as unknown as ControlPlaneStateDO;
}

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

function slot(id: string): ApiKeyCredentialSlot {
  return { kind: "api_key", credentialId: id, keyRef: id, secret: `secret-${id}` };
}

describe("credential rotation with ControlPlaneStateDO", () => {
  it("skips credentials on cooldown across separate rotation calls", async () => {
    const stubName = `rotation-do-${Date.now()}`;
    const stub = getDoStub(stubName);
    const until = Date.now() + 120_000;
    await stub.setCredentialCooldown("NIM_KEY_1", "rate_limit_overload", until);

    const settings = {
      enabled: true,
      strategy: "sequential_exhaust" as const,
      maxAttempts: 2,
      rateLimitCooldownSeconds: 10,
      authFailureCooldownSeconds: 60,
      subscriptionLimitCooldownSeconds: 300,
      networkRetryAttempts: 0,
      rotateOnStatus: [429],
      rotateOnFailureClass: ["rate_limit_overload"] as const,
    };

    const result = await executeWithCredentialRotation({
      pool: [slot("NIM_KEY_1"), slot("NIM_KEY_2")],
      settings,
      requestId: "req-do-rotation",
      deployment,
      health: stub,
      buildRequest: async (s) => ({
        url: "https://example.com",
        method: "POST",
        headers: {},
        body: s.secret,
      }),
      execute: async (req) => ({
        status: 200,
        headers: {},
        body: "{}",
        json: { ok: true, body: req.body },
      }),
      getHttpError: (r) => (r.status >= 400 ? r : null),
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.slot.credentialId).toBe("NIM_KEY_2");
    }
  });
});
