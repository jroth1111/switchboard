import { describe, it, expect } from "vitest";
import { resolveCredentialPool } from "../../src/credentials/resolve-pool";
import type { Deployment } from "../../src/config/schema";

function structuredChatGPTAuth(accessToken = "access-secret"): string {
  return JSON.stringify({
    access_token: accessToken,
    refresh_token: "refresh-secret",
    id_token: "id-secret",
    account_id: "acct-test",
  });
}

function chatgptDeployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "chatgpt-subscription-gpt-5.5-high-key-1",
    group: "chatgpt-subscription-gpt-5.5-high",
    provider: "chatgpt",
    mode: "responses",
    model: "gpt-5.5",
    providerModel: "gpt-5.5",
    keyRef: "CHATGPT_AUTH_JSON",
    rpm: 100,
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
    contextWindow: 400000,
    hidden: true,
    ...overrides,
  };
}

describe("resolveCredentialPool", () => {
  it("includes explicit NIM credentialPool keys for NIM deployments", async () => {
    const deployment: Deployment = {
      id: "nim-primary-key-1",
      group: "nim-primary",
      provider: "nvidia_nim",
      model: "glm-5.1",
      providerModel: "z-ai/glm-5.1",
      keyRef: "NIM_KEY_1",
      credentialPool: ["NIM_KEY_2", "NIM_KEY_3"],
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
    };
    const env = {
      NIM_KEY_1: "secret-1",
      NIM_KEY_2: "secret-2",
      NIM_KEY_3: "secret-3",
    };
    const pool = await resolveCredentialPool(deployment, env, "req-1");
    expect(pool).toHaveLength(3);
    expect(pool.map((s) => s.credentialId)).toEqual(expect.arrayContaining(["NIM_KEY_1", "NIM_KEY_2", "NIM_KEY_3"]));
  });

  it("discovers multiple OpenRouter keys for free-route openai deployments", async () => {
    const deployment: Deployment = {
      id: "free-or-test",
      group: "free-openrouter",
      provider: "openai",
      model: "meta-llama",
      providerModel: "meta-llama/llama:free",
      keyRef: "OPENROUTER_API_KEY_1",
      apiBase: "https://openrouter.ai/api/v1",
      rpm: 20,
      maxParallelRequests: 1,
      timeout: 500,
      streamTimeout: 500,
      supportsStreaming: true,
      capabilities: {
        toolCalling: "best_effort",
        streamingWithTools: "best_effort",
        jsonMode: "native",
        reasoning: "none",
        multimodal: "none",
      },
      contextWindow: 128000,
      hidden: false,
      billingClass: "free",
    };
    const env = {
      OPENROUTER_API_KEY_1: "sk-1",
      OPENROUTER_API_KEY_2: "sk-2",
    };
    const pool = await resolveCredentialPool(deployment, env, "req-or");
    expect(pool).toHaveLength(2);
    expect(pool[0]?.credentialId).toBe("OPENROUTER_API_KEY_1");
    expect(pool.map((s) => s.credentialId)).toContain("OPENROUTER_API_KEY_2");
  });

  it("orders anthropic accounts with primary first", async () => {
    const deployment: Deployment = {
      id: "anthropic-subscription-opus-4-7-low-key-1",
      group: "anthropic-subscription-opus-4-7-low",
      provider: "anthropic_subscription",
      model: "claude-opus-4-7",
      providerModel: "claude-opus-4-7",
      keyRef: "ANTHROPIC_OAUTH_ACCOUNT",
      apiBase: "https://api.anthropic.com",
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
      contextWindow: 200000,
      hidden: true,
      accountIds: ["extra-account"],
    };
    const env = {
      ANTHROPIC_OAUTH_ACCOUNT: "primary-account",
      ANTHROPIC_OAUTH_ACCOUNTS: "extra-account,third-account",
    };
    const pool = await resolveCredentialPool(deployment, env, "req-anthropic");
    expect(pool[0]).toMatchObject({ kind: "anthropic_oauth", accountId: "primary-account" });
    expect(pool.map((s) => s.credentialId)).toContain("extra-account");
  });

  it("keeps anthropic account order stable across requestId", async () => {
    const deployment: Deployment = {
      id: "anthropic-subscription-opus-4-7-low-key-1",
      group: "anthropic-subscription-opus-4-7-low",
      provider: "anthropic_subscription",
      model: "claude-opus-4-7",
      providerModel: "claude-opus-4-7",
      keyRef: "ANTHROPIC_OAUTH_ACCOUNT",
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
      contextWindow: 200000,
      hidden: true,
      accountIds: ["extra-account"],
    };
    const env = {
      ANTHROPIC_OAUTH_ACCOUNT: "primary-account",
      ANTHROPIC_OAUTH_ACCOUNTS: "extra-account,third-account",
    };
    const orderA = (await resolveCredentialPool(deployment, env, "req-a")).map((s) => s.credentialId);
    const orderB = (await resolveCredentialPool(deployment, env, "req-b")).map((s) => s.credentialId);
    expect(orderA).toEqual(orderB);
    expect(orderA[0]).toBe("primary-account");
  });

  it("keeps CHATGPT_AUTH_JSON first regardless of requestId", async () => {
    const deployment = chatgptDeployment({
      credentialPool: ["CHATGPT_AUTH_POOL_KEY"],
    });
    const env = {
      CHATGPT_AUTH_JSON: structuredChatGPTAuth("primary"),
      CHATGPT_AUTH_FILE: structuredChatGPTAuth("file"),
      CHATGPT_AUTH_POOL_KEY: structuredChatGPTAuth("pool"),
      CHATGPT_AUTH_ACCOUNTS: JSON.stringify(["CHATGPT_AUTH_ACCOUNT_1"]),
      CHATGPT_AUTH_ACCOUNT_1: structuredChatGPTAuth("listed"),
    };
    for (const requestId of ["req-a", "req-b", "req-c", undefined]) {
      const pool = await resolveCredentialPool(deployment, env, requestId);
      expect(pool[0]).toMatchObject({ kind: "chatgpt_oauth", credentialId: "CHATGPT_AUTH_JSON" });
    }
  });

  it("includes label-only chatgpt slots when env material is absent (DO-backed)", async () => {
    const deployment = chatgptDeployment({
      credentialPool: ["CHATGPT_AUTH_POOL_KEY"],
    });
    const pool = await resolveCredentialPool(deployment, {}, "req-do-only");
    expect(pool.map((s) => s.credentialId)).toEqual([
      "CHATGPT_AUTH_JSON",
      "CHATGPT_AUTH_FILE",
      "CHATGPT_AUTH_POOL_KEY",
    ]);
    expect(pool.every((s) => s.kind === "chatgpt_oauth")).toBe(true);
    if (pool[0]?.kind === "chatgpt_oauth") {
      expect(pool[0].material).toBe("");
    }
  });

  it("orders chatgpt credentials by stable insertion order", async () => {
    const deployment = chatgptDeployment({
      credentialPool: ["CHATGPT_AUTH_POOL_KEY"],
    });
    const env = {
      CHATGPT_AUTH_JSON: structuredChatGPTAuth("primary"),
      CHATGPT_AUTH_FILE: structuredChatGPTAuth("file"),
      CHATGPT_AUTH_POOL_KEY: structuredChatGPTAuth("pool"),
      CHATGPT_AUTH_ACCOUNTS: JSON.stringify(["CHATGPT_AUTH_ACCOUNT_1"]),
      CHATGPT_AUTH_ACCOUNT_1: structuredChatGPTAuth("listed"),
    };
    const pool = await resolveCredentialPool(deployment, env, "req-rotate-me");
    expect(pool.map((s) => s.credentialId)).toEqual([
      "CHATGPT_AUTH_JSON",
      "CHATGPT_AUTH_FILE",
      "CHATGPT_AUTH_POOL_KEY",
      "CHATGPT_AUTH_ACCOUNT_1",
    ]);
  });

  it("keeps deployment keyRef first for NIM api key pools", async () => {
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
    const env = { NIM_KEY_1: "a", NIM_KEY_2: "b", NIM_KEY_3: "c" };
    const pool = await resolveCredentialPool(deployment, env, "req-spread");
    expect(pool[0]?.credentialId).toBe("NIM_KEY_1");
    expect(pool.map((s) => s.credentialId)).toEqual(["NIM_KEY_1"]);
  });

  it("includes only explicit NIM credentialPool keys beyond keyRef", async () => {
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
      credentialPool: ["NIM_KEY_2", "NIM_KEY_3"],
    };
    const env = { NIM_KEY_1: "a", NIM_KEY_2: "b", NIM_KEY_3: "c", NIM_KEY_9: "other" };
    const pool = await resolveCredentialPool(deployment, env, "req-pool");
    expect(pool.map((s) => s.credentialId)).toEqual(["NIM_KEY_1", "NIM_KEY_2", "NIM_KEY_3"]);
  });

  it("merges credentialPool alias with accountIds", async () => {
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
      credentialPool: ["NIM_KEY_9"],
    };
    const env = { NIM_KEY_1: "a", NIM_KEY_9: "b" };
    const pool = await resolveCredentialPool(deployment, env, undefined);
    expect(pool.map((s) => s.credentialId).sort()).toEqual(["NIM_KEY_1", "NIM_KEY_9"]);
  });
});
