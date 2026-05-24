import { describe, expect, it, vi } from "vitest";
import { executeAttemptLoop, type AttemptResult } from "../../src/attempts/attempt-loop";
import { MANIFEST } from "../../src/config/manifest";
import type { Deployment, Policy } from "../../src/config/schema";
import type { ExecutionPlan, RequestEnvelope } from "../../src/planner/planner";

function makeDeployment(id: string, providerModel: string): Deployment {
  return {
    id,
    group: "nim-primary",
    provider: "nvidia_nim",
    model: "glm-5.1",
    providerModel,
    keyRef: `${id.toUpperCase()}_KEY`,
    apiBase: "https://example.test/v1",
    rpm: 35,
    maxParallelRequests: 2,
    timeout: 30,
    streamTimeout: 120,
    supportsStreaming: true,
    capabilities: {
      toolCalling: "best_effort",
      streamingWithTools: "best_effort",
      jsonMode: "broken",
      reasoning: "native",
      multimodal: "none",
    },
    contextWindow: 128000,
    hidden: false,
  };
}

function makePolicy(onlyWhenSuspect = true, hedgeDelayMs = 0): Policy {
  const policy = structuredClone(MANIFEST.policies["nim-primary"]);
  policy.retry.hedge = { enabled: true, maxCandidates: 2, onlyWhenSuspect, hedgeDelayMs };
  policy.retry.transportRetries = 0;
  policy.retry.semanticRetries = 0;
  return policy;
}

function makeEnvelope(overrides: Partial<RequestEnvelope> = {}): RequestEnvelope {
  return {
    requestId: "req-hedge",
    originalModel: "nim-primary",
    body: { model: "nim-primary", messages: [{ role: "user", content: "hello" }] },
    stream: false,
    hasTools: false,
    hasStrictTools: false,
    isMultiTool: false,
    hasTypedContent: false,
    requiresJsonMode: false,
    requiresReasoning: true,
    ...overrides,
  };
}

function makePlan(policy: Policy, deployments: Deployment[]): ExecutionPlan {
  return {
    requestId: "req-hedge",
    originalModel: "nim-primary",
    canonicalTarget: "nim-primary",
    selectedGroup: "nim-primary",
    selectedPolicy: policy,
    selectedDeployments: deployments,
    fallbackSequence: [],
    transforms: [],
    receipt: {
      requestId: "req-hedge",
      timestamp: Date.now(),
      originalModel: "nim-primary",
      canonicalTarget: "nim-primary",
      selectedGroup: "nim-primary",
      fallbackGroups: [],
      attempts: [],
    },
    isManaged: true,
  };
}

function makeState(health: Record<string, unknown>) {
  let reservationId = 0;
  return {
    admit: vi.fn(async (req: { candidates: Array<{ deploymentId: string; keyRef: string }> }) => {
      const candidate = req.candidates[0];
      if (!candidate) return { admitted: false, rejected: [] };
      reservationId += 1;
      return {
        admitted: true,
        deploymentId: candidate.deploymentId,
        keyRef: candidate.keyRef,
        reservationId: `res-${reservationId}`,
        inflightAtDispatch: 0,
        effectiveMaxParallel: 2,
      };
    }),
    confirm: vi.fn(async () => {}),
    recordSuccess: vi.fn(async () => {}),
    recordFailure: vi.fn(async () => {}),
    recordTokenUsage: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    getHealth: vi.fn(async () => health),
    recordRouteDispatch: vi.fn(async () => {}),
    storeUsageEvent: vi.fn(async () => {}),
  };
}

function stubFetchByModel(delays: Record<string, number>) {
  return vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    const model = body.model ?? "unknown";
    const delayMs = delays[model] ?? 0;
    return new Promise<Response>((resolve, reject) => {
      const timer = setTimeout(() => {
        resolve(new Response(JSON.stringify({
          id: `chatcmpl-${model}`,
          object: "chat.completion",
          model,
          choices: [{
            index: 0,
            message: { role: "assistant", content: `This is a complete valid answer from ${model}.` },
            finish_reason: "stop",
          }],
          usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
        }), { status: 200, headers: { "Content-Type": "application/json" } }));
      }, delayMs);
      init?.signal?.addEventListener("abort", () => {
        clearTimeout(timer);
        reject(new DOMException("Aborted", "AbortError"));
      }, { once: true });
    });
  });
}

function stubStreamingFetch(firstByteDelays: Record<string, number>) {
  return vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as { model?: string };
    const model = body.model ?? "unknown";
    const delayMs = firstByteDelays[model] ?? 0;
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const onAbort = () => {
          if (timer) clearTimeout(timer);
          try { controller.error(new DOMException("Aborted", "AbortError")); } catch {}
        };
        if (init?.signal?.aborted) {
          onAbort();
          return;
        }
        init?.signal?.addEventListener("abort", onAbort, { once: true });
        const enqueue = (chunk: object) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
        };
        const startFirst = () => {
          // Pre-buffer needs ≥4 chunks to commit
          for (let i = 0; i < 5; i++) {
            enqueue({
              id: `chatcmpl-${model}`,
              object: "chat.completion.chunk",
              model,
              choices: [{ index: 0, delta: { content: `tok${i}-${model} ` }, finish_reason: null }],
            });
          }
          enqueue({
            id: `chatcmpl-${model}`,
            object: "chat.completion.chunk",
            model,
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
            usage: { prompt_tokens: 5, completion_tokens: 8, total_tokens: 13 },
          });
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        };
        if (delayMs > 0) timer = setTimeout(startFirst, delayMs);
        else startFirst();
      },
    });
    return Promise.resolve(new Response(stream, {
      status: 200,
      headers: { "Content-Type": "text/event-stream" },
    }));
  });
}

describe("hedged non-streaming execution", () => {
  it("races suspect NVIDIA candidates and accepts the first valid winner", async () => {
    const slow = makeDeployment("slow", "slow-model");
    const fast = makeDeployment("fast", "fast-model");
    const policy = makePolicy(true);
    const envelope = makeEnvelope();
    const plan = makePlan(policy, [slow, fast]);
    const state = makeState({ circuits: { [slow.id]: { state: "suspect" } }, healthScores: {} });
    const fetchMock = stubFetchByModel({ "slow-model": 50, "fast-model": 1 });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await executeAttemptLoop(
        envelope,
        plan,
        state as unknown as Parameters<typeof executeAttemptLoop>[2],
        { SLOW_KEY: "slow-key", FAST_KEY: "fast-key" },
        AbortSignal.timeout(5_000),
      ) as AttemptResult;

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      const body = await result.response!.json() as { model: string };
      expect(body.model).toBe("fast-model");
      expect(result.attempts.some((attempt) => attempt.deploymentId === "fast" && attempt.action === "accept")).toBe(true);
      expect(state.recordSuccess).toHaveBeenCalledWith("fast", expect.any(Number), expect.any(Number), expect.any(Object), expect.any(Object));
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("does not hedge when the policy requires suspect health and no deployment is suspect", async () => {
    const slow = makeDeployment("slow", "slow-model");
    const fast = makeDeployment("fast", "fast-model");
    const policy = makePolicy(true);
    const envelope = makeEnvelope();
    const plan = makePlan(policy, [slow, fast]);
    const state = makeState({ circuits: {}, healthScores: {} });
    const fetchMock = stubFetchByModel({ "slow-model": 1, "fast-model": 1 });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await executeAttemptLoop(
        envelope,
        plan,
        state as unknown as Parameters<typeof executeAttemptLoop>[2],
        { SLOW_KEY: "slow-key", FAST_KEY: "fast-key" },
        AbortSignal.timeout(5_000),
      );

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("skips lane 2 when lane 1 wins before hedgeDelayMs elapses", async () => {
    const fast = makeDeployment("fast", "fast-model");
    const slow = makeDeployment("slow", "slow-model");
    // hedgeDelayMs=200ms; lane 1 finishes in ~5ms so lane 2 should never fire.
    const policy = makePolicy(true, 200);
    const envelope = makeEnvelope();
    const plan = makePlan(policy, [fast, slow]);
    const state = makeState({ circuits: { [fast.id]: { state: "suspect" } }, healthScores: {} });
    const fetchMock = stubFetchByModel({ "fast-model": 5, "slow-model": 5 });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await executeAttemptLoop(
        envelope,
        plan,
        state as unknown as Parameters<typeof executeAttemptLoop>[2],
        { FAST_KEY: "fast-key", SLOW_KEY: "slow-key" },
        AbortSignal.timeout(5_000),
      ) as AttemptResult;

      expect(result.success).toBe(true);
      // Only one upstream fetch should fire because lane 1 won during stagger window.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The skipped lane's reservation must be released.
      expect(state.release).toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("hedged streaming execution", () => {
  it("races two streaming lanes and commits the first one to pre-buffer", async () => {
    const slow = makeDeployment("slow", "slow-model");
    const fast = makeDeployment("fast", "fast-model");
    const policy = makePolicy(true);
    const envelope = makeEnvelope({
      stream: true,
      body: { model: "nim-primary", messages: [{ role: "user", content: "hi" }], stream: true },
    });
    const plan = makePlan(policy, [slow, fast]);
    const state = makeState({ circuits: { [slow.id]: { state: "suspect" } }, healthScores: {} });
    const fetchMock = stubStreamingFetch({ "slow-model": 50, "fast-model": 1 });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const result = await executeAttemptLoop(
        envelope,
        plan,
        state as unknown as Parameters<typeof executeAttemptLoop>[2],
        { SLOW_KEY: "slow-key", FAST_KEY: "fast-key" },
        AbortSignal.timeout(5_000),
      ) as AttemptResult;

      expect(result.success).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The slow loser is released after cancellation, while the fast winner is
      // held until stream consumption finishes.
      expect(state.release).toHaveBeenCalledWith("res-1");
      expect(state.release).not.toHaveBeenCalledWith("res-2");
      // The user-facing stream should contain the fast lane's tokens
      const text = await result.response!.text();
      expect(text).toContain("fast-model");
      expect(text).toContain("[DONE]");
      // Winner attempt is recorded
      expect(result.attempts.some((a) => a.deploymentId === "fast" && a.action === "accept")).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(state.release).toHaveBeenCalledWith("res-2");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
