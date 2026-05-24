import { describe, expect, it } from "vitest";
import { applyDeploymentRuntimeOverrides, providerApiBaseOverrideKeys } from "../../src/config/runtime-overrides";
import type { Deployment } from "../../src/config/schema";

function deployment(overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: "nim-primary-key-1",
    group: "nim-primary",
    provider: "nvidia_nim",
    model: "glm-5.1",
    providerModel: "z-ai/glm-5.1",
    keyRef: "NIM_KEY_1",
    apiBase: "https://integrate.api.nvidia.com/v1",
    rpm: 10,
    maxParallelRequests: 2,
    timeout: 30,
    streamTimeout: 120,
    supportsStreaming: true,
    capabilities: {
      toolCalling: "native",
      streamingWithTools: "native",
      jsonMode: "native",
      reasoning: "native",
      multimodal: "none",
    },
    contextWindow: 128000,
    hidden: false,
    ...overrides,
  };
}

describe("runtime deployment overrides", () => {
  it("keeps manifest deployment unchanged when no override is configured", () => {
    const original = deployment();
    const resolved = applyDeploymentRuntimeOverrides(original, {});

    expect(resolved).toBe(original);
    expect(resolved.apiBase).toBe("https://integrate.api.nvidia.com/v1");
  });

  it("prefers deployment-specific provider API base overrides", () => {
    const resolved = applyDeploymentRuntimeOverrides(deployment(), {
      PROVIDER_API_BASE_NIM_PRIMARY_KEY_1: "https://fixture.example/deployment",
      PROVIDER_API_BASE_GROUP_NIM_PRIMARY: "https://fixture.example/group",
      PROVIDER_API_BASE_ALL: "https://fixture.example/all",
    });

    expect(resolved.apiBase).toBe("https://fixture.example/deployment");
  });

  it("falls back through group, provider, then global API base overrides", () => {
    const original = deployment();

    expect(applyDeploymentRuntimeOverrides(original, {
      PROVIDER_API_BASE_GROUP_NIM_PRIMARY: "https://fixture.example/group",
      PROVIDER_API_BASE_PROVIDER_NVIDIA_NIM: "https://fixture.example/provider",
      PROVIDER_API_BASE_ALL: "https://fixture.example/all",
    }).apiBase).toBe("https://fixture.example/group");

    expect(applyDeploymentRuntimeOverrides(original, {
      PROVIDER_API_BASE_PROVIDER_NVIDIA_NIM: "https://fixture.example/provider",
      PROVIDER_API_BASE_ALL: "https://fixture.example/all",
    }).apiBase).toBe("https://fixture.example/provider");

    expect(applyDeploymentRuntimeOverrides(original, {
      PROVIDER_API_BASE_ALL: "https://fixture.example/all",
    }).apiBase).toBe("https://fixture.example/all");
  });

  it("documents deterministic override key order", () => {
    expect(providerApiBaseOverrideKeys(deployment())).toEqual([
      "PROVIDER_API_BASE_NIM_PRIMARY_KEY_1",
      "PROVIDER_API_BASE_GROUP_NIM_PRIMARY",
      "PROVIDER_API_BASE_PROVIDER_NVIDIA_NIM",
      "PROVIDER_API_BASE_ALL",
    ]);
  });
});
