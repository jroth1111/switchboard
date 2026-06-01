export interface KeylessProbeTarget {
  provider: string;
  chatCompletionsUrl: string;
  modelId: string;
}

const PROBE_BODY = {
  messages: [{ role: "user", content: "Say hi in one word" }],
  max_tokens: 5,
} as const;

export async function probeKeylessInference(
  target: KeylessProbeTarget,
  fetchImpl: typeof fetch = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(target.chatCompletionsUrl, {
      method: "POST",
      signal: AbortSignal.timeout(20000),
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ ...PROBE_BODY, model: target.modelId }),
    });
    if (!res.ok) return false;
    const data = await res.json() as { choices?: unknown[] };
    return Array.isArray(data.choices) && data.choices.length > 0;
  } catch {
    return false;
  }
}

/** Cap keyless probes in CI to keep sync fast. */
export const MAX_KEYLESS_PROBES_PER_PROVIDER = 12;
