// Provider adapters: execute requests against LLM providers.
// Replaces litellm_logic's LiteLLM provider layer.

import type { Deployment, ProviderType } from "../config/schema";

export interface ProviderRequest {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

export interface ProviderResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
  json: Record<string, unknown> | null;
}

export interface ProviderExecutionContext {
  signal: AbortSignal;
  timeoutMs: number;
  /** If true, return the raw Response without consuming the body. */
  streaming?: boolean;
}

// ─── Build provider request ───────────────────────────────────────

type ChatCompletionsProvider = Extract<ProviderType, "nvidia_nim" | "openai">;

export function buildProviderRequest(
  deployment: Deployment,
  body: Record<string, unknown>,
  apiKey: string,
): ProviderRequest {
  assertChatCompletionsDeployment(deployment);

  const base = normalizeApiBase(deployment.apiBase ?? "https://api.openai.com/v1");
  const url = `${base}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  // Set model name and deployment-level overrides
  const requestBody: Record<string, unknown> = {
    ...body,
    model: deployment.providerModel,
  };

  // Merge deployment params (don't overwrite client values)
  if (deployment.params) {
    for (const [k, v] of Object.entries(deployment.params)) {
      if (!(k in requestBody) && v !== null && v !== undefined) {
        requestBody[k] = v;
      }
    }
  }

  // Merge deployment extraBody (don't overwrite client values)
  if (deployment.extraBody) {
    for (const [k, v] of Object.entries(deployment.extraBody)) {
      if (!(k in requestBody) && v !== null && v !== undefined) {
        requestBody[k] = v;
      }
    }
  }

  // Apply deployment reasoning effort only when client didn't specify one
  if (deployment.reasoningEffort && !Object.prototype.hasOwnProperty.call(requestBody, "reasoning_effort")) {
    requestBody.reasoning_effort = deployment.reasoningEffort;
  }

  return {
    url,
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  };
}

function assertChatCompletionsDeployment(
  deployment: Deployment,
): asserts deployment is Deployment & { provider: ChatCompletionsProvider } {
  if (deployment.provider !== "nvidia_nim" && deployment.provider !== "openai") {
    throw new Error(`${deployment.provider} provider does not use the chat-completions base adapter`);
  }
  if (deployment.mode !== undefined) {
    throw new Error(`${deployment.provider} provider does not support mode='${deployment.mode}'`);
  }
}

function normalizeApiBase(apiBase: string): string {
  return apiBase.replace(/\/+$/, "");
}

function parseJsonObject(bodyText: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(bodyText);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    // not JSON
  }
  return null;
}

// ─── Execute provider request ─────────────────────────────────────

export async function executeProviderRequest(
  req: ProviderRequest,
  ctx: ProviderExecutionContext,
): Promise<ProviderResponse> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ctx.timeoutMs);

  // Link external signal — attach listener first to avoid race
  const onExternalAbort = () => controller.abort();
  ctx.signal.addEventListener("abort", onExternalAbort, { once: true });
  if (ctx.signal.aborted) {
    clearTimeout(timeoutId);
    ctx.signal.removeEventListener("abort", onExternalAbort);
    throw new DOMException("Aborted", "AbortError");
  }

  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });

    const bodyText = await response.text();
    const respHeaders: Record<string, string> = Object.create(null);
    response.headers.forEach((v, k) => {
      if (k !== "__proto__" && k !== "constructor" && k !== "prototype") {
        respHeaders[k] = v;
      }
    });

    const json = parseJsonObject(bodyText);

    return {
      status: response.status,
      headers: respHeaders,
      body: bodyText,
      json,
    };
  } catch (err) {
    if (timedOut && isAbortError(err)) {
      throw new DOMException(`Provider request timed out after ${ctx.timeoutMs}ms`, "TimeoutError");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    ctx.signal.removeEventListener("abort", onExternalAbort);
  }
}

// ─── Execute streaming provider request ───────────────────────────

export interface StreamingProviderResult {
  response: Response;
  status: number;
  headers: Headers;
  /** Populated for HTTP error responses so credential rotation can classify failures. */
  body?: string;
}

export async function executeStreamingProviderRequest(
  req: ProviderRequest,
  ctx: ProviderExecutionContext,
): Promise<StreamingProviderResult> {
  const controller = new AbortController();
  let timedOut = false;
  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, ctx.timeoutMs);

  const onExternalAbort = () => controller.abort();
  ctx.signal.addEventListener("abort", onExternalAbort, { once: true });
  if (ctx.signal.aborted) {
    clearTimeout(timeoutId);
    ctx.signal.removeEventListener("abort", onExternalAbort);
    throw new DOMException("Aborted", "AbortError");
  }

  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });

    let body: string | undefined;
    if (!response.ok) {
      try {
        body = await response.text();
      } catch {
        body = "";
      }
    }

    return {
      response,
      status: response.status,
      headers: response.headers,
      ...(body !== undefined ? { body } : {}),
    };
  } catch (err) {
    if (timedOut && isAbortError(err)) {
      throw new DOMException(`Provider stream timed out after ${ctx.timeoutMs}ms`, "TimeoutError");
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
    // Keep the external abort listener attached so the consumer of the
    // response body can still be notified if the signal fires during
    // streaming. Removing it here creates a gap between finally and the
    // consumer reading the body. The listener is cheap and will be GC'd
    // with the signal/response.
  }
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === "AbortError";
}
