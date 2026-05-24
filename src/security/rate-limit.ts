// Best-effort isolate-local rate limiter (NOT a global rate limiter).
// Uses a sliding window counter with per-IP scoping. Module-level Maps are
// per-isolate: under load Cloudflare runs multiple isolates, so this provides
// approximate smoothing — not exact enforcement. For strict global rate
// limiting, use Durable Object state or a KV-based approach.

import { RATE_LIMIT_MAX_ENTRIES, RATE_LIMIT_PRUNE_INTERVAL_MS, RATE_LIMIT_WINDOW_MS, RATE_LIMIT_MAX_REQUESTS } from "../config/constants";

const windows = new Map<string, { count: number; expiresAt: number }>();
let lastPrune = 0;

export interface RateLimitConfig {
  windowMs: number;
  maxRequests: number;
}

const DEFAULT_CONFIG: RateLimitConfig = {
  windowMs: RATE_LIMIT_WINDOW_MS,
  maxRequests: RATE_LIMIT_MAX_REQUESTS,
};

function pruneExpired(now: number) {
  if (now - lastPrune < RATE_LIMIT_PRUNE_INTERVAL_MS && windows.size < RATE_LIMIT_MAX_ENTRIES) return;
  lastPrune = now;
  for (const [k, v] of windows) {
    if (v.expiresAt < now) windows.delete(k);
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
  const key = `${identifier}:${Math.floor(now / config.windowMs)}`;

  pruneExpired(now);

  const entry = windows.get(key);
  const currentCount = entry?.count ?? 0;

  if (currentCount >= config.maxRequests) {
    return {
      allowed: false,
      remaining: 0,
      resetAt: (Math.floor(now / config.windowMs) + 1) * config.windowMs,
    };
  }

  windows.set(key, {
    count: currentCount + 1,
    expiresAt: (Math.floor(now / config.windowMs) + 1) * config.windowMs,
  });

  return {
    allowed: true,
    remaining: config.maxRequests - currentCount - 1,
    resetAt: (Math.floor(now / config.windowMs) + 1) * config.windowMs,
  };
}

export function extractClientIp(request: Request): string {
  // Trust only CF-Connecting-IP (set by Cloudflare edge). Do not fall back to
  // client-controlled headers (X-Real-IP, X-Forwarded-For) which allow rate-limit bypass.
  return request.headers.get("CF-Connecting-IP")
    ?? "unknown:strict";
}
