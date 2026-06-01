import { describe, it, expect } from "vitest";
import { buildFreeDeployments, buildFreeRouteGroups } from "../../src/config/build-free-routes";
import type { FreeCatalogSuggestions } from "../../src/ops/sync-free-models";

function catalog(overrides: Partial<FreeCatalogSuggestions> = {}): FreeCatalogSuggestions {
  return {
    generatedAt: new Date().toISOString(),
    fingerprint: "test",
    providersEnabled: {
      openrouter: false,
      groq: false,
      nim: false,
      kilo: true,
      opencodeZen: false,
    },
    nimRouteGroups: [],
    models: [
      {
        provider: "kilo",
        modelId: "kilo-auto/free",
        freeSignal: "kilo_gateway",
        billingClass: "free",
        freeTier: "kilo_gateway",
        keylessEligible: true,
      },
      {
        provider: "openrouter",
        modelId: "meta-llama/llama:free",
        freeSignal: "pricing.prompt==0",
        billingClass: "free",
        freeTier: "catalog_zero",
        keylessEligible: false,
      },
    ],
    ...overrides,
  };
}

describe("build-free-routes", () => {
  it("enables multimodal for vision-language free model ids", () => {
    const c = catalog({
      providersEnabled: { openrouter: true, groq: false, nim: false, kilo: false, opencodeZen: false },
      models: [{
        provider: "openrouter",
        modelId: "nvidia/nemotron-nano-12b-v2-vl:free",
        freeSignal: "pricing.prompt==0",
        billingClass: "free",
        freeTier: "catalog_zero",
        keylessEligible: false,
      }],
    });
    const { deployments } = buildFreeDeployments(c, { OPENROUTER_API_KEY_1: "sk-or" });
    expect(deployments[0]?.capabilities.multimodal).toBe("native");
  });

  it("drops non-chat catalog models such as Lyria from generated routes", () => {
    const c = catalog({
      providersEnabled: { openrouter: true, groq: false, nim: false, kilo: true, opencodeZen: false },
      models: [
        ...catalog().models,
        {
          provider: "kilo",
          modelId: "google/lyria-3-pro-preview",
          freeSignal: "kilo_gateway",
          billingClass: "free",
          freeTier: "kilo_gateway",
          keylessEligible: true,
        },
      ],
    });
    const { deployments, aliases } = buildFreeDeployments(c, { OPENROUTER_API_KEY_1: "sk-or" });
    expect(deployments.some((d) => d.providerModel.includes("lyria"))).toBe(false);
    expect(aliases["google/lyria-3-pro-preview"]).toBeUndefined();
  });

  it("omits openrouter deployments without any openrouter key", () => {
    const c = catalog({ providersEnabled: { openrouter: true, groq: false, nim: false, kilo: false, opencodeZen: false } });
    const { deployments, aliases } = buildFreeDeployments(c, {});
    expect(deployments.some((d) => d.group === "free-openrouter")).toBe(false);
    expect(aliases["meta-llama/llama:free"]).toBeUndefined();
  });

  it("includes openrouter when key is set and maps model alias to free", () => {
    const c = catalog({ providersEnabled: { openrouter: true, groq: false, nim: false, kilo: false, opencodeZen: false } });
    const { deployments, aliases } = buildFreeDeployments(c, { OPENROUTER_API_KEY_1: "sk-or" });
    expect(deployments.filter((d) => d.group === "free-openrouter")).toHaveLength(1);
    expect(deployments[0]?.keyRef).toBe("OPENROUTER_API_KEY_1");
    expect(deployments[0]?.freeTier).toBe("catalog_zero");
    expect(aliases["meta-llama/llama:free"]).toBe("free");
  });

  it("places groq and openrouter in the same free fallback chain when both enabled", () => {
    const c = catalog({
      providersEnabled: { openrouter: true, groq: true, nim: false, kilo: true, opencodeZen: false },
    });
    const groups = buildFreeRouteGroups(c);
    expect(groups.free?.fallbacks).toEqual(["free-openrouter", "free-groq"]);
  });

  it("omits nim fallbacks when providersEnabled.nim is false", () => {
    const c = catalog({
      providersEnabled: { openrouter: false, groq: false, nim: false, kilo: true, opencodeZen: false },
      nimRouteGroups: ["nim-primary", "nim-tool-primary"],
    });
    const groups = buildFreeRouteGroups(c);
    const chain = [groups.free?.target, ...(groups.free?.fallbacks ?? [])];
    expect(chain.every((g) => !g?.startsWith("nim-"))).toBe(true);
  });

  it("includes groq deployments only with GROQ_API_KEY_1", () => {
    const c = catalog({
      providersEnabled: { openrouter: false, groq: true, nim: false, kilo: false, opencodeZen: false },
      models: [{
        provider: "groq",
        modelId: "llama-3.3-70b-versatile",
        freeSignal: "groq_free_tier",
        billingClass: "free",
        freeTier: "rate_limited",
        keylessEligible: false,
      }],
    });
    expect(buildFreeDeployments(c, {}).deployments).toHaveLength(0);
    expect(buildFreeDeployments(c, { GROQ_API_KEY_1: "gsk" }).deployments[0]?.group).toBe("free-groq");
    expect(buildFreeDeployments(c, { GROQ_API_KEY_1: "gsk" }).deployments[0]?.keyRef).toBe("GROQ_API_KEY_1");
  });

  it("builds free parent fallbacks in provider order with nim groups last", () => {
    const c = catalog({
      providersEnabled: { openrouter: true, groq: true, nim: true, kilo: true, opencodeZen: true },
      nimRouteGroups: ["nim-primary"],
    });
    const groups = buildFreeRouteGroups(c);
    expect(groups.free?.target).toBe("free-kilo");
    expect(groups.free?.fallbacks).toEqual([
      "free-opencode-zen",
      "free-openrouter",
      "free-groq",
      "nim-primary",
    ]);
    expect(groups["free-kilo"]?.modelPassthrough).toBe(true);
  });

  it("omits nim fallbacks when providersEnabled.nim is false", () => {
    const c = catalog({
      nimRouteGroups: ["nim-primary", "nim-tool-primary"],
      providersEnabled: { openrouter: false, groq: false, nim: false, kilo: true, opencodeZen: true },
    });
    const groups = buildFreeRouteGroups(c);
    expect(groups.free?.fallbacks).toEqual(["free-opencode-zen"]);
    expect(groups.free?.fallbacks?.some((g) => g.startsWith("nim-"))).toBe(false);
  });

  it("marks keyless kilo deployments credentialOptional", () => {
    const { deployments } = buildFreeDeployments(catalog(), {});
    const kilo = deployments.find((d) => d.id.startsWith("free-kilo-"));
    expect(kilo?.credentialOptional).toBe(true);
    expect(kilo?.billingClass).toBe("free");
  });
});
