import { describe, it, expect } from "vitest";
import { resolveCredentialRotationSettings } from "../../src/credentials/resolve-settings";
import type { Deployment, Policy } from "../../src/config/schema";
import { MANIFEST } from "../../src/config/manifest";

const DEFAULT_POLICY = MANIFEST.defaultPolicy;

const baseDeployment: Deployment = {
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

describe("resolveCredentialRotationSettings", () => {
  it("defaults nvidia_nim to spread strategy", () => {
    const settings = resolveCredentialRotationSettings("nvidia_nim", baseDeployment, DEFAULT_POLICY, 3, 1);
    expect(settings.strategy).toBe("spread");
    expect(settings.enabled).toBe(true);
    expect(settings.maxAttempts).toBe(3);
  });

  it("applies byProvider overrides", () => {
    const policy: Policy = {
      ...DEFAULT_POLICY,
      credentialRotation: {
        byProvider: {
          nvidia_nim: { strategy: "sequential_exhaust", maxAttempts: 2 },
        },
      },
    };
    const settings = resolveCredentialRotationSettings("nvidia_nim", baseDeployment, policy, 5, 1);
    expect(settings.strategy).toBe("sequential_exhaust");
    expect(settings.maxAttempts).toBe(2);
  });

  it("disables when pool size is 1", () => {
    const settings = resolveCredentialRotationSettings("nvidia_nim", baseDeployment, DEFAULT_POLICY, 1, 1);
    expect(settings.enabled).toBe(false);
  });
});
