import { describe, it, expect } from "vitest";
import { authorizeModelForClient, type ClientIdentity } from "../../src/http/client-policy";

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
});
