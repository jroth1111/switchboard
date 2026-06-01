import { describe, it, expect } from "vitest";
import { hasAvailableCredential } from "../../src/credentials/availability";
import { MANIFEST } from "../../src/config/manifest";
import type { Deployment } from "../../src/config/schema";

const policy = MANIFEST.defaultPolicy;

describe("credentialOptional", () => {
  it("allows attempts when no pool keys are configured", async () => {
    const deployment: Deployment = {
      id: "free-kilo-test",
      group: "free-kilo",
      provider: "openai",
      model: "test",
      providerModel: "kilo-auto/free",
      keyRef: "KILO_API_KEY_1",
      credentialOptional: true,
      billingClass: "free",
      rpm: 10,
      maxParallelRequests: 1,
      timeout: 60,
      streamTimeout: 60,
      supportsStreaming: true,
      capabilities: {
        toolCalling: "none",
        streamingWithTools: "none",
        jsonMode: "native",
        reasoning: "none",
        multimodal: "none",
      },
      contextWindow: 128000,
      hidden: false,
    };
    await expect(hasAvailableCredential(deployment, {}, policy, "req", undefined)).resolves.toBe(true);
  });
});
