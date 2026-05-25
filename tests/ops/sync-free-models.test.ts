import { describe, it, expect, vi } from "vitest";
import { collectFreeModelSuggestions, probeFreeModelEndpoint } from "../../src/ops/sync-free-models";

describe("sync-free-models", () => {
  it("probes model list endpoints", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      data: [{ id: "free-model-1" }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));

    const hits = await probeFreeModelEndpoint(
      { provider: "groq", url: "https://example.test/models", freeSignal: "public_list" },
      fetchMock,
    );
    expect(hits).toEqual([{ provider: "groq", modelId: "free-model-1", freeSignal: "public_list" }]);
  });

  it("aggregates hits from all endpoints", async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).includes("openrouter")) {
        return new Response(JSON.stringify({ data: [{ id: "or-1" }] }), { status: 200 });
      }
      return new Response(JSON.stringify({ data: [] }), { status: 200 });
    });
    const all = await collectFreeModelSuggestions(fetchMock);
    expect(all.some((h) => h.modelId === "or-1")).toBe(true);
  });
});
