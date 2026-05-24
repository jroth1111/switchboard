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

export const ANTHROPIC_OAUTH_TOKEN_URL = "https://platform.claude.com/v1/oauth/token";
export const CLAUDE_AI_OAUTH_SCOPE = [
  "user:profile",
  "user:inference",
  "user:sessions:claude_code",
  "user:mcp_servers",
  "user:file_upload",
].join(" ");

export interface AnthropicOAuthRefreshOptions {
  tokenUrl?: string;
}

export async function refreshAnthropicOAuthToken(
  refreshToken: string,
  clientId: string,
  clientSecret?: string,
  options: AnthropicOAuthRefreshOptions = {},
): Promise<OAuthRefreshResult> {
  try {
    const body: Record<string, string> = {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      scope: CLAUDE_AI_OAUTH_SCOPE,
    };
    if (clientSecret) body.client_secret = clientSecret;

    const resp = await fetch(options.tokenUrl ?? ANTHROPIC_OAUTH_TOKEN_URL, {
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
  oauthConfig: { clientId: string; clientSecret?: string; tokenUrl?: string },
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
      { tokenUrl: oauthConfig.tokenUrl },
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

const ANTHROPIC_MESSAGES_PATH = "/v1/messages?beta=true";
const ANTHROPIC_VERSION = "2023-06-01";
const ANTHROPIC_SDK_PACKAGE_VERSION = "0.81.0";
const DEFAULT_API_TIMEOUT_MS = 600000;
const CLAUDE_CODE_BETA = "claude-code-20250219";
const OAUTH_BETA = "oauth-2025-04-20";
const INTERLEAVED_THINKING_BETA = "interleaved-thinking-2025-05-14";
const CONTEXT_MANAGEMENT_BETA = "context-management-2025-06-27";
const PROMPT_CACHING_SCOPE_BETA = "prompt-caching-scope-2026-01-05";
const EFFORT_BETA = "effort-2025-11-24";
const AGENT_IDENTITY = "You are a Claude agent, built on Anthropic's Claude Agent SDK.";

const CLAUDE_CODE_BODY_FIELD_ORDER = [
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "metadata",
  "max_tokens",
  "thinking",
  "temperature",
  "top_p",
  "top_k",
  "stop_sequences",
  "context_management",
  "output_config",
  "speed",
  "stream",
];

const CLAUDE_CODE_HEADER_ORDER = [
  "accept",
  "content-type",
  "user-agent",
  "x-claude-code-session-id",
  "x-stainless-arch",
  "x-stainless-lang",
  "x-stainless-os",
  "x-stainless-package-version",
  "x-stainless-retry-count",
  "x-stainless-runtime",
  "x-stainless-runtime-version",
  "x-stainless-timeout",
  "anthropic-beta",
  "authorization",
  "anthropic-dangerous-direct-browser-access",
  "anthropic-version",
  "x-app",
  "x-client-request-id",
  "content-length",
];

const ANTHROPIC_HANDLED_FIELDS = new Set([
  "anthropic_metadata", "anthropic_body", "betas", "context_management",
  "headers", "max_completion_tokens", "max_tokens", "messages", "metadata",
  "model", "output_config", "reasoning_effort", "speed", "stop", "stop_sequences",
  "stream", "system", "temperature", "thinking", "tool_choice", "tools",
  "top_k", "top_p",
]);

export function buildAnthropicSubscriptionRequest(
  deployment: Deployment,
  body: Record<string, unknown>,
  accessToken: string,
): ProviderRequest {
  const requestParams = withDeploymentDefaults(body, deployment);
  const base = (deployment.apiBase ?? "https://api.anthropic.com").replace(/\/+$/, "");
  const url = `${base}${ANTHROPIC_MESSAGES_PATH}`;
  const model = deployment.providerModel;
  const rawBody = asRecord(requestParams.anthropic_body);

  let anthropicBody: Record<string, unknown>;
  let betas: string[];

  if (rawBody) {
    const raw = { ...rawBody };
    const rawBetas = raw.betas ?? requestParams.betas;
    delete raw.betas;
    raw.model ??= model;
    raw.messages ??= requestParams.messages ?? [];
    anthropicBody = orderBody(stripAbsent(raw));
    betas = normalizeBetas(rawBetas, model);
  } else {
    anthropicBody = buildClaudeCodeBody(model, requestParams, body.messages as Array<Record<string, unknown>> | undefined);
    betas = normalizeBetas(requestParams.betas, model);
    const outputConfig = asRecord(anthropicBody.output_config);
    if (outputConfig?.effort && !betas.includes(EFFORT_BETA)) betas.push(EFFORT_BETA);
  }

  const bodyText = JSON.stringify(anthropicBody, null, 2);
  const headers = buildClaudeCodeHeaders(accessToken, bodyText, betas, base, requestParams.headers);

  return {
    url,
    method: "POST",
    headers,
    body: bodyText,
  };
}

function buildClaudeCodeBody(
  model: string,
  requestParams: Record<string, unknown>,
  originalMessages?: Array<Record<string, unknown>>,
): Record<string, unknown> {
  const messages = (requestParams.messages as Array<Record<string, unknown>>) ?? [];
  const convertedMessages = stripThinkingHistory(addCacheBreakpoints(convertToAnthropicMessages(messages), {
    enablePromptCaching: promptCachingEnabled(model),
  }));
  const userSystem = requestParams.system ?? extractSystemPrompt(messages);
  const outputConfig = outputConfigForRequest(requestParams, model);
  const maxTokens = Number(requestParams.max_tokens ?? requestParams.max_completion_tokens ?? modelMaxOutputTokens(model));
  const thinking = thinkingForRequest(requestParams, model, maxTokens);
  const stopSequences = normalizeStopSequences(requestParams.stop_sequences ?? requestParams.stop);

  const anthropicBody: Record<string, unknown> = {
    model,
    messages: convertedMessages,
    system: claudeCodeSystemBlocks(model, originalMessages ?? messages, userSystem),
    tools: requestParams.tools ? convertTools(requestParams.tools as Array<Record<string, unknown>>) : undefined,
    metadata: requestParams.metadata ?? requestParams.anthropic_metadata ?? claudeApiMetadata(),
    max_tokens: maxTokens,
    thinking,
    temperature: thinking ? undefined : (requestParams.temperature ?? 1),
    top_p: requestParams.top_p,
    top_k: requestParams.top_k,
    stop_sequences: stopSequences,
    context_management: requestParams.context_management ?? defaultContextManagement(model),
    output_config: outputConfig,
    speed: requestParams.speed,
    stream: requestParams.stream === true ? true : undefined,
  };

  if (requestParams.tool_choice) {
    const tc = convertToolChoice(requestParams.tool_choice);
    if (tc) {
      anthropicBody.tool_choice = tc;
    } else {
      delete anthropicBody.tools;
    }
  }

  for (const [k, v] of Object.entries(requestParams)) {
    if (!ANTHROPIC_HANDLED_FIELDS.has(k) && !(k in anthropicBody)) {
      anthropicBody[k] = v;
    }
  }

  return orderBody(stripAbsent(anthropicBody));
}

function withDeploymentDefaults(body: Record<string, unknown>, deployment: Deployment): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...body };
  const applyDefaults = (defaults?: Record<string, unknown>) => {
    if (!defaults) return;
    for (const [k, v] of Object.entries(defaults)) {
      if (!(k in merged) && v !== null) merged[k] = v;
    }
  };
  applyDefaults(deployment.extraBody);
  applyDefaults(deployment.params);
  if (deployment.reasoningEffort) {
    const outputConfig = asRecord(merged.output_config);
    if (outputConfig) {
      merged.output_config = { effort: deployment.reasoningEffort, ...outputConfig };
    } else if (!("reasoning_effort" in merged)) {
      merged.reasoning_effort = deployment.reasoningEffort;
    }
  }
  return merged;
}

function buildClaudeCodeHeaders(
  accessToken: string,
  bodyText: string,
  betas: string[],
  baseUrl: string,
  overrides: unknown,
): Record<string, string> {
  const sessionId = processSessionId();
  const headers: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
    "user-agent": claudeCodeUserAgent(),
    "x-claude-code-session-id": sessionId,
    "x-stainless-arch": runtimeArch(),
    "x-stainless-lang": "js",
    "x-stainless-os": runtimeOs(),
    "x-stainless-package-version": ANTHROPIC_SDK_PACKAGE_VERSION,
    "x-stainless-retry-count": "0",
    "x-stainless-runtime": "node",
    "x-stainless-runtime-version": runtimeVersion(),
    "x-stainless-timeout": String(apiTimeoutMs()),
    "anthropic-beta": betas.join(","),
    authorization: `Bearer ${accessToken}`,
    "anthropic-dangerous-direct-browser-access": "true",
    "anthropic-version": ANTHROPIC_VERSION,
    "x-app": envValue("CLAUDE_CODE_ENTRYPOINT") ?? "cli",
    "content-length": String(utf8Length(bodyText)),
  };

  if (isFirstPartyAnthropicBaseUrl(baseUrl)) {
    headers["x-client-request-id"] = randomId();
  }

  const overrideHeaders = asRecord(overrides);
  if (overrideHeaders) {
    for (const [key, value] of Object.entries(overrideHeaders)) {
      const normalized = key.toLowerCase();
      if (value === null || value === undefined) {
        delete headers[normalized];
      } else {
        headers[normalized] = String(value);
      }
    }
  }

  return orderHeaders(headers);
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

    if (role === "system" || role === "developer") continue;

    if (role === "assistant") {
      const entry: Record<string, unknown> = { role: "assistant", content: anthropicContentParts(content) };
      if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
        const blocks = Array.isArray(entry.content) ? [...entry.content as Array<Record<string, unknown>>] : [];
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
            id: tc.id ?? `toolu_${randomHex(24)}`,
            name: fn.name ?? "",
            input,
          });
        }
        entry.content = blocks;
      }
      result.push(entry);
      continue;
    }

    if (role === "tool") {
      const toolBlock = {
        type: "tool_result",
        tool_use_id: msg.tool_call_id,
        content: toolResultContent(content),
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

    result.push({ role: role === "assistant" ? "assistant" : "user", content: anthropicContentParts(content) });
  }
  return result;
}

function anthropicContentParts(content: unknown): unknown {
  if (typeof content === "string" || content === null || content === undefined) return content ?? "";
  if (!Array.isArray(content)) return String(content);

  const parts: Array<Record<string, unknown>> = [];
  for (const rawPart of content) {
    if (!isRecord(rawPart)) {
      parts.push({ type: "text", text: String(rawPart) });
      continue;
    }
    const partType = rawPart.type;
    if (partType === "text" || partType === "input_text" || partType === "summary_text") {
      parts.push({ type: "text", text: String(rawPart.text ?? "") });
      continue;
    }
    if (partType === "image" || partType === "input_image" || partType === "image_url") {
      const image = anthropicImageBlock(rawPart);
      if (image) parts.push(image);
      continue;
    }
    if (partType === "tool_result" || partType === "tool_use" || partType === "server_tool_use" || partType === "web_search_tool_result") {
      parts.push(cloneRecord(rawPart));
      continue;
    }
    if ("text" in rawPart) {
      parts.push({ type: "text", text: String(rawPart.text ?? "") });
    } else {
      parts.push(cloneRecord(rawPart));
    }
  }
  return parts;
}

function anthropicImageBlock(part: Record<string, unknown>): Record<string, unknown> | null {
  const source = asRecord(part.source);
  if (source) return { type: "image", source: cloneRecord(source) };

  const imageUrl = asRecord(part.image_url);
  const urlValue = imageUrl?.url ?? part.url ?? part.image_url;
  if (typeof urlValue === "string") {
    if (urlValue.startsWith("data:")) {
      const [header, encoded = ""] = urlValue.split(",", 2);
      const mediaType = header.replace(/^data:/, "").split(";", 1)[0] || "image/png";
      return {
        type: "image",
        source: { type: "base64", media_type: mediaType, data: encoded },
      };
    }
    return { type: "image", source: { type: "url", url: urlValue } };
  }

  if (typeof part.data === "string") {
    return {
      type: "image",
      source: {
        type: "base64",
        media_type: String(part.media_type ?? "image/png"),
        data: part.data,
      },
    };
  }
  return null;
}

function toolResultContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  const parts = anthropicContentParts(content);
  return Array.isArray(parts) && parts.length > 0 ? parts : "";
}

function addCacheBreakpoints(
  messages: Array<Record<string, unknown>>,
  options: { enablePromptCaching: boolean },
): Array<Record<string, unknown>> {
  if (messages.length === 0) return messages;
  const result = messages.map((message) => {
    const next = { ...message };
    if (Array.isArray(next.content)) {
      next.content = stripClientCacheMarkers(contentBlocksForCache(next.content));
    }
    return next;
  });

  const markerMessage = result[result.length - 1];
  const contentBlocks = stripClientCacheMarkers(contentBlocksForCache(markerMessage.content));
  if (contentBlocks.length > 0 && options.enablePromptCaching) {
    let targetIndex = contentBlocks.length - 1;
    if (markerMessage.role === "assistant") {
      targetIndex = -1;
      for (let index = contentBlocks.length - 1; index >= 0; index -= 1) {
        if (contentBlocks[index].type !== "thinking" && contentBlocks[index].type !== "redacted_thinking") {
          targetIndex = index;
          break;
        }
      }
    }
    if (targetIndex >= 0) {
      contentBlocks[targetIndex].cache_control = cacheControl();
    }
  }
  markerMessage.content = contentBlocks;

  if (options.enablePromptCaching) {
    let lastCacheMessage = -1;
    for (let index = 0; index < result.length; index += 1) {
      const message = result[index];
      if (
        Array.isArray(message.content)
        && (message.content as Array<Record<string, unknown>>).some((block) => "cache_control" in block)
      ) {
        lastCacheMessage = index;
      }
    }
    if (lastCacheMessage >= 0) {
      for (const message of result.slice(0, lastCacheMessage)) {
        if (message.role !== "user" || !Array.isArray(message.content)) continue;
        for (const block of message.content as Array<Record<string, unknown>>) {
          if (block.type === "tool_result" && block.tool_use_id) {
            block.cache_reference = block.tool_use_id;
          }
        }
      }
    }
  }
  return result;
}

function contentBlocksForCache(content: unknown): Array<Record<string, unknown>> {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [{ type: "text", text: content === null || content === undefined ? "" : String(content) }];
  return content.map((block) => isRecord(block) ? cloneRecord(block) : { type: "text", text: String(block) });
}

function stripClientCacheMarkers(blocks: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return blocks.map((block) => {
    const copy = { ...block };
    delete copy.cache_control;
    delete copy.cache_reference;
    return copy;
  });
}

function stripThinkingHistory(messages: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  const result = messages.map((message) => {
    if (message.role !== "assistant" || !Array.isArray(message.content)) return message;
    return {
      ...message,
      content: (message.content as Array<Record<string, unknown>>)
        .filter((block) => block.type !== "thinking" && block.type !== "redacted_thinking"),
    };
  });
  while (result.length > 0 && Array.isArray(result[result.length - 1].content) && (result[result.length - 1].content as unknown[]).length === 0) {
    result.pop();
  }
  return result;
}

function extractSystemPrompt(messages: Array<Record<string, unknown>>): unknown {
  const parts: string[] = [];
  for (const message of messages) {
    if (message.role !== "system" && message.role !== "developer") continue;
    for (const block of systemAsTextBlocks(message.content)) {
      const text = block.text;
      if (typeof text === "string" && text) parts.push(text);
    }
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function systemAsTextBlocks(system: unknown): Array<Record<string, unknown>> {
  if (system === null || system === undefined) return [];
  if (typeof system === "string") return system ? [{ type: "text", text: system }] : [];
  if (isRecord(system)) return system.type === "text" ? [cloneRecord(system)] : [{ type: "text", text: String(system.text ?? system) }];
  if (!Array.isArray(system)) return [{ type: "text", text: String(system) }];
  const blocks: Array<Record<string, unknown>> = [];
  for (const item of system) {
    if (isRecord(item)) {
      if (item.type === "text") blocks.push(cloneRecord(item));
      else if ("text" in item) blocks.push({ type: "text", text: String(item.text ?? "") });
    } else if (item) {
      blocks.push({ type: "text", text: String(item) });
    }
  }
  return blocks;
}

function claudeCodeSystemBlocks(
  model: string,
  messages: Array<Record<string, unknown>>,
  userSystem: unknown,
): Array<Record<string, unknown>> {
  const blocks: Array<Record<string, unknown>> = [];
  const attribution = claudeCodeAttributionHeader(messages);
  const enablePromptCaching = promptCachingEnabled(model);
  if (attribution) blocks.push({ type: "text", text: attribution });
  const identityBlock: Record<string, unknown> = { type: "text", text: AGENT_IDENTITY };
  if (enablePromptCaching) identityBlock.cache_control = cacheControl();
  blocks.push(identityBlock);
  const userSystemText = systemAsTextBlocks(userSystem)
    .map((block) => typeof block.text === "string" ? block.text : "")
    .filter(Boolean)
    .join("\n\n");
  if (userSystemText) {
    const promptBlock: Record<string, unknown> = { type: "text", text: userSystemText };
    if (enablePromptCaching) promptBlock.cache_control = cacheControl();
    blocks.push(promptBlock);
  }
  return blocks;
}

function claudeCodeAttributionHeader(messages: Array<Record<string, unknown>>): string | null {
  const raw = envValue("CLAUDE_CODE_ATTRIBUTION_HEADER");
  if (raw !== undefined && isDefinedFalsy(raw)) return null;
  const version = claudeCodeVersion();
  const entrypoint = envValue("CLAUDE_CODE_ENTRYPOINT") ?? "cli";
  const workload = envValue("ANTHROPIC_SUBSCRIPTION_WORKLOAD") ?? envValue("CLAUDE_CODE_WORKLOAD") ?? "coding-harness";
  const cch = envValue("CLAUDE_CODE_CCH") ?? envValue("ANTHROPIC_SUBSCRIPTION_CCH") ?? randomCch(messages);
  const fingerprint = shortHash(`re0${version}`);
  return `x-anthropic-billing-header: cc_version=${version}.${fingerprint}; cc_entrypoint=${entrypoint}; cch=${cch}; cc_workload=${workload};`;
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
    if (toolChoice === "none") return { type: "none" };
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

function outputConfigForRequest(requestParams: Record<string, unknown>, model: string): unknown {
  const existing = asRecord(requestParams.output_config);
  let outputConfig: unknown = existing ? { ...existing } : requestParams.output_config;
  const reasoningEffort = requestParams.reasoning_effort;
  if (reasoningEffort !== undefined && reasoningEffort !== null) {
    outputConfig = isRecord(outputConfig)
      ? { effort: reasoningEffort, ...outputConfig }
      : { effort: reasoningEffort };
  } else if (!isHaiku(model)) {
    outputConfig = isRecord(outputConfig)
      ? { effort: "high", ...outputConfig }
      : outputConfig ?? { effort: "high" };
  }
  return outputConfig;
}

function thinkingForRequest(requestParams: Record<string, unknown>, model: string, maxTokens: number): unknown {
  const explicit = requestParams.thinking;
  if (isRecord(explicit) && explicit.type === "disabled") return undefined;
  if (explicit !== undefined && explicit !== null) return explicit;
  if (envTruthy("CLAUDE_CODE_DISABLE_THINKING")) return undefined;
  if (!supportsThinking(model) || isHaiku(model)) return undefined;
  if (!envTruthy("CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING") && supportsAdaptiveThinking(model)) {
    return { type: "adaptive" };
  }
  const configured = positiveInteger(envValue("MAX_THINKING_TOKENS"));
  const budget = configured ?? modelMaxThinkingTokens(model);
  return { budget_tokens: Math.min(Math.max(maxTokens - 1, 1), budget), type: "enabled" };
}

function defaultContextManagement(model: string): Record<string, unknown> | undefined {
  if (!supportsContextManagement(model) || isHaiku(model)) return undefined;
  return { edits: [{ type: "clear_thinking_20251015", keep: "all" }] };
}

function normalizeStopSequences(value: unknown): unknown {
  if (typeof value === "string") return [value];
  return value;
}

function claudeApiMetadata(): Record<string, string> {
  const extra = jsonObjectFromEnv("CLAUDE_CODE_EXTRA_METADATA");
  const deviceId = envValue("CLAUDE_CODE_DEVICE_ID")
    ?? envValue("ANTHROPIC_SUBSCRIPTION_DEVICE_ID")
    ?? stableDeviceId();
  const accountUuid = envValue("CLAUDE_CODE_ACCOUNT_UUID")
    ?? envValue("ANTHROPIC_SUBSCRIPTION_ACCOUNT_UUID")
    ?? "";
  return {
    user_id: JSON.stringify({
      ...extra,
      device_id: deviceId,
      account_uuid: accountUuid,
      session_id: processSessionId(),
    }),
  };
}

function normalizeBetas(value: unknown, model: string): string[] {
  if (typeof value === "string") return dedupe(value.split(",").map((part) => part.trim()).filter(Boolean));
  if (Array.isArray(value)) return dedupe(value.map((part) => String(part)).filter(Boolean));
  return defaultBetasForModel(model);
}

function defaultBetasForModel(model: string): string[] {
  const betas = [CLAUDE_CODE_BETA, OAUTH_BETA];
  if (supportsIsp(model)) betas.push(INTERLEAVED_THINKING_BETA);
  if (supportsContextManagement(model)) betas.push(CONTEXT_MANAGEMENT_BETA);
  betas.push(PROMPT_CACHING_SCOPE_BETA);
  return dedupe(betas);
}

function supportsContextManagement(model: string): boolean {
  const canonical = canonicalModelName(model);
  return !canonical.includes("claude-3-")
    && (canonical.includes("claude-opus-4")
      || canonical.includes("claude-sonnet-4")
      || canonical.includes("claude-haiku-4"));
}

function supportsThinking(model: string): boolean {
  const canonical = canonicalModelName(model);
  return !canonical.includes("claude-3-")
    && (canonical.includes("sonnet-4")
      || canonical.includes("opus-4")
      || canonical.includes("haiku-4"));
}

function supportsAdaptiveThinking(model: string): boolean {
  const canonical = canonicalModelName(model);
  return canonical.includes("opus-4-6")
    || canonical.includes("opus-4-7")
    || canonical.includes("sonnet-4-6");
}

function supportsIsp(model: string): boolean {
  const canonical = canonicalModelName(model);
  return !canonical.includes("claude-3-");
}

function promptCachingEnabled(model: string): boolean {
  const canonical = canonicalModelName(model);
  if (envTruthy("DISABLE_PROMPT_CACHING")) return false;
  if (canonical.includes("haiku") && envTruthy("DISABLE_PROMPT_CACHING_HAIKU")) return false;
  if (canonical.includes("sonnet") && envTruthy("DISABLE_PROMPT_CACHING_SONNET")) return false;
  if (canonical.includes("opus") && envTruthy("DISABLE_PROMPT_CACHING_OPUS")) return false;
  return true;
}

function cacheControl(): Record<string, string> {
  const value: Record<string, string> = { type: "ephemeral" };
  if (envTruthy("ANTHROPIC_SUBSCRIPTION_PROMPT_CACHE_1H")) value.ttl = "1h";
  return value;
}

function modelMaxOutputTokens(model: string): number {
  const canonical = canonicalModelName(model);
  if (canonical.includes("opus-4-6")) return 64000;
  if (canonical.includes("sonnet-4-6")) return 32000;
  if (canonical.includes("opus-4-5") || canonical.includes("sonnet-4") || canonical.includes("haiku-4")) return 32000;
  if (canonical.includes("opus-4")) return 32000;
  if (canonical.includes("3-7-sonnet")) return 32000;
  if (canonical.includes("3-5-sonnet") || canonical.includes("3-5-haiku")) return 8192;
  if (canonical.includes("claude-3-opus") || canonical.includes("claude-3-haiku")) return 4096;
  if (canonical.includes("claude-3-sonnet")) return 8192;
  return 32000;
}

function modelMaxThinkingTokens(model: string): number {
  const canonical = canonicalModelName(model);
  if (canonical.includes("opus-4-6") || canonical.includes("sonnet-4-6")) return 127999;
  if (canonical.includes("opus-4-5") || canonical.includes("sonnet-4") || canonical.includes("haiku-4")) return 63999;
  return 63999;
}

function isHaiku(model: string): boolean {
  return canonicalModelName(model).includes("haiku");
}

function canonicalModelName(model: string): string {
  return model
    .replace(/^anthropic_subscription\//, "")
    .replace(/^anthropic-subscription\//, "")
    .toLowerCase();
}

function orderBody(body: Record<string, unknown>): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of CLAUDE_CODE_BODY_FIELD_ORDER) {
    if (key in body) ordered[key] = body[key];
  }
  for (const [key, value] of Object.entries(body)) {
    if (!(key in ordered)) ordered[key] = value;
  }
  return ordered;
}

function orderHeaders(headers: Record<string, string>): Record<string, string> {
  const ordered: Record<string, string> = {};
  for (const key of CLAUDE_CODE_HEADER_ORDER) {
    if (key in headers) ordered[key] = headers[key];
  }
  for (const [key, value] of Object.entries(headers)) {
    if (!(key in ordered)) ordered[key] = value;
  }
  return ordered;
}

function stripAbsent(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    if (child === null || child === undefined) continue;
    if (Array.isArray(child)) {
      result[key] = child.map((item) => isRecord(item) ? stripAbsent(item) : item);
    } else if (isRecord(child)) {
      result[key] = stripAbsent(child);
    } else {
      result[key] = child;
    }
  }
  return result;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneRecord(value: Record<string, unknown>): Record<string, unknown> {
  return { ...value };
}

function jsonObjectFromEnv(name: string): Record<string, unknown> {
  const raw = envValue(name);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function envValue(name: string): string | undefined {
  const processLike = (globalThis as { process?: { env?: Record<string, string | undefined>; version?: string; platform?: string; arch?: string } }).process;
  const value = processLike?.env?.[name];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function envTruthy(name: string): boolean {
  const value = envValue(name);
  if (value === undefined) return false;
  return !isDefinedFalsy(value);
}

function isDefinedFalsy(value: string): boolean {
  return ["0", "false", "no", "off", ""].includes(value.trim().toLowerCase());
}

function positiveInteger(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function dedupe(values: string[]): string[] {
  return [...new Set(values)];
}

let generatedSessionId: string | null = null;
function processSessionId(): string {
  const configured = envValue("CLAUDE_CODE_SESSION_ID");
  if (configured) return configured;
  generatedSessionId ??= randomId();
  return generatedSessionId;
}

let generatedDeviceId: string | null = null;
function stableDeviceId(): string {
  generatedDeviceId ??= longHash(`switchboard:${processSessionId()}`);
  return generatedDeviceId;
}

function claudeCodeVersion(): string {
  return envValue("ANTHROPIC_SUBSCRIPTION_CLAUDE_CODE_VERSION")
    ?? envValue("CLAUDE_CODE_VERSION")
    ?? "1.0.0";
}

function claudeCodeUserAgent(): string {
  const userType = envValue("USER_TYPE") ?? "external";
  const entrypoint = envValue("CLAUDE_CODE_ENTRYPOINT") ?? "cli";
  const workload = envValue("ANTHROPIC_SUBSCRIPTION_WORKLOAD") ?? envValue("CLAUDE_CODE_WORKLOAD") ?? "coding-harness";
  return `claude-cli/${claudeCodeVersion()} (${userType}, ${entrypoint}, workload/${workload})`;
}

function runtimeVersion(): string {
  const processLike = (globalThis as { process?: { version?: string } }).process;
  return envValue("ANTHROPIC_SUBSCRIPTION_NODE_VERSION")
    ?? envValue("CLAUDE_CODE_NODE_VERSION")
    ?? processLike?.version
    ?? "v22.11.0";
}

function runtimeOs(): string {
  const processLike = (globalThis as { process?: { platform?: string } }).process;
  const value = processLike?.platform ?? "";
  if (value === "darwin") return "MacOS";
  if (value === "win32") return "Windows";
  if (value === "linux") return "Linux";
  if (value === "freebsd") return "FreeBSD";
  if (value === "openbsd") return "OpenBSD";
  return value ? `Other:${value}` : "Unknown";
}

function runtimeArch(): string {
  const processLike = (globalThis as { process?: { arch?: string } }).process;
  const value = processLike?.arch ?? "";
  if (value === "x64") return "x64";
  if (value === "arm64") return "arm64";
  if (value === "ia32") return "x32";
  return value || "unknown";
}

function apiTimeoutMs(): number {
  return positiveInteger(envValue("API_TIMEOUT_MS")) ?? DEFAULT_API_TIMEOUT_MS;
}

function isFirstPartyAnthropicBaseUrl(baseUrl: string): boolean {
  try {
    return new URL(baseUrl).hostname.toLowerCase() === "api.anthropic.com";
  } catch {
    return false;
  }
}

function utf8Length(value: string): number {
  return new TextEncoder().encode(value).length;
}

function randomId(): string {
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.randomUUID) return cryptoRef.randomUUID();
  return `${randomHex(8)}-${randomHex(4)}-4${randomHex(3)}-8${randomHex(3)}-${randomHex(12)}`;
}

function randomHex(length: number): string {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  const cryptoRef = globalThis.crypto;
  if (cryptoRef?.getRandomValues) {
    cryptoRef.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, length);
}

function randomCch(messages: Array<Record<string, unknown>>): string {
  return shortHash(JSON.stringify(messages), 5);
}

function shortHash(value: string, length = 3): string {
  return longHash(value).slice(0, length);
}

function longHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  const base = (hash >>> 0).toString(16).padStart(8, "0");
  return base.repeat(Math.ceil(64 / base.length)).slice(0, 64);
}
