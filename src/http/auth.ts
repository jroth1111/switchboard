// Bearer token auth utilities.
// Extracted to avoid circular imports between handler and health-endpoint.

const encoder = new TextEncoder();

export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const aa = encoder.encode(a);
  const bb = encoder.encode(b);
  let diff = 0;
  for (let i = 0; i < aa.length; i++) diff |= aa[i] ^ bb[i];
  return diff === 0;
}

export function verifyBearerToken(request: Request, expectedToken: string): boolean {
  if (!expectedToken) return false;
  const auth = request.headers.get("Authorization");
  if (!auth) return false;
  const spaceIdx = auth.indexOf(" ");
  if (spaceIdx === -1) return false;
  const scheme = auth.slice(0, spaceIdx);
  if (scheme.toLowerCase() !== "bearer") return false;
  const token = auth.slice(spaceIdx + 1).trim();
  if (!token) return false;
  return timingSafeEqual(token, expectedToken);
}

export function verifyProxyAuth(request: Request, apiKey: string): boolean {
  return verifyBearerToken(request, apiKey);
}

export function verifyAdminAuth(request: Request, adminKey: string): boolean {
  return verifyBearerToken(request, adminKey);
}
