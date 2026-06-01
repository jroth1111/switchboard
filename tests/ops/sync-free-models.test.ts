import { describe, it, expect, vi } from "vitest";
import {
  buildFreeCatalogSuggestions,
  collectFreeModelSuggestions,
  computeFreeCatalogFingerprint,
  FUTURE_FREE_PROVIDER_STUBS,
  probeFreeModelEndpoint,
  resolveFreeModelEndpoints,
} from "../../src/ops/sync-free-models";

describe("sync-free-models", () => {
  it("documents future provider stubs without probing them", () => {
    expect(FUTURE_FREE_PROVIDER_STUBS.some((s) => s.provider === "grok")).toBe(true);
  });
  it("resolves catalog endpoints (groq only when GROQ_API_KEY_1 is set)", () => {
    const without = resolveFreeModelEndpoints({});
    expect(without.map((e) => e.provider)).toEqual(["openrouter", "kilo", "opencode_zen"]);

    const withKey = resolveFreeModelEndpoints({ GROQ_API_KEY_1: "gsk_test" });
    expect(withKey.map((e) => e.provider)).toEqual(["openrouter", "kilo", "opencode_zen", "groq"]);
    expect(withKey.find((e) => e.provider === "groq")?.authBearer).toBe("gsk_test");
  });

  it("filters openrouter models to zero prompt and completion pricing", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [
        { id: "paid/model", pricing: { prompt: "0.5", completion: "1" } },
        { id: "free/model", pricing: { prompt: "0", completion: "0" } },
        { id: "free/zero-num", pricing: { prompt: 0, completion: 0 } },
        { id: "fake-free/prompt-only", pricing: { prompt: "0", completion: "1" } },
        { id: "google/lyria-3-pro-preview", pricing: { prompt: "0", completion: "0" } },
        { id: "no-pricing" },
      ],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const hits = await probeFreeModelEndpoint(
      { provider: "openrouter", url: "https://example.test/models", freeSignal: "pricing.prompt==0 && pricing.completion==0" },
      fetchMock,
    );
    expect(hits.map((h) => h.modelId).sort()).toEqual(["free/model", "free/zero-num"]);
    expect(hits.every((h) => h.billingClass === "free" && h.freeTier === "catalog_zero")).toBe(true);
  });

  it("skips groq probe without auth bearer", async () => {
    const fetchMock = vi.fn();
    const hits = await probeFreeModelEndpoint(
      { provider: "groq", url: "https://example.test/models", freeSignal: "groq_free_tier" },
      fetchMock,
    );
    expect(hits).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("computes stable fingerprint from models and nim groups", () => {
    const fp = computeFreeCatalogFingerprint({
      models: [{ provider: "kilo", modelId: "kilo-auto/free", freeSignal: "x", billingClass: "free", freeTier: "kilo_gateway", keylessEligible: true }],
      nimRouteGroups: ["nim-primary"],
      providersEnabled: { openrouter: false, groq: false, nim: true, kilo: true, opencodeZen: false },
    });
    expect(fp).toMatch(/^[a-f0-9]{64}$/);
  });

  it("buildFreeCatalogSuggestions includes fingerprint and providersEnabled", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("openrouter")) {
        return new Response(JSON.stringify({
          data: [{ id: "or-free", pricing: { prompt: "0", completion: "0" } }],
        }), { status: 200 });
      }
      if (String(url).includes("kilo")) {
        return new Response(JSON.stringify({ data: [{ id: "kilo-auto/free", isFree: true }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });

    const catalog = await buildFreeCatalogSuggestions(fetchMock, {}, []);
    expect(catalog.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(catalog.models.length).toBeGreaterThan(0);
    expect(catalog.providersEnabled).toBeDefined();
  });

  it("aggregates openrouter free hits and groq when key is present", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("openrouter")) {
        return new Response(JSON.stringify({
          data: [
            { id: "or-paid", pricing: { prompt: "1" } },
            { id: "or-free", pricing: { prompt: "0", completion: "0" } },
          ],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({
        data: [
          { id: "llama-3.1-8b-instant" },
          { id: "llama-paid", pricing: { prompt: "0.1", completion: "0.2" } },
          { id: "whisper-large-v3" },
        ],
      }), { status: 200 });
    });

    const all = await collectFreeModelSuggestions(fetchMock, { GROQ_API_KEY_1: "gsk_test" });
    expect(all.some((h) => h.provider === "openrouter" && h.modelId === "or-free")).toBe(true);
    const groqHits = all.filter((h) => h.provider === "groq");
    expect(groqHits.map((h) => h.modelId)).toEqual(["llama-3.1-8b-instant"]);
    expect(groqHits.every((h) => h.keylessEligible === undefined)).toBe(true);
  });
});
