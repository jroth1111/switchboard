// NIM rate-limit classification.
// Ports behavior from litellm_logic/nim/classify/rate_limit.py.

import type { FailureClass, ProviderCooldownProfile } from "../../config/schema";

export interface RateLimitClassification {
  failureClass: FailureClass;
  cooldownSeconds: number;
  details: string;
}

const NIM_OVERLOAD_MARKERS = [
  "model is overloaded",
  "temporarily overloaded",
  "service may be temporarily overloaded",
  "service overloaded",
  "capacity exceeded",
  "\"code\":\"1305\"",
  "\"code\":1305",
];

const NIM_QUOTA_MARKERS = [
  "usage limit",
  "upgrade for higher limits",
  "quota",
  "quota exceeded",
  "daily limit",
  "monthly limit",
  "rate limit reached",
  "rate_limit_exceeded",
];

const CONCURRENCY_MARKERS = [
  "too many concurrent",
  "too many connections",
  "too many concurrent connections",
  "concurrency limit",
  "max concurrent",
];

const AMBIGUOUS_RATE_LIMIT_MARKERS = [
  "too many requests",
];

const RETRY_AFTER_QUOTA_THRESHOLD_SECONDS = 300;
const DEFAULT_OVERLOAD_COOLDOWN_SECONDS = 10;
const DEFAULT_QUOTA_COOLDOWN_SECONDS = 15 * 60;
const DEFAULT_CONCURRENCY_COOLDOWN_SECONDS = 30;
const DEFAULT_AMBIGUOUS_COOLDOWN_SECONDS = 45;

export function classifyRateLimit(
  status: number,
  body: string,
  headers: Record<string, string>,
  providerCooldowns?: ProviderCooldownProfile,
): RateLimitClassification | null {
  if (status !== 429) return null;

  const bodyLower = body.toLowerCase();
  const retryAfter = findHeader(headers, "retry-after");
  const resetHeader = findFirstHeader(headers, [
    "x-ratelimit-reset-requests",
    "x-ratelimit-reset-tokens",
    "x-ratelimit-reset",
    "ratelimit-reset",
  ]);

  // Overload markers are provider-health signals and take priority over
  // Retry-After, matching litellm_logic's NIM classifier.
  if (NIM_OVERLOAD_MARKERS.some((m) => bodyLower.includes(m))) {
    return {
      failureClass: "rate_limit_overload",
      cooldownSeconds: providerCooldowns?.overloadCooldownSeconds ?? DEFAULT_OVERLOAD_COOLDOWN_SECONDS,
      details: `overload_429 body_overload_marker: ${body.slice(0, 200)}`,
    };
  }

  const retryAfterClass = classifyRetryAfterHeader(retryAfter);
  if (retryAfterClass) {
    return {
      failureClass: retryAfterClass.bucket === "quota_window"
        ? "rate_limit_quota_window"
        : "rate_limit_concurrency",
      cooldownSeconds: retryAfterClass.seconds ?? (
        retryAfterClass.bucket === "quota_window"
          ? (providerCooldowns?.quotaCooldownSeconds ?? DEFAULT_QUOTA_COOLDOWN_SECONDS)
          : (providerCooldowns?.concurrencyCooldownSeconds ?? DEFAULT_CONCURRENCY_COOLDOWN_SECONDS)
      ),
      details: `${retryAfterClass.bucket}_429 ${retryAfterClass.reason}: ${body.slice(0, 200)}`,
    };
  }

  const resetSeconds = parseProviderResetHeader(resetHeader);
  if ((resetSeconds !== null && resetSeconds !== undefined)) {
    return {
      failureClass: "rate_limit_quota_window",
      cooldownSeconds: resetSeconds,
      details: `quota_window_429 provider_reset_header: ${body.slice(0, 200)}`,
    };
  }

  if (!bodyLower.trim()) {
    return {
      failureClass: "rate_limit_concurrency_ambiguous",
      cooldownSeconds: providerCooldowns?.ambiguousCooldownSeconds ?? DEFAULT_AMBIGUOUS_COOLDOWN_SECONDS,
      details: "ambiguous_429 missing_body_default_concurrency",
    };
  }

  if (CONCURRENCY_MARKERS.some((m) => bodyLower.includes(m))) {
    return {
      failureClass: "rate_limit_concurrency",
      cooldownSeconds: providerCooldowns?.concurrencyCooldownSeconds ?? DEFAULT_CONCURRENCY_COOLDOWN_SECONDS,
      details: `concurrency_429 body_concurrency_marker: ${body.slice(0, 200)}`,
    };
  }

  const glmReset = parseGlmResetTimestamp(body);
  if (glmReset !== null) {
    return {
      failureClass: "rate_limit_quota_window",
      cooldownSeconds: providerCooldowns?.quotaCooldownSeconds ?? glmReset,
      details: `quota_window_429 body_reset_timestamp: ${body.slice(0, 200)}`,
    };
  }

  if (NIM_QUOTA_MARKERS.some((m) => bodyLower.includes(m))) {
    return {
      failureClass: "rate_limit_quota_window",
      cooldownSeconds: providerCooldowns?.quotaCooldownSeconds ?? DEFAULT_QUOTA_COOLDOWN_SECONDS,
      details: `quota_window_429 body_quota_marker: ${body.slice(0, 200)}`,
    };
  }

  if (AMBIGUOUS_RATE_LIMIT_MARKERS.some((m) => bodyLower.includes(m))) {
    return {
      failureClass: "rate_limit_concurrency_ambiguous",
      cooldownSeconds: providerCooldowns?.ambiguousCooldownSeconds ?? DEFAULT_AMBIGUOUS_COOLDOWN_SECONDS,
      details: `ambiguous_429 body_ambiguous_rate_limit_marker: ${body.slice(0, 200)}`,
    };
  }

  return {
    failureClass: "rate_limit_concurrency_ambiguous",
    cooldownSeconds: providerCooldowns?.ambiguousCooldownSeconds ?? DEFAULT_AMBIGUOUS_COOLDOWN_SECONDS,
    details: `ambiguous_429 default_rate_limit: ${body.slice(0, 200)}`,
  };
}

function findHeader(headers: Record<string, string>, name: string): string | undefined {
  const direct = headers[name];
  if (direct !== undefined) return direct;
  const lowerName = name.toLowerCase();
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === lowerName);
  return entry?.[1];
}

function findFirstHeader(headers: Record<string, string>, names: string[]): string | undefined {
  for (const name of names) {
    const value = findHeader(headers, name);
    if (value) return value;
  }
  return undefined;
}

export function classifyRetryAfterHeader(value?: string): {
  bucket: "concurrency" | "quota_window";
  seconds?: number;
  reason: string;
} | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0) return null;
    const rounded = Math.round(numeric);
    return rounded >= RETRY_AFTER_QUOTA_THRESHOLD_SECONDS
      ? { bucket: "quota_window", seconds: rounded, reason: "retry_after_quota_window" }
      : { bucket: "concurrency", seconds: rounded, reason: "retry_after_short_window" };
  }

  const timestamp = Date.parse(trimmed);
  if (!Number.isNaN(timestamp)) {
    const seconds = Math.max(0, Math.round((timestamp - Date.now()) / 1000));
    if (seconds <= 0) {
      return { bucket: "concurrency", seconds: undefined, reason: "retry_after_past_date" };
    }
    return seconds >= RETRY_AFTER_QUOTA_THRESHOLD_SECONDS
      ? { bucket: "quota_window", seconds, reason: "retry_after_quota_window" }
      : { bucket: "concurrency", seconds, reason: "retry_after_short_window" };
  }

  return null;
}

export function parseGlmResetTimestamp(body: string): number | null {
  const match = body.match(/\breset(?:s|ting)?(?:\s+\w+){0,3}\s+(?:at|on)\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i)
    ?? body.match(/\bwill\s+reset\s+at\s+(\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)/i);
  if (match) {
    let timestamp = match[1].replace(" ", "T");
    if (!/(?:Z|[+-]\d{2}:?\d{2})$/i.test(timestamp)) {
      timestamp = `${timestamp}+08:00`;
    } else if (!/(?:Z|[+-]\d{2}:\d{2})$/i.test(timestamp)) {
      timestamp = timestamp.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    }
    const ts = new Date(timestamp).getTime();
    if (!Number.isNaN(ts)) {
      return Math.max(0, Math.round((ts - Date.now()) / 1000));
    }
  }
  return null;
}

export function parseProviderResetHeader(value?: string): number | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const numeric = Number(trimmed);
  if (Number.isFinite(numeric)) {
    if (numeric <= 0) return null;
    if (numeric > 1_000_000_000_000) {
      return Math.max(0, Math.round((numeric - Date.now()) / 1000));
    }
    if (numeric > 1_000_000_000) {
      return Math.max(0, Math.round((numeric * 1000 - Date.now()) / 1000));
    }
    return Math.round(numeric);
  }

  const dateMs = Date.parse(trimmed);
  if (!Number.isNaN(dateMs)) {
    return Math.max(0, Math.round((dateMs - Date.now()) / 1000));
  }

  const duration = trimmed.match(/^(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|second|seconds|m|min|minute|minutes)$/i);
  if (!duration) return null;
  const amount = Number(duration[1]);
  const unit = duration[2].toLowerCase();
  if (unit === "ms") return Math.ceil(amount / 1000);
  if (unit.startsWith("m")) return Math.round(amount * 60);
  return Math.round(amount);
}
