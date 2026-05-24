// Anthropic subscription adapter: Claude Code OAuth inference.
// Ports behavior from litellm_logic/adapters/litellm/anthropic_subscription.py.
// Replaces filesystem/keychain/subprocess with Worker fetch + DO storage.

import type { Deployment, FailureClass } from "../config/schema";
import type { ProviderRequest } from "./base";

// ─── OAuth token types ─────────────────────────────────────────────

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number | null;
}

export interface OAuthRefreshResult {
  success: boolean;
  token?: OAuthTokenSet;
  error?: string;
  failureClass?: "oauth_session_failure" | "auth_failure";
}

// ─── OAuth token endpoint ──────────────────────────────────────────

const ANTHROPIC_TOKEN_URL = "https://api.anthropic.com/v1/oauth/token";

export async function refreshAnthropicOAuthToken(
  refreshToken: string,
  clientId: string,
  clientSecret?: string,
): Promise<OAuthRefreshResult> {
  try {
    const body: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
    };
    if (clientSecret) body.client_secret = clientSecret;

    const resp = await fetch(ANTHROPIC_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10000),
    });

    if (!resp.ok) {
      const errorText = await resp.text();
      if (resp.status === 401 || resp.status === 403) {
        return {
          success: false,
          error: errorText,
          failureClass: "oauth_session_failure",
        };
      }
      return {
        success: false,
        error: errorText,
        failureClass: "auth_failure",
      };
    }

    const data = await resp.json() as Record<string, unknown>;
    const expiresIn = (data.expires_in as number) ?? 3600;

    return {
      success: true,
      token: {
        accessToken: data.access_token as string,
        refreshToken: (data.refresh_token as string) ?? refreshToken,
        expiresAt: Date.now() + expiresIn * 1000 - 60000, // 1min safety margin
      },
    };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "unknown",
      failureClass: "auth_failure",
    };
  }
}

// ─── Get valid token (with refresh) ────────────────────────────────

export interface OAuthAccountAccessor {
  getToken(accountId: string): Promise<OAuthTokenSet | null>;
  setToken(accountId: string, provider: string, accessToken: string, refreshToken?: string, expiresAt?: number): Promise<void>;
  acquireRefreshLock(accountId: string, requestId: string, ttlMs?: number): Promise<boolean>;
  releaseRefreshLock(accountId: string, requestId: string): Promise<void>;
}

export async function getValidAnthropicToken(
  accountId: string,
  requestId: string,
  oauthDo: OAuthAccountAccessor,
  oauthConfig: { clientId: string; clientSecret?: string },
): Promise<{ token: string; refreshed: boolean } | { error: string; failureClass: FailureClass }> {
  const stored = await oauthDo.getToken(accountId);
  if (!stored) {
    return { error: "no_token_stored", failureClass: "oauth_session_failure" };
  }

  // Token still valid?
  if (stored.expiresAt && stored.expiresAt > Date.now()) {
    return { token: stored.accessToken, refreshed: false };
  }

  // Need refresh — acquire singleflight lock
  const locked = await oauthDo.acquireRefreshLock(accountId, requestId, 30000);
  if (!locked) {
    // Another request is refreshing. Wait briefly and re-read so concurrent
    // traffic shares the refreshed token instead of failing the account.
    for (const delayMs of [100, 250, 500]) {
      await sleep(delayMs);
      const retried = await oauthDo.getToken(accountId);
      if (retried && (!retried.expiresAt || retried.expiresAt > Date.now())) {
        return { token: retried.accessToken, refreshed: true };
      }
    }
    return { error: "refresh_lock_contention", failureClass: "oauth_session_failure" };
  }

  try {
    if (!stored.refreshToken) {
      return { error: "no_refresh_token", failureClass: "oauth_session_failure" };
    }

    const result = await refreshAnthropicOAuthToken(
      stored.refreshToken,
      oauthConfig.clientId,
      oauthConfig.clientSecret,
    );

    if (!result.success || !result.token) {
      return { error: result.error ?? "refresh_failed", failureClass: result.failureClass ?? "auth_failure" };
    }

    // Store new tokens
    await oauthDo.setToken(
      accountId,
      "anthropic_subscription",
      result.token.accessToken,
      result.token.refreshToken,
      result.token.expiresAt ?? undefined,
    );

    return { token: result.token.accessToken, refreshed: true };
  } finally {
    await oauthDo.releaseRefreshLock(accountId, requestId);
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ─── Build Anthropic subscription request ──────────────────────────

const ANTHROPIC_HANDLED_FIELDS = new Set([
  "messages", "model", "max_tokens", "system", "tools", "tool_choice",
  "stream", "temperature", "top_p", "stop",
]);

export function buildAnthropicSubscriptionRequest(
  deployment: Deployment,
  body: Record<string, unknown>,
  accessToken: string,
): ProviderRequest {
  const base = deployment.apiBase ?? "https://api.anthropic.com";
  const url = `${base}/v1/messages`;

  const messages = (body.messages as Array<Record<string, unknown>>) ?? [];

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${accessToken}`,
    "anthropic-version": "2023-06-01",
  };

  // Extract system prompt if present
  const anthropicBody: Record<string, unknown> = {
    model: deployment.providerModel,
    max_tokens: body.max_tokens ?? 8192,
    messages: convertToAnthropicMessages(messages),
  };

  // System message extraction — pass arrays through for cache control blocks
  const systemMsg = messages.find((m) => m.role === "system");
  if (systemMsg) {
    const sysContent = systemMsg.content;
    anthropicBody.system = typeof sysContent === "string"
      || (Array.isArray(sysContent) && sysContent.length > 0)
      ? sysContent
      : typeof sysContent !== "undefined"
        ? JSON.stringify(sysContent)
        : undefined;
  }

  if (body.tools) anthropicBody.tools = convertTools(body.tools as Array<Record<string, unknown>>);
  if (body.tool_choice) {
    const tc = convertToolChoice(body.tool_choice);
    if (tc) {
      anthropicBody.tool_choice = tc;
    } else {
      // tool_choice "none" — Anthropic has no "none" mode, so strip tools instead
      delete anthropicBody.tools;
    }
  }
  if (body.stream) anthropicBody.stream = body.stream;
  if (body.temperature !== undefined && body.temperature !== null) anthropicBody.temperature = body.temperature;
  if (body.top_p !== undefined && body.top_p !== null) anthropicBody.top_p = body.top_p;
  if (body.stop) anthropicBody.stop_sequences = Array.isArray(body.stop) ? body.stop : [body.stop];

  // Copy remaining client body fields not already mapped
  const handled = ANTHROPIC_HANDLED_FIELDS;
  for (const [k, v] of Object.entries(body)) {
    if (!handled.has(k) && !(k in anthropicBody)) {
      anthropicBody[k] = v;
    }
  }

  // Merge deployment defaults (e.g., reasoning effort) — don't overwrite client values
  if (deployment.reasoningEffort && !anthropicBody.reasoning_effort) anthropicBody.reasoning_effort = deployment.reasoningEffort;
  if (deployment.extraBody) {
    for (const [k, v] of Object.entries(deployment.extraBody)) {
      if (!(k in anthropicBody) && v !== null) anthropicBody[k] = v;
    }
  }
  if (deployment.params) {
    for (const [k, v] of Object.entries(deployment.params)) {
      if (!(k in anthropicBody) && v !== null) anthropicBody[k] = v;
    }
  }

  return {
    url,
    method: "POST",
    headers,
    body: JSON.stringify(anthropicBody),
  };
}

// ─── Convert Anthropic Messages response to OpenAI format ──────────

export function convertAnthropicToOpenAI(
  anthropicResponse: Record<string, unknown>,
  requestId: string,
): Record<string, unknown> {
  const content = anthropicResponse.content as Array<Record<string, unknown>> ?? [];
  const textBlocks = content.filter((b) => b.type === "text");
  const toolUseBlocks = content.filter((b) => b.type === "tool_use");

  const textContent = textBlocks.map((b) => b.text).join("");
  const finishReason = mapAnthropicStopReason(anthropicResponse.stop_reason as string);

  const toolCalls = toolUseBlocks.map((b, i) => ({
    id: b.id ?? `call_${i}`,
    type: "function",
    function: {
      name: b.name,
      arguments: typeof b.input === "string" ? b.input : JSON.stringify(b.input),
    },
  }));

  const message: Record<string, unknown> = {
    role: "assistant",
    content: textContent,
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const usage = anthropicResponse.usage as Record<string, number> | undefined;

  return {
    id: anthropicResponse.id ?? requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: anthropicResponse.model ?? "unknown",
    choices: [{
      index: 0,
      message,
      finish_reason: finishReason,
    }],
    usage: {
      prompt_tokens: usage?.input_tokens ?? 0,
      completion_tokens: usage?.output_tokens ?? 0,
      total_tokens: (usage?.input_tokens ?? 0) + (usage?.output_tokens ?? 0),
    },
  };
}

// ─── Anthropic SSE stream conversion ───────────────────────────────

export function convertAnthropicStreamChunk(
  event: { type: string; [key: string]: unknown },
  requestId: string,
  model: string,
  toolCallIndexMap?: Map<number, number>,
): Record<string, unknown> | null {
  switch (event.type) {
    case "content_block_delta": {
      const delta = event.delta as Record<string, unknown>;
      if (delta.type === "text_delta") {
        return {
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: { content: delta.text },
            finish_reason: null,
          }],
        };
      }
      if (delta.type === "input_json_delta") {
        // Tool use partial JSON — emit as tool call delta
        const blockIndex = (event.index as number) ?? 0;
        const toolIndex = toolCallIndexMap?.get(blockIndex) ?? blockIndex;
        return {
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: toolIndex,
                function: { arguments: delta.partial_json },
              }],
            },
            finish_reason: null,
          }],
        };
      }
      return null;
    }

    case "content_block_start": {
      const contentBlock = event.content_block as Record<string, unknown>;
      if (contentBlock?.type === "tool_use") {
        const blockIndex = (event.index as number) ?? 0;
        const toolIndex = toolCallIndexMap?.get(blockIndex) ?? blockIndex;
        return {
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: toolIndex,
                id: contentBlock.id,
                type: "function",
                function: { name: contentBlock.name, arguments: "" },
              }],
            },
            finish_reason: null,
          }],
        };
      }
      return null;
    }

    case "message_delta": {
      const delta = event.delta as Record<string, unknown>;
      if (delta.stop_reason) {
        const result: Record<string, unknown> = {
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [{
            index: 0,
            delta: {},
            finish_reason: mapAnthropicStopReason(delta.stop_reason as string),
          }],
        };
        const deltaUsage = event.usage as Record<string, number> | undefined;
        if (deltaUsage) {
          result.usage = {
            prompt_tokens: 0,
            completion_tokens: deltaUsage.output_tokens ?? 0,
            total_tokens: deltaUsage.output_tokens ?? 0,
          };
        }
        return result;
      }
      return null;
    }

    case "message_start": {
      const msg = event.message as Record<string, unknown> | undefined;
      const msgUsage = msg?.usage as Record<string, number> | undefined;
      if (msgUsage) {
        return {
          id: requestId,
          object: "chat.completion.chunk",
          created: Math.floor(Date.now() / 1000),
          model,
          choices: [],
          usage: {
            prompt_tokens: msgUsage.input_tokens ?? 0,
            completion_tokens: 0,
            total_tokens: msgUsage.input_tokens ?? 0,
          },
        };
      }
      return null;
    }

    case "content_block_stop":
    case "message_stop":
    case "ping":
      return null;

    default:
      return null;
  }
}

// ─── Helpers ───────────────────────────────────────────────────────

function mapAnthropicStopReason(reason: string | null | undefined): string {
  if (!reason) return "stop";
  if (reason === "tool_use") return "tool_calls";
  if (reason === "max_tokens") return "length";
  return "stop";
}

function convertToAnthropicMessages(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const result: Array<Record<string, unknown>> = [];
  for (const msg of messages) {
    const role = msg.role as string;
    const content = msg.content;

    if (role === "system") continue; // system goes to top-level field

    if (role === "assistant") {
      const entry: Record<string, unknown> = { role: "assistant", content };
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        const blocks: Array<Record<string, unknown>> = [];
        for (const tc of msg.tool_calls as Array<Record<string, unknown>>) {
          const fn = tc.function as Record<string, unknown>;
          let input: unknown;
          try {
            input = typeof fn.arguments === "string" ? JSON.parse(fn.arguments) : fn.arguments;
          } catch {
            input = fn.arguments;
          }
          blocks.push({
            type: "tool_use",
            id: tc.id,
            name: fn.name,
            input,
          });
        }
        entry.content = [
          ...(typeof content === "string" && content ? [{ type: "text", text: content }] : []),
          ...blocks,
        ];
      }
      result.push(entry);
      continue;
    }

    if (role === "tool") {
      const toolBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: typeof content === "string" ? content : ((content === null || content === undefined) ? "" : JSON.stringify(content)),
      };
      // Anthropic requires consecutive tool results in a single user message
      const last = result[result.length - 1];
      if (last && last.role === "user" && Array.isArray(last.content)) {
        const blocks = last.content as Array<Record<string, unknown>>;
        if (blocks.every((b) => b.type === "tool_result")) {
          blocks.push(toolBlock);
          continue;
        }
      }
      result.push({ role: "user", content: [toolBlock] });
      continue;
    }

    result.push({ role, content });
  }
  return result;
}

function convertTools(tools: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return tools.map((t) => {
    const fn = t.function as Record<string, unknown>;
    return {
      name: fn.name,
      description: fn.description ?? "",
      input_schema: fn.parameters ?? { type: "object", properties: {} },
    };
  });
}

function convertToolChoice(toolChoice: unknown): Record<string, unknown> | null {
  if (typeof toolChoice === "string") {
    if (toolChoice === "auto") return { type: "auto" };
    if (toolChoice === "none") return null; // Caller strips tools from body when this returns null
    if (toolChoice === "required") return { type: "any" };
    return { type: "auto" };
  }
  if (typeof toolChoice === "object" && toolChoice !== null) {
    const tc = toolChoice as Record<string, unknown>;
    if (tc.type === "function" && tc.function) {
      const fn = tc.function as Record<string, unknown>;
      return { type: "tool", name: fn.name };
    }
  }
  return { type: "auto" };
}
