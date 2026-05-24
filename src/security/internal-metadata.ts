// HMAC metadata signing for internal trust.

export async function signMetadata(
  payload: Record<string, unknown>,
  key: string,
): Promise<string> {
  const data = JSON.stringify(payload);
  const encoder = new TextEncoder();
  const keyData = encoder.encode(key);
  const msgData = encoder.encode(data);

  const cryptoKey = await crypto.subtle.importKey(
    "raw", keyData, { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, msgData);
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

export async function verifyMetadataSignature(
  payload: Record<string, unknown>,
  signature: string,
  key: string,
): Promise<boolean> {
  const expected = await signMetadata(payload, key);
  // Constant-time comparison to prevent timing attacks
  const aa = new TextEncoder().encode(expected);
  const bb = new TextEncoder().encode(signature);
  let diff = aa.length ^ bb.length;
  const maxLength = Math.max(aa.length, bb.length);
  for (let i = 0; i < maxLength; i++) diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

// ─── Client metadata sanitization ─────────────────────────────────

const INTERNAL_PREFIXES = ["x-nim-", "x-route-", "x-control-"];
const POLLUTING_KEYS = new Set(["__proto__", "constructor", "prototype"]);

function isSafeObjectKey(key: string): boolean {
  return !POLLUTING_KEYS.has(key);
}

export function sanitizeClientMetadata(body: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...body };
  // Strip internal-namespaced metadata from the incoming request
  if (cleaned.metadata && typeof cleaned.metadata === "object") {
    const meta: Record<string, unknown> = Object.create(null);
    for (const [key, value] of Object.entries(cleaned.metadata as Record<string, unknown>)) {
      if (!isSafeObjectKey(key) || INTERNAL_PREFIXES.some((prefix) => key.toLowerCase().startsWith(prefix))) continue;
      meta[key] = value;
    }
    cleaned.metadata = meta;
  }
  // Hoist extra_body fields to top level and strip the extra_body key.
  // extra_body is a client-side convention for passing params that shouldn't
  // be validated but should reach the provider.
  if (cleaned.extra_body && typeof cleaned.extra_body === "object" && !Array.isArray(cleaned.extra_body)) {
    const extra = cleaned.extra_body as Record<string, unknown>;
    for (const [k, v] of Object.entries(extra)) {
      if (isSafeObjectKey(k) && !(k in cleaned)) cleaned[k] = v;
    }
    delete cleaned.extra_body;
    // Strip internal-prefixed fields that were hoisted from extra_body
    for (const key of Object.keys(cleaned)) {
      if (INTERNAL_PREFIXES.some(p => key.toLowerCase().startsWith(p))) {
        delete cleaned[key];
      }
    }
  }
  return cleaned;
}
