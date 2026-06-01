import { describe, it, expect } from "vitest";
import { resolveFreeProviderAvailability } from "../../src/ops/free-provider-availability";

describe("resolveFreeProviderAvailability", () => {
  it("requires openrouter keys for openrouter inference", () => {
    const without = resolveFreeProviderAvailability({});
    expect(without.openrouter.catalogProbe).toBe(true);
    expect(without.openrouter.inference).toBe(false);

    const withKey = resolveFreeProviderAvailability({ OPENROUTER_API_KEY_1: "sk-or" });
    expect(withKey.openrouter.inference).toBe(true);
  });

  it("enables kilo when keyless models are probed", () => {
    const avail = resolveFreeProviderAvailability({}, { keylessKilo: ["kilo-auto/free"] });
    expect(avail.kilo.inference).toBe(true);
    expect(avail.kilo.keylessModels).toEqual(["kilo-auto/free"]);
  });

  it("enables opencode zen with key or keyless models", () => {
    expect(resolveFreeProviderAvailability({}, { keylessOpencodeZen: ["deepseek-v4-flash-free"] }).opencodeZen.inference).toBe(true);
    expect(resolveFreeProviderAvailability({ OPENCODE_API_KEY_1: "zen" }).opencodeZen.inference).toBe(true);
  });

  it("requires groq key for catalog and inference", () => {
    expect(resolveFreeProviderAvailability({}).groq.catalogProbe).toBe(false);
    expect(resolveFreeProviderAvailability({ GROQ_API_KEY_1: "gsk" }).groq.inference).toBe(true);
  });
});
