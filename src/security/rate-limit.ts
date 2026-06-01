// Best-effort isolate-local rate limiter (NOT a global rate limiter).
// Uses a fixed-window counter with per-IP scoping. Module-level Maps are
// per-isolate: under load Cloudflare runs multiple isolates, so this provides
// approximate smoothing — not exact enforcement. For strict global rate
// limiting, use Durable Object state or a KV-based approach.

import { RATE_LIMIT_MAX_ENTRIES, RATE_LIMIT_PRUNE_INTERVAL_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS } from "../config/constants";

const windows = new Map<string, { count: number; expiresAt: number }>();
let lastPrune = 0;
export const UNKNOWN_CLIENT_IP = "unknown:strict";

export function isStrictUnknownClientIp(ip: string): boolean {
  return ip === UNKNOWN_CLIENT_IP;
}
const MAX_IP_LITERAL_LENGTH = 45;

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: RATE_LIMIT_MAX_REQUESTS,
};

function normalizeConfig(config: RateLimitConfig): RateLimitConfig | null {
  if (
    !Number.isFinite(config.windowMs)
    || !Number.isInteger(config.windowMs)
    || config.windowMs <= 0
    || !Number.isFinite(config.maxRequests)
    || !Number.isInteger(config.maxRequests)
    || config.maxRequests <= 0
  ) {
    return null;
  }
  return config;
}

function pruneExpired(now: number) {
  if (now - lastPrune < RATE_LIMIT_PRUNE_INTERVAL_MS && windows.size < RATE_LIMIT_MAX_ENTRIES) return;
  lastPrune = now;
  for (const [k, v] of windows) {
    if (v.expiresAt <= now) windows.delete(k);
  }
  // Hard cap: evict oldest entries (Map preserves insertion order)
  while (windows.size > RATE_LIMIT_MAX_ENTRIES) {
    const oldest = windows.keys().next().value;
    if (oldest) windows.delete(oldest); else break;
  }
}

export function checkRateLimit(
  identifier: string,
  config: RateLimitConfig = DEFAULT_CONFIG,
): { allowed: boolean; remaining: number; resetAt: number } {
  const now = Date.now();
  const normalizedConfig = normalizeConfig(config);
  if (!normalizedConfig) {
    return { allowed: false, remaining: 0, resetAt: now + DEFAULT_CONFIG.windowMs };
  }
  const bucket = Math.floor(now / normalizedConfig.windowMs);
  const resetAt = (bucket + 1) * normalizedConfig.windowMs;
  const key = `${identifier}:${bucket}`;

  pruneExpired(now);

  const entry = windows.get(key);
  const currentCount = entry?.count ?? 0;
  if (!entry && windows.size >= RATE_LIMIT_MAX_ENTRIES) {
    return { allowed: false, remaining: 0, resetAt };
  }

  if (currentCount >= normalizedConfig.maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetAt,
    };
  }

  windows.set(key, {
    count: currentCount + 1,
    expiresAt: resetAt,
  });

  return {
    allowed: true,
    remaining: normalizedConfig.maxRequests - currentCount - 1,
    resetAt,
  };
}

const RATE_LIMIT_SEGMENT_MAX_LENGTH = 128;

function capRateLimitSegment(value: string): string {
  return value.slice(0, RATE_LIMIT_SEGMENT_MAX_LENGTH);
}

function parseHeliconeRateLimitPolicyScope(policy: string): string | undefined {
  for (const part of policy.split(";")) {
    const trimmed = part.trim();
    if (!trimmed.toLowerCase().startsWith("s=")) continue;
    const scope = trimmed.slice(2).trim();
    if (scope) return scope;
  }
  return undefined;
}

function heliconePropertyHeaderForScope(scope: string): string[] {
  if (scope === "user") return ["Helicone-User-Id"];
  if (scope === "tenant") return ["Helicone-Property-Tenant"];
  const titleCase = scope.charAt(0).toUpperCase() + scope.slice(1);
  return [`Helicone-Property-${titleCase}`, `Helicone-Property-${scope}`];
}

function extractHeliconePolicySegment(request: Request): string | undefined {
  const policy = request.headers.get("Helicone-RateLimit-Policy")?.trim();
  if (!policy) return undefined;
  const scope = parseHeliconeRateLimitPolicyScope(policy);
  if (!scope) return undefined;
  for (const headerName of heliconePropertyHeaderForScope(scope)) {
    const value = request.headers.get(headerName)?.trim();
    if (value) return capRateLimitSegment(value);
  }
  return undefined;
}

/** Optional tenant/segment for per-client sub-buckets (Helicone-style property headers). */
export function extractRateLimitSegment(request: Request): string | undefined {
  const direct = request.headers.get("X-Switchboard-RateLimit-Segment")?.trim();
  if (direct) return capRateLimitSegment(direct);
  const policy = request.headers.get("Helicone-RateLimit-Policy")?.trim();
  const policyScope = policy ? parseHeliconeRateLimitPolicyScope(policy) : undefined;
  const policySegment = extractHeliconePolicySegment(request);
  if (policySegment) return policySegment;
  if (policyScope) return undefined;
  const helicone = request.headers.get("Helicone-Property-Tenant")?.trim()
    ?? request.headers.get("Helicone-User-Id")?.trim();
  if (helicone) return capRateLimitSegment(helicone);
  return undefined;
}

export function clientRateLimitBucket(userHash: string | undefined, segment: string | undefined): string {
  const parts = [userHash?.trim(), segment?.trim()].filter((p) => p && p.length > 0);
  return parts.length > 0 ? parts.join("|") : "";
}

export function extractClientIp(request: Request): string {
  // Trust only CF-Connecting-IP (set by Cloudflare edge). Do not fall back to
  // client-controlled headers (X-Real-IP, X-Forwarded-For) which allow rate-limit bypass.
  const candidate = request.headers.get("CF-Connecting-IP")?.trim();
  if (!candidate || !isValidIpLiteral(candidate)) return UNKNOWN_CLIENT_IP;
  return candidate.toLowerCase();
}

function isValidIpLiteral(candidate: string): boolean {
  if (candidate.length > MAX_IP_LITERAL_LENGTH) return false;
  if (/[\s,[\]\\/]/.test(candidate)) return false;
  return isValidIpv4(candidate) || isValidIpv6(candidate);
}

function isValidIpv4(candidate: string): boolean {
  const parts = candidate.split(".");
  if (parts.length !== 4) return false;
  return parts.every((part) => {
    if (!/^(0|[1-9]\d{0,2})$/.test(part)) return false;
    const value = Number(part);
    return value >= 0 && value <= 255;
  });
}

function isValidIpv6(candidate: string): boolean {
  if (!candidate.includes(":")) return false;
  if (!/^[0-9a-fA-F:.]+$/.test(candidate)) return false;
  try {
    new URL(`https://[${candidate}]/`);
    return true;
  } catch {
    return false;
  }
}
