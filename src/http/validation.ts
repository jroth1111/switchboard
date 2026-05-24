// Input validation for incoming chat completion requests.

import { MAX_BODY_SIZE, MAX_MESSAGES, MAX_TOOLS, MAX_TOOL_NAME_LENGTH } from "../config/constants";

export interface ValidationResult {
  valid: boolean;
  error?: { message: string; type: string; code: string };
  sanitized?: Record<string, unknown>;
}

export { MAX_BODY_SIZE };

export function validateChatRequest(body: Record<string, unknown>): ValidationResult {
  // Model
  const model = body.model;
  if (!model || typeof model !== "string") {
    return { valid: false, error: { message: "model is required and must be a string", type: "invalid_request", code: "invalid_model" } };
  }
  if (model.length > 256) {
    return { valid: false, error: { message: "model name too long (max 256 chars)", type: "invalid_request", code: "invalid_model" } };
  }

  // Messages
  const messages = body.messages;
  if (!messages || !Array.isArray(messages)) {
    return { valid: false, error: { message: "messages is required and must be an array", type: "invalid_request", code: "invalid_messages" } };
  }
  if (messages.length === 0) {
    return { valid: false, error: { message: "messages must not be empty", type: "invalid_request", code: "invalid_messages" } };
  }
  if (messages.length > MAX_MESSAGES) {
    return { valid: false, error: { message: `too many messages (max ${MAX_MESSAGES})`, type: "invalid_request", code: "invalid_messages" } };
  }

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i] as Record<string, unknown>;
    if (!msg.role || typeof msg.role !== "string") {
      return { valid: false, error: { message: `messages[${i}].role is required`, type: "invalid_request", code: "invalid_messages" } };
    }
    if (!["system", "user", "assistant", "tool"].includes(msg.role as string)) {
      return { valid: false, error: { message: `messages[${i}].role '${msg.role}' is not supported`, type: "invalid_request", code: "invalid_messages" } };
    }
  }

  // Tools
  if (body.tools) {
    if (!Array.isArray(body.tools)) {
      return { valid: false, error: { message: "tools must be an array", type: "invalid_request", code: "invalid_tools" } };
    }
    if ((body.tools as unknown[]).length > MAX_TOOLS) {
      return { valid: false, error: { message: `too many tools (max ${MAX_TOOLS})`, type: "invalid_request", code: "invalid_tools" } };
    }
    for (let i = 0; i < (body.tools as unknown[]).length; i++) {
      const tool = (body.tools as Record<string, unknown>[])[i];
      const fn = tool?.function as Record<string, unknown> | undefined;
      if (fn?.name && typeof fn.name === "string" && fn.name.length > MAX_TOOL_NAME_LENGTH) {
        return { valid: false, error: { message: `tools[${i}].function.name too long (max ${MAX_TOOL_NAME_LENGTH})`, type: "invalid_request", code: "invalid_tools" } };
      }
    }
  }

  // Numeric parameters — Number.isFinite rejects NaN and Infinity
  if (body.temperature !== undefined && body.temperature !== null) {
    if (typeof body.temperature !== "number" || !Number.isFinite(body.temperature) || body.temperature < 0 || body.temperature > 2) {
      return { valid: false, error: { message: "temperature must be between 0 and 2", type: "invalid_request", code: "invalid_parameter" } };
    }
  }
  if (body.top_p !== undefined && body.top_p !== null) {
    if (typeof body.top_p !== "number" || !Number.isFinite(body.top_p) || body.top_p < 0 || body.top_p > 1) {
      return { valid: false, error: { message: "top_p must be between 0 and 1", type: "invalid_request", code: "invalid_parameter" } };
    }
  }
  if (body.frequency_penalty !== undefined && body.frequency_penalty !== null) {
    if (typeof body.frequency_penalty !== "number" || !Number.isFinite(body.frequency_penalty) || body.frequency_penalty < -2 || body.frequency_penalty > 2) {
      return { valid: false, error: { message: "frequency_penalty must be between -2 and 2", type: "invalid_request", code: "invalid_parameter" } };
    }
  }
  if (body.presence_penalty !== undefined && body.presence_penalty !== null) {
    if (typeof body.presence_penalty !== "number" || !Number.isFinite(body.presence_penalty) || body.presence_penalty < -2 || body.presence_penalty > 2) {
      return { valid: false, error: { message: "presence_penalty must be between -2 and 2", type: "invalid_request", code: "invalid_parameter" } };
    }
  }
  if (body.max_tokens !== undefined && body.max_tokens !== null) {
    if (typeof body.max_tokens !== "number" || !Number.isFinite(body.max_tokens) || body.max_tokens < 1 || body.max_tokens > 1000000) {
      return { valid: false, error: { message: "max_tokens must be between 1 and 1000000", type: "invalid_request", code: "invalid_parameter" } };
    }
  }
  if (body.n !== undefined && body.n !== null) {
    if (typeof body.n !== "number" || !Number.isFinite(body.n) || body.n < 1 || body.n > 10) {
      return { valid: false, error: { message: "n must be between 1 and 10", type: "invalid_request", code: "invalid_parameter" } };
    }
  }

  // stream_options
  if (body.stream_options !== undefined && body.stream_options !== null) {
    if (typeof body.stream_options !== "object" || Array.isArray(body.stream_options)) {
      return { valid: false, error: { message: "stream_options must be an object", type: "invalid_request", code: "invalid_parameter" } };
    }
    const opts = body.stream_options as Record<string, unknown>;
    if (opts.include_usage !== undefined && typeof opts.include_usage !== "boolean") {
      return { valid: false, error: { message: "stream_options.include_usage must be a boolean", type: "invalid_request", code: "invalid_parameter" } };
    }
  }

  // tool_choice
  if (body.tool_choice !== undefined && body.tool_choice !== null) {
    const tc = body.tool_choice;
    if (typeof tc === "string") {
      if (!["auto", "none", "required", "any"].includes(tc)) {
        return { valid: false, error: { message: "tool_choice must be 'auto', 'none', 'required', 'any', or an object", type: "invalid_request", code: "invalid_parameter" } };
      }
    } else if (typeof tc === "object" && !Array.isArray(tc)) {
      const tcObj = tc as Record<string, unknown>;
      if (tcObj.type !== "function") {
        return { valid: false, error: { message: "tool_choice object must have type 'function'", type: "invalid_request", code: "invalid_parameter" } };
      }
      const fn = tcObj.function;
      if (!fn || typeof fn !== "object" || typeof (fn as Record<string, unknown>).name !== "string" || !(fn as Record<string, unknown>).name) {
        return { valid: false, error: { message: "tool_choice.function.name must be a non-empty string", type: "invalid_request", code: "invalid_parameter" } };
      }
    } else {
      return { valid: false, error: { message: "tool_choice must be a string or object", type: "invalid_request", code: "invalid_parameter" } };
    }
  }

  // stop sequences
  if (body.stop !== undefined && body.stop !== null) {
    if (typeof body.stop !== "string" && !Array.isArray(body.stop)) {
      return { valid: false, error: { message: "stop must be a string or array of strings", type: "invalid_request", code: "invalid_parameter" } };
    }
    const stops = Array.isArray(body.stop) ? body.stop : [body.stop];
    if (stops.length > 4) {
      return { valid: false, error: { message: "at most 4 stop sequences allowed", type: "invalid_request", code: "invalid_parameter" } };
    }
    for (const s of stops) {
      if (typeof s !== "string") {
        return { valid: false, error: { message: "each stop sequence must be a string", type: "invalid_request", code: "invalid_parameter" } };
      }
    }
  }

  // response_format
  if (body.response_format !== undefined && body.response_format !== null) {
    if (typeof body.response_format !== "object" || Array.isArray(body.response_format)) {
      return { valid: false, error: { message: "response_format must be an object", type: "invalid_request", code: "invalid_parameter" } };
    }
    const rf = body.response_format as Record<string, unknown>;
    if (!rf.type || typeof rf.type !== "string") {
      return { valid: false, error: { message: "response_format.type is required", type: "invalid_request", code: "invalid_parameter" } };
    }
    if (!["text", "json_object", "json_schema"].includes(rf.type as string)) {
      return { valid: false, error: { message: "response_format.type must be 'text', 'json_object', or 'json_schema'", type: "invalid_request", code: "invalid_parameter" } };
    }
    if (rf.type === "json_schema" && (!rf.json_schema || typeof rf.json_schema !== "object")) {
      return { valid: false, error: { message: "response_format.json_schema is required when type is 'json_schema'", type: "invalid_request", code: "invalid_parameter" } };
    }
  }

  return { valid: true };
}

export function validateContentType(request: Request): ValidationResult {
  const method = request.method.toUpperCase();
  if (method !== "POST") return { valid: true };

  const ct = request.headers.get("Content-Type");
  if (!ct) {
    return { valid: false, error: { message: "Content-Type header is required for POST requests", type: "invalid_request", code: "missing_content_type" } };
  }
  // Accept any content-type that includes "application/json" (handles charset suffixes)
  if (!ct.toLowerCase().includes("application/json")) {
    return { valid: false, error: { message: "Content-Type must be application/json", type: "invalid_request", code: "invalid_content_type" } };
  }
  return { valid: true };
}

export function validateBodySize(contentLength: number | null): ValidationResult {
  if (contentLength !== null && contentLength > MAX_BODY_SIZE) {
    return { valid: false, error: { message: `request body too large (max ${MAX_BODY_SIZE / 1024 / 1024}MB)`, type: "invalid_request", code: "body_too_large" } };
  }
  return { valid: true };
}

export async function readJsonBodyWithLimit(request: Request): Promise<
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; status: number; error: { message: string; type: string; code: string } }
> {
  if (!request.body) {
    return { ok: false, status: 400, error: { message: "Invalid JSON", type: "invalid_request", code: "invalid_json" } };
  }

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > MAX_BODY_SIZE) {
          await reader.cancel();
          return {
            ok: false,
            status: 413,
            error: { message: `request body too large (max ${MAX_BODY_SIZE / 1024 / 1024}MB)`, type: "invalid_request", code: "body_too_large" },
          };
        }
        chunks.push(value);
      }
    }
  } finally {
    reader.releaseLock();
  }

  const bodyBytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bodyBytes.set(chunk, offset);
    offset += chunk.byteLength;
  }

  try {
    const parsed = JSON.parse(new TextDecoder().decode(bodyBytes));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { ok: false, status: 400, error: { message: "JSON body must be an object", type: "invalid_request", code: "invalid_json" } };
    }
    return { ok: true, value: parsed as Record<string, unknown> };
  } catch {
    return { ok: false, status: 400, error: { message: "Invalid JSON", type: "invalid_request", code: "invalid_json" } };
  }
}
