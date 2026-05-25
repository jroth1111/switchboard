// HMAC metadata signing for internal trust.

const HMAC_SHA256_BASE64_RE = /^[A-Za-z0-9+/]{43}=$/;

export async function signMetadata(
  payload: Record<string, unknown>,
  key: string,
): Promise<string> {
  if (key.trim().length === 0) {
    throw new Error("Metadata signing key is required");
  }
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
  if (key.trim().length === 0) return false;
  const candidate = signature.trim();
  if (!HMAC_SHA256_BASE64_RE.test(candidate)) return false;
  const expected = await signMetadata(payload, key);
  // Constant-time comparison to prevent timing attacks
  const aa = new TextEncoder().encode(expected);
  const bb = new TextEncoder().encode(candidate);
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

function isInternalMetadataKey(key: string): boolean {
  const normalized = key.toLowerCase();
  return INTERNAL_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function shouldDropClientKey(key: string): boolean {
  return !isSafeObjectKey(key) || isInternalMetadataKey(key);
}

export function sanitizeClientMetadata(body: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...body };
  // Strip internal-namespaced metadata from the incoming request
  if (cleaned.metadata != null) {
    if (typeof cleaned.metadata !== "object" || Array.isArray(cleaned.metadata)) {
      cleaned.metadata = Object.create(null) as Record<string, unknown>;
    } else {
      const meta: Record<string, unknown> = Object.create(null);
      for (const [key, value] of Object.entries(cleaned.metadata as Record<string, unknown>)) {
        if (shouldDropClientKey(key)) continue;
        meta[key] = value;
      }
      cleaned.metadata = meta;
    }
  }
  // Hoist extra_body fields to top level and strip the extra_body key.
  // extra_body is a client-side convention for passing params that shouldn't
  // be validated but should reach the provider.
  if (cleaned.extra_body && typeof cleaned.extra_body === "object" && !Array.isArray(cleaned.extra_body)) {
    const extra = cleaned.extra_body as Record<string, unknown>;
    for (const [k, v] of Object.entries(extra)) {
      if (isSafeObjectKey(k) && !Object.hasOwn(cleaned, k)) cleaned[k] = v;
    }
    delete cleaned.extra_body;
  }
  // Strip unsafe/internal fields that were on the top level or hoisted from extra_body.
  for (const key of Object.keys(cleaned)) {
    if (shouldDropClientKey(key)) delete cleaned[key];
  }
  return cleaned;
}
