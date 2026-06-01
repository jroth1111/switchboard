import { describe, it, expect } from "vitest";
import {
  manifestCredentialIds,
  resolvedCredentialIds,
  runtimeCredentialIds,
} from "../../src/credentials/manifest-ids";
import type { Deployment } from "../../src/config/schema";

function baseDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "deploy-1",
    group: "test-group",
    provider: "nvidia_nim",
    model: "test",
    providerModel: "test",
    keyRef: "NIM_KEY_1",
    rpm: 10,
    maxParallelRequests: 1,
    timeout: 30,
    streamTimeout: 120,
    supportsStreaming: true,
    capabilities: {
      toolCalling: "native",
      streamingWithTools: "native",
      jsonMode: "native",
      reasoning: "native",
      multimodal: "native",
    },
    contextWindow: 128000,
    hidden: false,
    ...overrides,
  };
}

describe("manifestCredentialIds", () => {
  it("includes keyRef, credentialPool, and accountIds", () => {
    const ids = manifestCredentialIds(baseDeployment({
      keyRef: "NIM_KEY_1",
      credentialPool: ["NIM_KEY_2", "NIM_KEY_3"],
      accountIds: ["oauth-acct-1"],
    }));
    expect(ids.sort()).toEqual(["NIM_KEY_1", "NIM_KEY_2", "NIM_KEY_3", "oauth-acct-1"].sort());
  });

  it("runtimeCredentialIds adds discovered NIM keys from env", () => {
    const ids = runtimeCredentialIds(baseDeployment({ keyRef: "NIM_KEY_1" }), {
      NIM_KEY_1: "a",
      NIM_KEY_2: "b",
      NIM_KEY_4: "d",
    });
    expect(ids.sort()).toEqual(["NIM_KEY_1", "NIM_KEY_2", "NIM_KEY_4"].sort());
  });

  it("runtimeCredentialIds adds discovered OpenRouter keys from env", () => {
    const deployment = baseDeployment({
      provider: "openai",
      keyRef: "OPENROUTER_API_KEY_1",
      apiBase: "https://openrouter.ai/api/v1",
    });
    const ids = runtimeCredentialIds(deployment, {
      OPENROUTER_API_KEY_1: "a",
      OPENROUTER_API_KEY_2: "b",
    });
    expect(ids.sort()).toEqual(["OPENROUTER_API_KEY_1", "OPENROUTER_API_KEY_2"].sort());
  });

  it("resolvedCredentialIds includes Anthropic OAuth account list from env", async () => {
    const deployment = baseDeployment({
      provider: "anthropic_subscription",
      keyRef: "ANTHROPIC_OAUTH_ACCOUNT",
      accountIds: ["primary-account"],
    });
    const ids = await resolvedCredentialIds(deployment, {
      ANTHROPIC_OAUTH_ACCOUNT: "primary-account",
      ANTHROPIC_OAUTH_ACCOUNTS: "extra-account,third-account",
    });
    expect(ids).toContain("primary-account");
    expect(ids).toContain("extra-account");
    expect(ids).toContain("third-account");
  });
});
