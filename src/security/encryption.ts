// AES-256-GCM encryption for sensitive data at rest (OAuth tokens, etc.).
// Uses WebCrypto API available in Cloudflare Workers.

const ALGORITHM = "AES-GCM";
const IV_LENGTH = 12;
const TAG_LENGTH = 128;

const keyCache = new Map<string, CryptoKey>();

async function deriveKey(encryptionKey: string): Promise<CryptoKey> {
  const cached = keyCache.get(encryptionKey);
  if (cached) return cached;
  const encoder = new TextEncoder();
  const keyMaterial = await crypto.subtle.digest("SHA-256", encoder.encode(encryptionKey));
  const key = await crypto.subtle.importKey("raw", keyMaterial, { name: ALGORITHM }, false, ["encrypt", "decrypt"]);
  keyCache.set(encryptionKey, key);
  return key;
}

export async function encrypt(plaintext: string, encryptionKey: string): Promise<string> {
  const key = await deriveKey(encryptionKey);
  const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
  const encoder = new TextEncoder();
  const data = encoder.encode(plaintext);

  const ciphertext = await crypto.subtle.encrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    key,
    data,
  );

  // Prepend IV to ciphertext: [12 bytes IV][ciphertext+tag]
  const combined = new Uint8Array(iv.length + ciphertext.byteLength);
  combined.set(iv, 0);
  combined.set(new Uint8Array(ciphertext), iv.length);

  // btoa expects a binary string; chunk encoding avoids O(n) intermediate strings
  const chunks: string[] = [];
  for (let i = 0; i < combined.length; i += 8192) {
    chunks.push(String.fromCharCode(...combined.subarray(i, Math.min(i + 8192, combined.length))));
  }
  return ENCRYPTION_PREFIX + btoa(chunks.join(""));
}

export async function decrypt(encoded: string, encryptionKey: string): Promise<string> {
  const payload = encoded.startsWith(ENCRYPTION_PREFIX) ? encoded.slice(ENCRYPTION_PREFIX.length) : encoded;
  const key = await deriveKey(encryptionKey);
  const combined = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0));

  const iv = combined.slice(0, IV_LENGTH);
  const ciphertext = combined.slice(IV_LENGTH);

  const plaintext = await crypto.subtle.decrypt(
    { name: ALGORITHM, iv, tagLength: TAG_LENGTH },
    key,
    ciphertext,
  );

  return new TextDecoder().decode(plaintext);
}

const ENCRYPTION_PREFIX = "enc:v1:";

export function isEncrypted(value: string): boolean {
  return value.startsWith(ENCRYPTION_PREFIX);
}
