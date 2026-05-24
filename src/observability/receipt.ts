// Route receipts and observability.

import type { TokenUsage } from "./token-usage";

const MAX_IN_MEMORY_RECEIPTS = 1000;

export interface RouteReceipt {
  requestId: string;
  timestamp: number;
  originalModel: string;
  clientId?: string;
  appId?: string;
  userHash?: string;
  policyId?: string;
  policyVersion?: string;
  routeVersion?: string;
  denialReason?: string;
  routeDecision?: RouteDecision;
  canonicalTarget: string;
  selectedGroup: string;
  fallbackGroups: string[];
  attempts: Array<{
    group: string;
    deploymentId?: string;
    failureClass?: string;
    failureMessage?: string;
    durationMs?: number;
    firstByteLatencyMs?: number;
    action: string;
    tokenUsage?: TokenUsage;
  }>;
  finalOutcome: "success" | "repaired_success" | "client_error" | "exhausted";
  stream: boolean;
  totalDurationMs?: number;
}

export interface RouteDecision {
  canonicalization: {
    requestedModel: string;
    canonicalTarget: string;
    reason: string;
  };
  requestClass: Record<string, unknown>;
  selectedGroup: string;
  selectedReason: string;
  fallbackGroups: string[];
  candidates: Array<{
    group: string;
    score: number;
    viable: boolean;
    rejectionReason?: string;
    hidden?: boolean;
    deploymentCount: number;
  }>;
  transforms: Array<{ type: string; param: string; value?: unknown }>;
}

// In-memory fallback for tests and non-DO contexts
const receipts = new Map<string, RouteReceipt>();

export function recordReceipt(receipt: RouteReceipt): void {
  receipts.set(receipt.requestId, receipt);
  if (receipts.size > MAX_IN_MEMORY_RECEIPTS) {
    const oldest = receipts.keys().next().value;
    if (oldest) receipts.delete(oldest);
  }
}

export function getReceipt(requestId: string): RouteReceipt | undefined {
  return receipts.get(requestId);
}

export function getAllReceipts(): RouteReceipt[] {
  return Array.from(receipts.values());
}

// ─── Structured sanitization ───────────────────────────────────────
// Ports litellm_logic/obs/route_receipts.py sanitize_receipt.

const REDACTED = "<redacted>";

const SECRET_FIELD_NAMES = new Set([
  "api_key", "authorization", "body", "content",
  "proxy_authorization", "x-api-key", "cookie", "set-cookie",
  "session_id", "caller_session_id", "x_session_id",
  "account_id", "password", "secret", "token",
  "access_token", "refresh_token", "encrypted_content",
  "reasoning_content", "reasoning_text", "workspace_path",
  "private_file_path", "file_path", "input", "messages", "prompt",
]);

const SECRET_VALUE_PREFIXES = ["sk-", "sk_", "bearer ", "basic "];

const DIAGNOSTIC_DETAIL_FIELD_NAMES = new Set([
  "error_body", "issue_detail", "provider_error_body",
  "provider_response_body", "raw_body", "response_body",
  "failure_message", "failuremessage",
]);

const PRIVATE_PATH_PREFIXES = ["/users/", "/private/", "/tmp/", "/var/folders/"];

function isSecretField(key: string): boolean {
  const lowered = key.trim().toLowerCase();
  if (SECRET_FIELD_NAMES.has(lowered)) return true;
  return lowered.endsWith("_api_key") || lowered.endsWith("_token");
}

function isDiagnosticDetailField(key: string): boolean {
  return DIAGNOSTIC_DETAIL_FIELD_NAMES.has(key.trim().toLowerCase());
}

function isPrivatePathLike(value: string): boolean {
  return PRIVATE_PATH_PREFIXES.some((p) => value.startsWith(p));
}

function redactDiagnosticDetail(value: unknown): Record<string, unknown> {
  if ((value === null || value === undefined)) return { redacted: true, fingerprint: "", length: 0 };
  const text = String(value);
  if (!text) return { redacted: true, fingerprint: "", length: 0 };
  // Non-crypto sync fingerprint for diagnostic deduplication.
  // Uses FNV-1a with avalanche mixing — not cryptographic but sufficient
  // for distinguishing distinct error bodies without revealing content.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  // Avalanche: spread bits for uniform distribution
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 13), 0x45d9f3b);
  h ^= h >>> 16;
  const hash = (h >>> 0).toString(16).padStart(8, "0");
  return { redacted: true, fingerprint: hash, length: text.length };
}

export function redact(text: string): string {
  let result = text;
  // Redact sk- prefixed API keys
  result = result.replace(/sk[_-][\w-]{8,}/gi, "***REDACTED***");
  // Redact Bearer/Basic tokens
  result = result.replace(/(Bearer|Basic)\s+\S+/gi, "$1 ***REDACTED***");
  // Redact api_key="..." patterns
  result = result.replace(/api_key\s*=\s*["']?sk[_-][\w-]+["']?/gi, "api_key=\"***REDACTED***\"");
  // Redact Authorization: ... headers
  result = result.replace(/Authorization:\s*.+/gi, "Authorization: ***REDACTED***");
  return result;
}

export function sanitizeReceipt(value: unknown): unknown {
  if (value === null || value === undefined) return value;

  if (typeof value === "object" && !Array.isArray(value)) {
    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      const keyText = String(key);
      if (isSecretField(keyText)) {
        result[keyText] = REDACTED;
      } else if (isDiagnosticDetailField(keyText)) {
        result[keyText] = redactDiagnosticDetail(item);
      } else {
        result[keyText] = sanitizeReceipt(item);
      }
    }
    return result;
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeReceipt(item));
  }

  if (typeof value === "string") {
    const stripped = value.trim();
    const lowered = stripped.toLowerCase();
    if (SECRET_VALUE_PREFIXES.some((p) => lowered.startsWith(p))) {
      return REDACTED;
    }
    if (isPrivatePathLike(lowered)) {
      return REDACTED;
    }
    return value;
  }

  return value;
}
