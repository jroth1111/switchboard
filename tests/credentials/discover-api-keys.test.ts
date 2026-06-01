import { describe, expect, it } from "vitest";
import {
  discoverNumberedKeyRefs,
  discoverProviderApiKeyRefs,
  hasProviderApiKeys,
  inferApiKeyProviderId,
  parseBootstrapSecrets,
  resolveApiKeySecret,
} from "../../src/credentials/discover-api-keys";

describe("discover-api-keys", () => {
  it("discovers numbered keys in numeric order", () => {
    const env = {
      OPENROUTER_API_KEY_2: "b",
      OPENROUTER_API_KEY_10: "c",
      OPENROUTER_API_KEY_1: "a",
    };
    expect(discoverNumberedKeyRefs(env, "OPENROUTER_API_KEY")).toEqual([
      "OPENROUTER_API_KEY_1",
      "OPENROUTER_API_KEY_2",
      "OPENROUTER_API_KEY_10",
    ]);
  });

  it("ignores legacy singular env without numbered keys", () => {
    const env = { OPENROUTER_API_KEY: "legacy-sk" };
    expect(discoverProviderApiKeyRefs(env, "openrouter")).toEqual([]);
    expect(resolveApiKeySecret(env, "OPENROUTER_API_KEY_1", "openrouter")).toBe("");
  });

  it("merges bootstrap slots with numbered keys", () => {
    const env = {
      OPENROUTER_API_KEY_1: "numbered",
      OPENROUTER_API_KEYS: "boot-a,boot-b,boot-a",
    };
    const refs = discoverProviderApiKeyRefs(env, "openrouter");
    expect(refs).toContain("OPENROUTER_API_KEY_1");
    expect(refs).toContain("OPENROUTER_API_KEY__bootstrap_1");
    expect(refs).toContain("OPENROUTER_API_KEY__bootstrap_2");
    expect(refs).toHaveLength(3);
    expect(resolveApiKeySecret(env, "OPENROUTER_API_KEY__bootstrap_2", "openrouter")).toBe("boot-b");
  });

  it("parseBootstrapSecrets dedupes and trims", () => {
    expect(parseBootstrapSecrets({ GROQ_API_KEYS: " a , b , a " }, "GROQ_API_KEYS")).toEqual(["a", "b"]);
  });

  it("hasProviderApiKeys requires numbered or bootstrap keys", () => {
    expect(hasProviderApiKeys({ GROQ_API_KEY_1: "x" }, "groq")).toBe(true);
    expect(hasProviderApiKeys({ GROQ_API_KEY: "x" }, "groq")).toBe(false);
    expect(hasProviderApiKeys({ GROQ_API_KEYS: "a,b" }, "groq")).toBe(true);
    expect(hasProviderApiKeys({}, "groq")).toBe(false);
  });

  it("infers provider from apiBase", () => {
    expect(
      inferApiKeyProviderId({
        provider: "openai",
        keyRef: "OPENROUTER_API_KEY_1",
        apiBase: "https://openrouter.ai/api/v1",
      }),
    ).toBe("openrouter");
  });
});
