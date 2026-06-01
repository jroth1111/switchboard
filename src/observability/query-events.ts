// Query visibility events: safe-by-default request shape observability.

import { redact } from "./receipt";

export type QueryVisibilityTier = "shape" | "redacted" | "raw";
export type QueryEventStage = "incoming" | "post_transform" | "provider_request";

export interface QueryCaptureConfig {
  requestedTier: QueryVisibilityTier;
  effectiveTier: QueryVisibilityTier;
  rawDisabledReason?: string;
  rawKey?: string;
}

export interface QueryEventPayload {
  requestId: string;
  timestamp: number;
  stage: QueryEventStage;
  clientId?: string;
  appId?: string;
  userHash?: string;
  policyId?: string;
  policyVersion?: string;
  routeVersion?: string;
  sessionId?: string;
  traceId?: string;
  properties?: Record<string, string>;
  originalModel?: string;
  canonicalTarget?: string;
  selectedGroup?: string;
  visibilityTier: QueryVisibilityTier;
  effectiveTier: QueryVisibilityTier;
  rawDisabledReason?: string;
  bodySha256: string;
  bodyBytes: number;
  event: QueryEventBody;
}

export interface QueryEventBody {
  shape: QueryShape;
  redacted?: unknown;
  encryptedRaw?: EncryptedRawPayload;
}

export interface QueryShape {
  bodyBytes: number;
  bodySha256: string;
  model?: string;
  surface?: string;
  stream?: boolean;
  topLevelKeys: string[];
  messages?: {
    count: number;
    roles: string[];
    stringContentCount: number;
    typedContentPartCount: number;
  };
  responsesInput?: {
    kind: "string" | "array" | "object" | "other" | "absent";
    itemCount?: number;
    contentPartCount?: number;
  };
  tools?: {
    count: number;
    names: string[];
  };
  outputTokenCap?: number;
  providerRequest?: {
    urlOrigin?: string;
    urlPath?: string;
    method?: string;
    headerNames?: string[];
  };
}

export interface EncryptedRawPayload {
  alg: "AES-GCM";
  iv: string;
  ciphertext: string;
}

export const DEFAULT_QUERY_CAPTURE_MAX_EVENTS = 50;
export const MAX_QUERY_CAPTURE_MAX_EVENTS = 200;

const PROMPT_FIELD_NAMES = new Set([
  "body", "content", "input", "instructions", "message", "messages",
  "prompt", "system", "text", "input_text", "output_text", "summary_text",
  "custom", "metadata",
]);

/** Short structural string fields that may appear in tool/provider payloads. */
const STRUCTURAL_STRING_FIELDS = new Set([
  "name", "type", "role", "id", "model", "object", "status", "code",
]);

export function parseQueryCaptureMaxEvents(
  env: Record<string, unknown> | Env | undefined,
): number {
  const raw = readString(env, "SWITCHBOARD_QUERY_CAPTURE_MAX_EVENTS")
    ?? readString(env, "QUERY_CAPTURE_MAX_EVENTS");
  if (!raw) return DEFAULT_QUERY_CAPTURE_MAX_EVENTS;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return DEFAULT_QUERY_CAPTURE_MAX_EVENTS;
  return Math.min(parsed, MAX_QUERY_CAPTURE_MAX_EVENTS);
}

/**
 * Trims captured query events for retention.
 *
 * Groups by `requestId` (stable order of first appearance). Within each group,
 * keeps the newest `max` events by input order (later entries are newer).
 * When `max <= 0`, returns an empty array.
 */
export function trimQueryEventsForRetention<T extends { requestId: string }>(
  events: T[],
  max: number,
): T[] {
  if (max <= 0) return [];
  if (events.length === 0) return [];

  const groups = new Map<string, T[]>();
  const order: string[] = [];
  for (const event of events) {
    if (!groups.has(event.requestId)) {
      groups.set(event.requestId, []);
      order.push(event.requestId);
    }
    groups.get(event.requestId)!.push(event);
  }

  const result: T[] = [];
  for (const requestId of order) {
    const group = groups.get(requestId)!;
    const start = Math.max(0, group.length - max);
    result.push(...group.slice(start));
  }
  return result;
}

/** Opt-in: capture only when explicitly enabled (tier alone does not turn capture on). */
export function isQueryCaptureEnabled(env: Record<string, unknown> | Env | undefined): boolean {
  return readString(env, "SWITCHBOARD_QUERY_CAPTURE_ENABLED") === "true"
    || readString(env, "QUERY_CAPTURE_ENABLED") === "true";
}

export function resolveQueryCaptureConfig(
  env: Record<string, unknown> | Env | undefined,
  rawPolicyAllowed = false,
): QueryCaptureConfig {
  const requestedTier = parseTier(readString(env, "SWITCHBOARD_QUERY_CAPTURE_TIER") ?? readString(env, "QUERY_CAPTURE_TIER"));
  if (requestedTier !== "raw") {
    return { requestedTier, effectiveTier: requestedTier };
  }

  const rawEnabled = readString(env, "SWITCHBOARD_QUERY_CAPTURE_RAW_ENABLED") === "true";
  const rawKey = readString(env, "SWITCHBOARD_QUERY_CAPTURE_RAW_KEY");
  if (!rawEnabled) {
    return {
      requestedTier,
      effectiveTier: "shape",
      rawDisabledReason: "raw capture disabled",
    };
  }
  if (!rawKey) {
    return {
      requestedTier,
      effectiveTier: "shape",
      rawDisabledReason: "raw capture key missing",
    };
  }
  if (!rawPolicyAllowed) {
    return {
      requestedTier,
      effectiveTier: "shape",
      rawDisabledReason: "raw capture policy not allowed",
    };
  }
  return { requestedTier, effectiveTier: "raw", rawKey };
}

export function sanitizeQueryEventBody(event: QueryEventBody): QueryEventBody {
  const sanitized: QueryEventBody = { shape: event.shape };
  if (event.redacted !== undefined) sanitized.redacted = redactPromptFields(event.redacted);
  if (event.encryptedRaw !== undefined) sanitized.encryptedRaw = event.encryptedRaw;
  return sanitized;
}

export async function buildQueryEvent(params: {
  requestId: string;
  stage: QueryEventStage;
  body: unknown;
  surface?: string;
  config: QueryCaptureConfig;
  timestamp?: number;
  clientId?: string;
  appId?: string;
  userHash?: string;
  policyId?: string;
  policyVersion?: string;
  routeVersion?: string;
  sessionId?: string;
  traceId?: string;
  properties?: Record<string, string>;
  originalModel?: string;
  canonicalTarget?: string;
  selectedGroup?: string;
  providerRequest?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
  };
}): Promise<QueryEventPayload> {
  const stableBody = safeJson(params.body);
  const bodySha256 = await sha256Hex(stableBody);
  const bodyBytes = new TextEncoder().encode(stableBody).byteLength;
  const shape = buildQueryShape(params.body, {
    surface: params.surface,
    bodyBytes,
    bodySha256,
    providerRequest: params.providerRequest,
  });
  const event: QueryEventBody = { shape };
  if (params.config.effectiveTier === "redacted") {
    event.redacted = redactPromptFields(params.body);
  } else if (params.config.effectiveTier === "raw" && params.config.rawKey) {
    event.encryptedRaw = await encryptRaw(stableBody, params.config.rawKey);
  }

  return {
    requestId: params.requestId,
    timestamp: params.timestamp ?? Date.now(),
    stage: params.stage,
    clientId: params.clientId,
    appId: params.appId,
    userHash: params.userHash,
    policyId: params.policyId,
    policyVersion: params.policyVersion,
    routeVersion: params.routeVersion,
    sessionId: params.sessionId,
    traceId: params.traceId,
    properties: params.properties,
    originalModel: params.originalModel,
    canonicalTarget: params.canonicalTarget,
    selectedGroup: params.selectedGroup,
    visibilityTier: params.config.requestedTier,
    effectiveTier: params.config.effectiveTier,
    rawDisabledReason: params.config.rawDisabledReason,
    bodySha256,
    bodyBytes,
    event,
  };
}

export async function buildQueryShapeOnly(
  body: unknown,
  surface?: string,
  providerRequest?: { url?: string; method?: string; headers?: Record<string, string> },
): Promise<QueryShape> {
  const stableBody = safeJson(body);
  const bodySha256 = await sha256Hex(stableBody);
  const bodyBytes = new TextEncoder().encode(stableBody).byteLength;
  return buildQueryShape(body, { surface, bodyBytes, bodySha256, providerRequest });
}

function buildQueryShape(
  body: unknown,
  params: {
    surface?: string;
    bodyBytes: number;
    bodySha256: string;
    providerRequest?: { url?: string; method?: string; headers?: Record<string, string> };
  },
): QueryShape {
  const record = isPlainRecord(body) ? body : {};
  const shape: QueryShape = {
    bodyBytes: params.bodyBytes,
    bodySha256: params.bodySha256,
    model: stringValue(record.model),
    surface: params.surface,
    stream: typeof record.stream === "boolean" ? record.stream : undefined,
    topLevelKeys: Object.keys(record).sort(),
    messages: summarizeMessages(record.messages),
    responsesInput: summarizeResponsesInput(record.input),
    tools: summarizeTools(record.tools),
    outputTokenCap: positiveNumber(record.max_completion_tokens)
      ?? positiveNumber(record.max_tokens)
      ?? positiveNumber(record.max_output_tokens),
  };

  if (params.providerRequest) {
    shape.providerRequest = summarizeProviderRequest(params.providerRequest);
  }
  return shape;
}

function summarizeProviderRequest(request: {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
}): QueryShape["providerRequest"] {
  let urlOrigin: string | undefined;
  let urlPath: string | undefined;
  if (request.url) {
    try {
      const url = new URL(request.url);
      urlOrigin = url.origin;
      urlPath = url.pathname;
    } catch {
      urlPath = "<invalid-url>";
    }
  }
  return {
    urlOrigin,
    urlPath,
    method: request.method,
    headerNames: Object.keys(request.headers ?? {}).map((name) => name.toLowerCase()).sort(),
  };
}

function summarizeMessages(value: unknown): QueryShape["messages"] {
  if (!Array.isArray(value)) return undefined;
  const roles: string[] = [];
  let stringContentCount = 0;
  let typedContentPartCount = 0;
  for (const item of value) {
    if (!isPlainRecord(item)) continue;
    const role = stringValue(item.role);
    if (role) roles.push(role);
    if (typeof item.content === "string") stringContentCount++;
    if (Array.isArray(item.content)) typedContentPartCount += item.content.length;
  }
  return {
    count: value.length,
    roles,
    stringContentCount,
    typedContentPartCount,
  };
}

function summarizeResponsesInput(value: unknown): QueryShape["responsesInput"] {
  if (value === undefined) return { kind: "absent" };
  if (typeof value === "string") return { kind: "string" };
  if (Array.isArray(value)) {
    let contentPartCount = 0;
    for (const item of value) {
      if (isPlainRecord(item) && Array.isArray(item.content)) contentPartCount += item.content.length;
    }
    return { kind: "array", itemCount: value.length, contentPartCount };
  }
  if (isPlainRecord(value)) return { kind: "object" };
  return { kind: "other" };
}

function summarizeTools(value: unknown): QueryShape["tools"] {
  if (!Array.isArray(value)) return undefined;
  const names: string[] = [];
  for (const tool of value) {
    if (!isPlainRecord(tool)) continue;
    const functionRecord = isPlainRecord(tool.function) ? tool.function : {};
    const name = stringValue(functionRecord.name) ?? stringValue(tool.name);
    if (name) names.push(name);
  }
  return { count: value.length, names };
}

function redactPromptFields(value: unknown, path: string[] = []): unknown {
  if (value === null || value === undefined) return value;
  const fieldName = path.at(-1)?.toLowerCase();
  if (typeof value === "string") {
    if (fieldName && PROMPT_FIELD_NAMES.has(fieldName)) {
      return { redacted: true, type: "string", length: value.length };
    }
    if (fieldName && STRUCTURAL_STRING_FIELDS.has(fieldName)) {
      return redact(value);
    }
    return { redacted: true, type: "string", length: value.length };
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => redactPromptFields(item, [...path, String(index)]));
  }
  if (!isPlainRecord(value)) return value;

  const result: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (PROMPT_FIELD_NAMES.has(key.toLowerCase())) {
      result[key] = summarizePromptField(item);
    } else {
      result[key] = redactPromptFields(item, [...path, key]);
    }
  }
  return result;
}

function summarizePromptField(value: unknown): unknown {
  if (typeof value === "string") {
    return { redacted: true, type: "string", length: value.length };
  }
  if (Array.isArray(value)) {
    return {
      redacted: true,
      type: "array",
      count: value.length,
      items: value.map((item) => summarizePromptItem(item)),
    };
  }
  if (isPlainRecord(value)) {
    return { redacted: true, type: "object", keys: Object.keys(value).sort() };
  }
  return { redacted: true, type: typeof value };
}

function summarizePromptItem(value: unknown): unknown {
  if (!isPlainRecord(value)) return { type: typeof value };
  return {
    role: stringValue(value.role),
    type: stringValue(value.type),
    keys: Object.keys(value).sort(),
    content: Array.isArray(value.content)
      ? { type: "array", count: value.content.length }
      : typeof value.content === "string"
        ? { type: "string", length: value.content.length }
        : value.content === undefined
          ? undefined
          : { type: typeof value.content },
  };
}

async function encryptRaw(plaintext: string, secret: string): Promise<EncryptedRawPayload> {
  const keyMaterial = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(secret));
  const key = await crypto.subtle.importKey("raw", keyMaterial, { name: "AES-GCM" }, false, ["encrypt"]);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(plaintext));
  return {
    alg: "AES-GCM",
    iv: base64(iv),
    ciphertext: base64(new Uint8Array(ciphertext)),
  };
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function base64(bytes: Uint8Array): string {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value ?? null);
  } catch {
    return JSON.stringify(String(value));
  }
}

function parseTier(value: string | undefined): QueryVisibilityTier {
  if (value === "redacted" || value === "raw") return value;
  return "shape";
}

function readString(env: Record<string, unknown> | Env | undefined, key: string): string | undefined {
  const value = (env as Record<string, unknown> | undefined)?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function positiveNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.ceil(value) : undefined;
}
