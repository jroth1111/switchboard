// Request-side typed content part normalization.
// Mirrors the Python control plane's safe content repair: visible transcript
// text is normalized, hidden reasoning/metadata is stripped, and structured
// media/tool parts are preserved without logging prompt text.

type TypedPartAction =
  | "keep_visible_text"
  | "normalize_visible_text"
  | "strip_hidden_reasoning"
  | "strip_metadata"
  | "preserve_structured_part"
  | "unknown";

export interface TypedContentRepairReceipt {
  messageIndex: number;
  partIndex: number;
  partType: string;
  action: TypedPartAction;
}

const VISIBLE_TEXT_TYPES = new Set(["text", "input_text", "output_text", "summary_text"]);
const HIDDEN_TEXT_TYPES = new Set(["reasoning", "thinking", "scratchpad", "chain_of_thought", "internal_thought"]);
const METADATA_TYPES = new Set(["metadata_marker"]);
const PASSTHROUGH_TYPES = new Set(["image_url", "input_image", "image", "audio", "input_audio", "tool_result"]);

export function typedContentPartAction(part: unknown): TypedPartAction {
  if (!isPlainObject(part)) return "unknown";
  const type = partType(part);
  if (VISIBLE_TEXT_TYPES.has(type)) return type === "text" ? "keep_visible_text" : "normalize_visible_text";
  if (HIDDEN_TEXT_TYPES.has(type)) return "strip_hidden_reasoning";
  if (METADATA_TYPES.has(type)) return "strip_metadata";
  if (PASSTHROUGH_TYPES.has(type)) return "preserve_structured_part";
  return "unknown";
}

export function normalizeTypedContentParts(data: Record<string, unknown>): TypedContentRepairReceipt[] {
  const messages = data.messages;
  if (!Array.isArray(messages)) return [];

  const receipts: TypedContentRepairReceipt[] = [];
  messages.forEach((message, messageIndex) => {
    if (!isPlainObject(message) || !Array.isArray(message.content)) return;
    const normalized: unknown[] = [];
    let changed = false;

    message.content.forEach((part, partIndex) => {
      const action = typedContentPartAction(part);
      const type = isPlainObject(part) ? partType(part) : "non_mapping";

      if (action === "normalize_visible_text" && isPlainObject(part)) {
        const text = typeof part.text === "string"
          ? part.text
          : typeof part.output_text === "string"
            ? part.output_text
            : undefined;
        if (typeof text === "string") {
          normalized.push({ type: "text", text });
          changed = true;
          receipts.push({ messageIndex, partIndex, partType: type, action });
          return;
        }
      }

      if (action === "strip_hidden_reasoning" || action === "strip_metadata") {
        changed = true;
        receipts.push({ messageIndex, partIndex, partType: type, action });
        return;
      }

      normalized.push(part);
    });

    if (changed) message.content = normalized;
  });

  return receipts;
}

export function hasTypedContentNormalization(data: Record<string, unknown>): boolean {
  const messages = data.messages;
  if (!Array.isArray(messages)) return false;
  for (const message of messages) {
    if (!isPlainObject(message) || !Array.isArray(message.content)) continue;
    for (const part of message.content) {
      if (["normalize_visible_text", "strip_hidden_reasoning", "strip_metadata"].includes(typedContentPartAction(part))) {
        return true;
      }
    }
  }
  return false;
}

export function hasHiddenOnlyTypedContent(data: Record<string, unknown>): boolean {
  const messages = data.messages;
  if (!Array.isArray(messages) || messages.length === 0) return false;

  let sawHidden = false;
  for (const message of messages) {
    if (!isPlainObject(message)) return false;
    const content = message.content;
    if ((content === null || content === undefined) || content === "") continue;
    if (typeof content === "string") {
      if (content.trim()) return false;
      continue;
    }
    if (!Array.isArray(content)) return false;
    for (const part of content) {
      const action = typedContentPartAction(part);
      if (action === "strip_hidden_reasoning" || action === "strip_metadata") {
        sawHidden = true;
        continue;
      }
      return false;
    }
  }
  return sawHidden;
}

function partType(part: Record<string, unknown>): string {
  const raw = part.type;
  return typeof raw === "string" && raw.trim() ? raw.trim().toLowerCase() : "unknown";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
