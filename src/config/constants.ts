// Centralized constants for the control plane.
// Single source of truth for limits, timeouts, and thresholds.

// ─── HTTP request limits ──────────────────────────────────────────
export const MAX_BODY_SIZE = 10 * 1024 * 1024; // 10 MB
export const MAX_MESSAGES = 200;
export const MAX_TOOLS = 128;
export const MAX_TOOL_NAME_LENGTH = 128;

// ─── Schema validation ───────────────────────────────────────────
export const MAX_VALIDATE_DEPTH = 16;

// ─── Rate limiting ────────────────────────────────────────────────
export const RATE_LIMIT_MAX_ENTRIES = 10_000;
export const RATE_LIMIT_PRUNE_INTERVAL_MS = 5000;
export const RATE_LIMIT_WINDOW_MS = 60_000;
export const RATE_LIMIT_MAX_REQUESTS = 120;

// ─── Timeouts ─────────────────────────────────────────────────────
export const RESERVATION_TTL_MS = 30_000;
export const REFRESH_LOCK_TTL_MS = 30_000;
export const TOKEN_EXPIRY_SAFETY_MARGIN_MS = 60_000;
export const STREAM_MAX_SILENCE_MS = 30_000;
export const STREAM_HEARTBEAT_INTERVAL_MS = 15_000;

// ─── Duration constants ───────────────────────────────────────────
export const ONE_MINUTE_MS = 60_000;
export const ONE_HOUR_MS = 3_600_000;

// ─── Learned concurrency ─────────────────────────────────────────
export const LEARNED_CONCURRENCY_TTL_MS = 60_000;
