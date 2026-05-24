// ChatGPT subscription Responses contract.
// Mirrors the audited LiteLLM ChatGPT/Codex provider contract rather than the
// generic OpenAI Platform Responses API.

import type { Deployment } from "../config/schema";
import { SubscriptionTokenError } from "../nim/classify/provider-failure";
import type { ProviderRequest } from "./base";

// ─── Responses API request shape ───────────────────────────────────

export const CHATGPT_RESPONSES_BACKEND_PATH = "/backend-api/codex/responses";
export const DEFAULT_CHATGPT_RESPONSES_BASE_URL = "https://chatgpt.com";
export const CHATGPT_RESPONSES_ENCRYPTED_REASONING_INCLUDE = "reasoning.encrypted_content";
export const CHATGPT_DEFAULT_INSTRUCTIONS_SENTINEL = "<litellm_chatgpt_default_instructions>";

const CHATGPT_RESPONSES_ALLOWED_BODY_FIELDS = new Set([
  "model",
  "input",
  "instructions",
  "stream",
  "store",
  "include",
  "tools",
  "tool_choice",
  "reasoning",
  "previous_response_id",
  "truncation",
]);

const CHATGPT_RESPONSES_FORBIDDEN_REQUEST_FIELDS = new Set([
  "api_base",
  "api_key",
  "background",
  "client_metadata",
  "extra_body",
  "frequency_penalty",
  "include_reasoning",
  "logit_bias",
  "logprobs",
  "max_output_tokens",
  "max_tokens",
  "messages",
  "n",
  "parallel_tool_calls",
  "presence_penalty",
  "prompt",
  "prompt_cache_key",
  "reasoning",
  "reasoning_effort",
  "response_format",
  "seed",
  "service_tier",
  "stop",
  "stream_options",
  "temperature",
  "text",
  "thinking",
  "top_k",
  "top_logprobs",
  "top_p",
  "user",
]);

const CHATGPT_RESPONSES_FORBIDDEN_METADATA_FIELDS = new Set([
  "access_token",
  "account_id",
  "api_key",
  "authorization",
  "client_metadata",
  "cookie",
  "file_path",
  "id_token",
  "path",
  "private_path",
  "prompt",
  "refresh_token",
  "session_id",
]);

const CHATGPT_RESPONSES_ALLOWED_REASONING_EFFORTS = new Set([
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
]);

export const CHATGPT_SUBSCRIPTION_AUTH_REQUIRED_FIELDS = [
  "access_token",
  "refresh_token",
  "id_token",
] as const;

export interface ResponsesAPIRequest {
  model: string;
  input: Array<ResponseInputItem>;
  instructions?: string;
  stream: true;
  store: false;
  include: unknown[];
  tools?: Array<Record<string, unknown>>;
  reasoning?: { effort: string };
  tool_choice?: unknown;
  previous_response_id?: unknown;
  truncation?: unknown;
}

export type ResponseInputItem = Record<string, unknown>;

export interface ChatGPTSubscriptionAuth {
  accessToken: string;
  source: "structured" | "legacy";
}

interface ChatGPTSubscriptionAuthOptions {
  credentialName?: string;
  allowLegacyAccessToken?: boolean;
}

// ─── Build ChatGPT Responses request ───────────────────────────────

export function buildChatGPTResponsesRequest(
  deployment: Deployment,
  body: Record<string, unknown>,
  authMaterial: string,
): ProviderRequest {
  const bodyContract = validateResponsesContract(body);
  if (!bodyContract.valid) {
    throw new Error(`Responses contract violation: ${bodyContract.reason}`);
  }
  const auth = resolveChatGPTSubscriptionAuth(authMaterial, {
    credentialName: "ChatGPT Responses subscription auth",
    allowLegacyAccessToken: true,
  });
  const accessToken = auth.accessToken;
  validateDeploymentContract(deployment, accessToken);

  const url = buildChatGPTResponsesUrl(deployment);

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Authorization": `Bearer ${accessToken}`,
  };

  const responsesBody: ResponsesAPIRequest = {
    model: deployment.providerModel,
    instructions: typeof body.instructions === "string"
      ? body.instructions
      : CHATGPT_DEFAULT_INSTRUCTIONS_SENTINEL,
    input: normalizeChatGPTResponsesInput(body.input),
    stream: true,
    store: false,
    include: includeWithEncryptedReasoning(body.include),
    reasoning: { effort: deployment.reasoningEffort! },
  };

  copyIfPresent(responsesBody, body, "tools");
  copyIfPresent(responsesBody, body, "tool_choice");
  copyIfPresent(responsesBody, body, "previous_response_id");
  copyIfPresent(responsesBody, body, "truncation");

  return {
    url,
    method: "POST",
    headers,
    body: JSON.stringify(responsesBody),
  };
}

// ─── ChatGPT subscription auth parsing ─────────────────────────────

export function isChatGPTSubscriptionAuthJsonText(value: string): boolean {
  return value.trim().startsWith("{");
}

export function resolveChatGPTSubscriptionAuth(
  authMaterial: string,
  options: ChatGPTSubscriptionAuthOptions = {},
): ChatGPTSubscriptionAuth {
  const credentialName = options.credentialName ?? "ChatGPT subscription auth";
  const raw = authMaterial.trim();
  if (!raw) {
    throw chatgptAuthError(`${credentialName} is required`);
  }

  if (isChatGPTSubscriptionAuthJsonText(raw)) {
    return parseStructuredChatGPTAuth(raw, credentialName);
  }

  if (!options.allowLegacyAccessToken) {
    throw chatgptAuthError(
      `${credentialName} must be structured JSON with required fields: `
      + CHATGPT_SUBSCRIPTION_AUTH_REQUIRED_FIELDS.join(", "),
    );
  }

  return {
    accessToken: validateChatGPTAccessToken(raw, credentialName),
    source: "legacy",
  };
}

function parseStructuredChatGPTAuth(raw: string, credentialName: string): ChatGPTSubscriptionAuth {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw chatgptAuthError(`${credentialName} must be valid JSON`);
  }

  if (!isPlainRecord(parsed)) {
    throw chatgptAuthError(`${credentialName} must be a flat JSON object`);
  }

  const missing = CHATGPT_SUBSCRIPTION_AUTH_REQUIRED_FIELDS.filter((field) => {
    const value = parsed[field];
    return typeof value !== "string" || value.trim() === "";
  });
  if (missing.length > 0) {
    throw chatgptAuthError(`${credentialName} is missing required fields: ${missing.join(", ")}`);
  }

  return {
    accessToken: validateChatGPTAccessToken(parsed.access_token as string, credentialName),
    source: "structured",
  };
}

// ─── Convert Responses API response to OpenAI chat format ──────────

export function convertResponsesToOpenAI(
  responsesBody: Record<string, unknown>,
  requestId: string,
): Record<string, unknown> {
  const output = (responsesBody.output as Array<Record<string, unknown>>) ?? [];

  // Extract text content
  const textContent: string[] = [];
  const toolCalls: Array<Record<string, unknown>> = [];

  for (const item of output) {
    if (item.type === "message") {
      const content = item.content as Array<Record<string, unknown>> ?? [];
      for (const block of content) {
        if (block.type === "output_text") {
          textContent.push(block.text as string);
        }
      }
    } else if (item.type === "function_call") {
      toolCalls.push({
        id: item.id ?? `call_${toolCalls.length}`,
        type: "function",
        function: {
          name: item.name,
          arguments: item.arguments,
        },
      });
    }
  }

  const finishReason = toolCalls.length > 0 ? "tool_calls" : "stop";

  const message: Record<string, unknown> = {
    role: "assistant",
    content: textContent.join(""),
  };
  if (toolCalls.length > 0) message.tool_calls = toolCalls;

  const usage = responsesBody.usage as Record<string, number> | undefined;

  return {
    id: responsesBody.id ?? requestId,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: responsesBody.model ?? "unknown",
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

// ─── Convert Responses stream event to OpenAI SSE chunk ────────────

export function convertResponsesStreamChunk(
  event: Record<string, unknown>,
  requestId: string,
  model: string,
  toolCallIndexMap?: Map<number, number>,
): Record<string, unknown> | null {
  const type = event.type as string;

  if (type === "response.output_text.delta") {
    return {
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: { content: event.delta as string },
        finish_reason: null,
      }],
    };
  }

  if (type === "response.output_item.added") {
    const item = event.item as Record<string, unknown> | undefined;
    if (item?.type === "function_call") {
      const outputIdx = (event.output_index as number) ?? 0;
      const callIndex = toolCallIndexMap?.get(outputIdx) ?? outputIdx;
      return {
        id: requestId,
        object: "chat.completion.chunk",
        created: Math.floor(Date.now() / 1000),
        model,
        choices: [{
          index: 0,
          delta: {
            tool_calls: [{
              index: callIndex,
              id: item.id,
              type: "function",
              function: { name: item.name, arguments: "" },
            }],
          },
          finish_reason: null,
        }],
      };
    }
    return null;
  }

  if (type === "response.function_call_arguments.delta") {
    const outputIdx = (event.output_index as number) ?? 0;
    const callIndex = toolCallIndexMap?.get(outputIdx) ?? outputIdx;
    return {
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: {
          tool_calls: [{
            index: callIndex,
            function: { arguments: event.delta as string },
          }],
        },
        finish_reason: null,
      }],
    };
  }

  if (type === "response.output_item.done") {
    // Tool call header was emitted at output_item.added; argument deltas are done.
    // No additional data needed for function_call items.
    return null;
  }

  if (type === "response.completed") {
    const response = event.response as Record<string, unknown> | undefined;
    const status = response?.status as string;
    const result: Record<string, unknown> = {
      id: requestId,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model,
      choices: [{
        index: 0,
        delta: {},
        finish_reason: status === "incomplete" ? "length" : "stop",
      }],
    };
    const respUsage = response?.usage as Record<string, number> | undefined;
    if (respUsage) {
      result.usage = {
        prompt_tokens: respUsage.input_tokens ?? 0,
        completion_tokens: respUsage.output_tokens ?? 0,
        total_tokens: (respUsage.input_tokens ?? 0) + (respUsage.output_tokens ?? 0),
      };
    }
    return result;
  }

  // Skip noise events
  return null;
}

// ─── Validate request is compatible with Responses API ─────────────

export interface ResponsesContractResult {
  valid: boolean;
  reason?: string;
  forbiddenFields?: string[];
}

export function validateResponsesContract(body: Record<string, unknown>): ResponsesContractResult {
  if (!hasOwn(body, "input") || body.input === null || body.input === undefined) {
    return { valid: false, reason: "input is required for ChatGPT Responses lanes" };
  }

  const invalidInput = validateInput(body.input);
  if (invalidInput) {
    return { valid: false, reason: invalidInput };
  }

  const forbiddenFields = presentForbiddenFields(body);
  if (forbiddenFields.length > 0) {
    return {
      valid: false,
      reason: `unsupported ChatGPT Responses request fields: ${forbiddenFields.join(", ")}`,
      forbiddenFields,
    };
  }

  for (const [field, value] of Object.entries(body)) {
    if (value === null || value === undefined) continue;
    if (field === "metadata") continue;
    if (!CHATGPT_RESPONSES_ALLOWED_BODY_FIELDS.has(field)) {
      return {
        valid: false,
        reason: `unsupported ChatGPT Responses request fields: ${field}`,
        forbiddenFields: [field],
      };
    }
  }

  if (body.include !== undefined && body.include !== null && !Array.isArray(body.include)) {
    return { valid: false, reason: "include must be an array when provided" };
  }
  if (body.tools !== undefined && body.tools !== null && !Array.isArray(body.tools)) {
    return { valid: false, reason: "tools must be an array when provided" };
  }
  if (body.stream !== undefined && body.stream !== null && typeof body.stream !== "boolean") {
    return { valid: false, reason: "stream must be a boolean when provided" };
  }
  if (body.store !== undefined && body.store !== null && typeof body.store !== "boolean") {
    return { valid: false, reason: "store must be a boolean when provided" };
  }
  if (body.instructions !== undefined && body.instructions !== null && typeof body.instructions !== "string") {
    return { valid: false, reason: "instructions must be a string when provided" };
  }
  if (body.metadata !== undefined && body.metadata !== null) {
    const metadata = body.metadata;
    if (typeof metadata !== "object" || Array.isArray(metadata)) {
      return { valid: false, reason: "metadata must be an object when provided" };
    }
  }

  return { valid: true };
}

// ─── Helpers ───────────────────────────────────────────────────────

export function chatgptResponsesTextInput(text: string): Array<ResponseInputItem> {
  return [{
    type: "message",
    role: "user",
    content: [{ type: "input_text", text }],
  }];
}

export function normalizeChatGPTResponsesInput(value: unknown): Array<ResponseInputItem> {
  if (typeof value === "string") {
    return chatgptResponsesTextInput(value);
  }
  if (!Array.isArray(value)) {
    throw new Error("input must be a string or array for ChatGPT Responses lanes");
  }
  return value.map((item) => normalizeInputItem(item));
}

function normalizeInputItem(item: unknown): ResponseInputItem {
  if (typeof item === "string") {
    return chatgptResponsesTextInput(item)[0];
  }
  if (!isPlainRecord(item)) {
    throw new Error("input array items must be strings or objects");
  }
  const normalized = cloneValue(item);
  if (hasOwn(normalized, "role") && hasOwn(normalized, "content")) {
    normalized.type ??= "message";
    normalized.content = normalizeMessageContent(normalized.content);
  }
  return normalized;
}

function normalizeMessageContent(content: unknown): unknown {
  if (typeof content === "string") {
    return [{ type: "input_text", text: content }];
  }
  if (Array.isArray(content)) {
    return content.map((item) => (
      typeof item === "string"
        ? { type: "input_text", text: item }
        : cloneValue(item)
    ));
  }
  return cloneValue(content);
}

function includeWithEncryptedReasoning(value: unknown): unknown[] {
  const include = Array.isArray(value) ? value.map((item) => cloneValue(item)) : [];
  if (!include.includes(CHATGPT_RESPONSES_ENCRYPTED_REASONING_INCLUDE)) {
    include.push(CHATGPT_RESPONSES_ENCRYPTED_REASONING_INCLUDE);
  }
  return include;
}

function copyIfPresent(
  target: ResponsesAPIRequest,
  source: Record<string, unknown>,
  field: "tools" | "tool_choice" | "previous_response_id" | "truncation",
): void {
  const value = source[field];
  if (value !== null && value !== undefined) {
    (target as unknown as Record<string, unknown>)[field] = cloneValue(value);
  }
}

function validateDeploymentContract(deployment: Deployment, accessToken: string): void {
  if (deployment.provider !== "chatgpt" || deployment.mode !== "responses") {
    throw new Error("ChatGPT Responses provider requires provider='chatgpt' and mode='responses'");
  }
  if (!deployment.reasoningEffort) {
    throw new Error("ChatGPT Responses deployments require reasoningEffort");
  }
  if (!CHATGPT_RESPONSES_ALLOWED_REASONING_EFFORTS.has(deployment.reasoningEffort)) {
    throw new Error(`Unsupported ChatGPT Responses reasoningEffort: ${deployment.reasoningEffort}`);
  }
  const configuredParams = nonNullKeys(deployment.params);
  const configuredExtraBody = nonNullKeys(deployment.extraBody);
  if (configuredParams.length > 0 || configuredExtraBody.length > 0) {
    throw new Error(
      "ChatGPT Responses deployments must not configure provider body params or extraBody: "
      + [...configuredParams, ...configuredExtraBody.map((key) => `extraBody.${key}`)].join(", "),
    );
  }
  const token = accessToken.trim();
  if (!token) {
    throw new Error("ChatGPT Responses deployments require an OAuth access token");
  }
  if (/^sk-[A-Za-z0-9]/.test(token)) {
    throw new Error("ChatGPT Responses deployments require subscription OAuth, not an OpenAI API key");
  }
}

function validateChatGPTAccessToken(accessToken: string, credentialName: string): string {
  const token = accessToken.trim();
  if (!token) {
    throw chatgptAuthError(`${credentialName} requires a non-empty access_token`);
  }
  if (/^sk-[A-Za-z0-9]/.test(token)) {
    throw chatgptAuthError(`${credentialName} requires subscription OAuth, not an OpenAI API key`);
  }
  return token;
}

function chatgptAuthError(message: string): SubscriptionTokenError {
  return new SubscriptionTokenError(message, "oauth_session_failure");
}

function buildChatGPTResponsesUrl(deployment: Deployment): string {
  const base = (deployment.apiBase ?? DEFAULT_CHATGPT_RESPONSES_BASE_URL).trim().replace(/\/+$/, "");
  const url = new URL(base);
  if (url.hostname === "api.openai.com") {
    throw new Error("ChatGPT Responses deployments must not use generic OpenAI API Platform base URLs");
  }
  if (base.endsWith(CHATGPT_RESPONSES_BACKEND_PATH)) {
    return base;
  }
  return `${base}${CHATGPT_RESPONSES_BACKEND_PATH}`;
}

function validateInput(value: unknown): string | null {
  if (typeof value === "string") return null;
  if (!Array.isArray(value)) {
    return "input must be a string or array for ChatGPT Responses lanes";
  }
  for (let i = 0; i < value.length; i++) {
    const item = value[i];
    if (typeof item === "string") continue;
    if (!isPlainRecord(item)) {
      return `input[${i}] must be a string or object`;
    }
  }
  return null;
}

function presentForbiddenFields(body: Record<string, unknown>): string[] {
  const present: string[] = [];
  for (const field of Array.from(CHATGPT_RESPONSES_FORBIDDEN_REQUEST_FIELDS).sort()) {
    if (!hasOwn(body, field)) continue;
    const value = body[field];
    if (value === null || value === undefined) continue;
    present.push(field);
  }

  const metadata = body.metadata;
  if (isPlainRecord(metadata)) {
    for (const [key, value] of Object.entries(metadata)) {
      const normalized = key.trim().toLowerCase();
      if (normalized.startsWith("nim_")) continue;
      if (CHATGPT_RESPONSES_FORBIDDEN_METADATA_FIELDS.has(normalized) || looksLikePrivatePath(value)) {
        present.push(`metadata.${normalized}`);
        continue;
      }
      present.push(`metadata.${normalized}`);
    }
  }
  return present;
}

function looksLikePrivatePath(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const stripped = value.trim();
  return stripped.startsWith("/")
    || stripped.startsWith("~/")
    || stripped.includes("/.secrets/")
    || stripped.includes("\\");
}

function nonNullKeys(record: Record<string, unknown> | undefined): string[] {
  if (!record) return [];
  return Object.entries(record)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key]) => key)
    .sort();
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function cloneValue<T>(value: T): T {
  if (value === null || typeof value !== "object") return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

function hasOwn(record: Record<string, unknown>, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}
