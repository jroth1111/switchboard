// Provider adapters: execute requests against LLM providers.
// Replaces litellm_logic's LiteLLM provider layer.

import type { Deployment } from "../config/schema";

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

export function buildProviderRequest(
  deployment: Deployment,
  body: Record<string, unknown>,
  apiKey: string,
): ProviderRequest {
  const base = deployment.apiBase ?? "https://api.openai.com/v1";
  const url = `${base}/chat/completions`;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  switch (deployment.provider) {
    case "nvidia_nim":
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
    case "openai":
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
    case "anthropic_subscription":
      headers["x-api-key"] = apiKey;
      headers["anthropic-version"] = "2023-06-01";
      break;
    case "chatgpt":
      headers["Authorization"] = `Bearer ${apiKey}`;
      break;
    default:
      headers["Authorization"] = `Bearer ${apiKey}`;
  }

  // Set model name and deployment-level overrides
  const requestBody: Record<string, unknown> = {
    ...body,
    model: deployment.providerModel,
  };

  // Merge deployment params (don't overwrite client values)
  if (deployment.params) {
    for (const [k, v] of Object.entries(deployment.params)) {
      if (!(k in requestBody) && v !== null) {
        requestBody[k] = v;
      }
    }
  }

  // Merge deployment extraBody (don't overwrite client values)
  if (deployment.extraBody) {
    for (const [k, v] of Object.entries(deployment.extraBody)) {
      if (!(k in requestBody) && v !== null) {
        requestBody[k] = v;
      }
    }
  }

  // Apply deployment reasoning effort only when client didn't specify one
  if (deployment.reasoningEffort && !requestBody.reasoning_effort) {
    requestBody.reasoning_effort = deployment.reasoningEffort;
  }

  return {
    url,
    method: "POST",
    headers,
    body: JSON.stringify(requestBody),
  };
}

// ─── Execute provider request ─────────────────────────────────────

export async function executeProviderRequest(
  req: ProviderRequest,
  ctx: ProviderExecutionContext,
): Promise<ProviderResponse> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ctx.timeoutMs);

  // Link external signal
  if (ctx.signal.aborted) {
    clearTimeout(timeoutId);
    throw new DOMException("Aborted", "AbortError");
  }
  const onExternalAbort = () => controller.abort();
  ctx.signal.addEventListener("abort", onExternalAbort, { once: true });

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

    let json: Record<string, unknown> | null = null;
    try {
      json = JSON.parse(bodyText);
    } catch {
      // not JSON
    }

    return {
      status: response.status,
      headers: respHeaders,
      body: bodyText,
      json,
    };
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
}

export async function executeStreamingProviderRequest(
  req: ProviderRequest,
  ctx: ProviderExecutionContext,
): Promise<StreamingProviderResult> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), ctx.timeoutMs);

  if (ctx.signal.aborted) {
    clearTimeout(timeoutId);
    throw new DOMException("Aborted", "AbortError");
  }
  const onExternalAbort = () => controller.abort();
  ctx.signal.addEventListener("abort", onExternalAbort, { once: true });

  try {
    const response = await fetch(req.url, {
      method: req.method,
      headers: req.headers,
      body: req.body,
      signal: controller.signal,
    });

    return {
      response,
      status: response.status,
      headers: response.headers,
    };
  } finally {
    clearTimeout(timeoutId);
    // Keep the external abort listener attached so the consumer of the
    // response body can still be notified if the signal fires during
    // streaming. Removing it here creates a gap between finally and the
    // consumer reading the body. The listener is cheap and will be GC'd
    // with the signal/response.
  }
}
