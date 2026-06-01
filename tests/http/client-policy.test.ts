import { describe, it, expect } from "vitest";
import { authorizeModelForClient, visibleModelsForClient, type ClientIdentity } from "../../src/http/client-policy";

function clientWithPolicy(policy: ClientIdentity["policy"]): ClientIdentity {
  return {
    clientId: "test",
    policyId: "default",
    policyVersion: "default:v1",
    policy,
    authSource: "client_keys_json",
  };
}

describe("oauthExcludedModels", () => {
  it("denies all models for a provider when wildcard is set", () => {
    const client = clientWithPolicy({
      allowHiddenRoutes: true,
      oauthExcludedModels: { anthropic: ["*"] },
    });
    const result = authorizeModelForClient("claude-opus-4-7", client);
    expect(result.allowed).toBe(false);
    if (!result.allowed) expect(result.reason).toBe("oauth_provider_excluded");
  });

  it("allows non-excluded providers", () => {
    const client = clientWithPolicy({
      allowHiddenRoutes: true,
      oauthExcludedModels: { anthropic: ["*"] },
    });
    expect(authorizeModelForClient("gpt-5.5", client).allowed).toBe(true);
  });

  it("exposes billing_class and metadata on visible models", () => {
    const client = clientWithPolicy({ allowedModels: ["free", "smart-route"] });
    const models = visibleModelsForClient(client);
    const free = models.find((m) => m.id === "free");
    expect(free?.billing_class).toBe("free");
    expect(free?.metadata?.billing_class).toBe("free");
    const smart = models.find((m) => m.id === "smart-route");
    expect(smart?.billing_class).toBe("subscription");
  });

  it("exposes free_tier on multiplex free aliases from child deployments", () => {
    const client = clientWithPolicy({
      allowedModels: ["meta-llama/llama-3.3-70b-instruct:free"],
    });
    const models = visibleModelsForClient(client);
    const entry = models.find((m) => m.id === "meta-llama/llama-3.3-70b-instruct:free");
    expect(entry?.free_tier).toBe("catalog_zero");
    expect(entry?.metadata?.free_tier).toBe("catalog_zero");
  });
});
