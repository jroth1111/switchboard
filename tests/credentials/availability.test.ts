import { describe, it, expect, vi } from "vitest";
import { hasAvailableCredential } from "../../src/credentials/availability";
import { MANIFEST } from "../../src/config/manifest";
import type { Deployment, Policy } from "../../src/config/schema";

function nimDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "nim-primary-key-1",
    group: "nim-primary",
    provider: "nvidia_nim",
    model: "glm-5.1",
    providerModel: "z-ai/glm-5.1",
    keyRef: "NIM_KEY_1",
    apiBase: "https://integrate.api.nvidia.com/v1",
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
    ...overrides,
  };
}

function chatgptDeployment(): Deployment {
  return {
    id: "chatgpt-subscription-gpt-5.5-high-key-1",
    group: "chatgpt-subscription-gpt-5.5-high",
    provider: "chatgpt",
    mode: "responses",
    model: "gpt-5.5",
    providerModel: "gpt-5.5",
    keyRef: "CHATGPT_AUTH_JSON",
    rpm: 10,
    maxParallelRequests: 1,
    timeout: 500,
    streamTimeout: 500,
    supportsStreaming: true,
    capabilities: {
      toolCalling: "native",
      streamingWithTools: "native",
      jsonMode: "native",
      reasoning: "native",
      multimodal: "native",
    },
    contextWindow: 400000,
    hidden: true,
  };
}

describe("hasAvailableCredential", () => {
  const policy: Policy = MANIFEST.policies["nim-primary"] ?? MANIFEST.defaultPolicy;

  it("returns false when the credential pool is empty", async () => {
    const available = await hasAvailableCredential(
      nimDeployment(),
      {},
      policy,
      "req-empty",
      undefined,
    );
    expect(available).toBe(false);
  });

  it("returns true when at least one NIM key has material", async () => {
    const available = await hasAvailableCredential(
      nimDeployment(),
      { NIM_KEY_1: "secret-1", NIM_KEY_2: "secret-2" },
      policy,
      "req-nim",
      undefined,
    );
    expect(available).toBe(true);
  });

  it("returns false for label-only ChatGPT slots without DO or env material", async () => {
    const available = await hasAvailableCredential(
      chatgptDeployment(),
      {},
      MANIFEST.policies["chatgpt-subscription-gpt-5.5-high"] ?? policy,
      "req-chatgpt",
      undefined,
    );
    expect(available).toBe(false);
  });

  it("returns true for legacy CHATGPT_OAUTH-only env", async () => {
    const available = await hasAvailableCredential(
      chatgptDeployment(),
      { CHATGPT_OAUTH: "legacy-token" },
      MANIFEST.policies["chatgpt-subscription-gpt-5.5-high"] ?? policy,
      "req-legacy-oauth",
      undefined,
    );
    expect(available).toBe(true);
  });

  it("returns true for credentialOptional when all pooled keys are on cooldown", async () => {
    const health = {
      getCredentialCooldown: vi.fn(async () => ({
        until: Date.now() + 60_000,
        reason: "rate_limit",
      })),
    };
    const available = await hasAvailableCredential(
      nimDeployment({ credentialOptional: true }),
      { NIM_KEY_1: "secret" },
      policy,
      "req-keyless-cooldown",
      health,
    );
    expect(available).toBe(true);
  });

  it("returns false when every pooled credential is on cooldown", async () => {
    const health = {
      getCredentialCooldown: vi.fn(async (credentialId: string) => ({
        until: Date.now() + 60_000,
        reason: credentialId,
      })),
    };
    const available = await hasAvailableCredential(
      nimDeployment(),
      { NIM_KEY_1: "a", NIM_KEY_2: "b" },
      policy,
      "req-cooldown",
      health,
    );
    expect(available).toBe(false);
  });
});
