import { describe, it, expect, vi } from "vitest";
import { probeKeylessInference } from "../../src/ops/probe-keyless-inference";

describe("probeKeylessInference", () => {
  it("returns true when chat completions returns choices", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      choices: [{ message: { role: "assistant", content: "hi" } }],
    }), { status: 200 }));

    const ok = await probeKeylessInference({
      provider: "kilo",
      chatCompletionsUrl: "https://example.test/v1/chat/completions",
      modelId: "kilo-auto/free",
    }, fetchMock);

    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledOnce();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init?.headers).not.toHaveProperty("Authorization");
  });

  it("returns false on non-OK responses", async () => {
    const fetchMock = vi.fn(async () => new Response("unauthorized", { status: 401 }));
    const ok = await probeKeylessInference({
      provider: "opencode_zen",
      chatCompletionsUrl: "https://example.test/v1/chat/completions",
      modelId: "minimax-m2.5-free",
    }, fetchMock);
    expect(ok).toBe(false);
  });
});
