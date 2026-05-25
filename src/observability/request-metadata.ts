const MAX_PROPERTY_LEN = 128;
const MAX_PROPERTIES = 8;

export interface RequestMetadata {
  sessionId?: string;
  traceId?: string;
  properties?: Record<string, string>;
}

export function extractRequestMetadata(request: Request): RequestMetadata {
  const sessionId = sanitizeMetaValue(request.headers.get("X-Switchboard-Session-Id")
    ?? request.headers.get("Helicone-Session-Id"));
  const traceId = sanitizeMetaValue(request.headers.get("X-Switchboard-Trace-Id")
    ?? request.headers.get("Helicone-Request-Id"));
  const properties: Record<string, string> = {};
  for (const [key, value] of request.headers.entries()) {
    const lower = key.toLowerCase();
    if (!lower.startsWith("helicone-property-") && !lower.startsWith("x-switchboard-property-")) {
      continue;
    }
    const prefix = lower.startsWith("x-switchboard-property-")
      ? "x-switchboard-property-"
      : "helicone-property-";
    const name = lower.slice(prefix.length) || "prop";
    const v = sanitizeMetaValue(value);
    if (v && Object.keys(properties).length < MAX_PROPERTIES) {
      properties[name] = v;
    }
  }
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(traceId ? { traceId } : {}),
    ...(Object.keys(properties).length ? { properties } : {}),
  };
}

function sanitizeMetaValue(raw: string | null): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > MAX_PROPERTY_LEN) return undefined;
  if (/[\x00-\x1f]/.test(trimmed)) return undefined;
  return trimmed;
}
