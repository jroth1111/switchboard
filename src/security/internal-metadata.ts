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
  if (aa.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

// ─── Client metadata sanitization ─────────────────────────────────

const INTERNAL_PREFIXES = ["x-nim-", "x-route-", "x-control-"];

export function sanitizeClientMetadata(body: Record<string, unknown>): Record<string, unknown> {
  const cleaned = { ...body };
  // Strip internal-namespaced metadata from the incoming request
  if (cleaned.metadata && typeof cleaned.metadata === "object") {
    const meta = { ...(cleaned.metadata as Record<string, unknown>) };
    for (const key of Object.keys(meta)) {
      for (const prefix of INTERNAL_PREFIXES) {
        if (key.toLowerCase().startsWith(prefix)) {
          delete meta[key];
        }
      }
    }
    cleaned.metadata = meta;
  }
  // Hoist extra_body fields to top level and strip the extra_body key.
  // extra_body is a client-side convention for passing params that shouldn't
  // be validated but should reach the provider.
  if (cleaned.extra_body && typeof cleaned.extra_body === "object" && !Array.isArray(cleaned.extra_body)) {
    const extra = cleaned.extra_body as Record<string, unknown>;
    for (const [k, v] of Object.entries(extra)) {
      if (!(k in cleaned)) cleaned[k] = v;
    }
    delete cleaned.extra_body;
  }
  return cleaned;
}
