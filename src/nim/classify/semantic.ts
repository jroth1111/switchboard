// NIM semantic response classification.
// Ports behavior from litellm_logic/nim/classify/semantic.py.

import { SPECIAL_TOKENS } from "../repair/special-tokens";

export type SemanticIssue =
  | "empty_response"
  | "garbled_response"
  | "low_entropy"
  | "truncation"
  | "success_shaped_failure"
  | "repetition_detected"
  | "reasoning_leak"
  | "special_token_leak"
  | "whitespace_anomaly"
  | "input_echo";

export interface SemanticClassification {
  issue: SemanticIssue | null;
  confidence: number;
  severity: "low" | "medium" | "high";
  details: string;
}

// ─── Entropy calculation ──────────────────────────────────────────

function shannonEntropy(text: string): number {
  if (text.length === 0) return 0;
  const freq = new Map<string, number>();
  for (const ch of text) freq.set(ch, (freq.get(ch) ?? 0) + 1);
  let entropy = 0;
  const len = text.length;
  for (const count of freq.values()) {
    const p = count / len;
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy;
}

// ─── Printable ratio ──────────────────────────────────────────────

function printableRatio(text: string): number {
  if (text.length === 0) return 0;
  let printable = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) >= 32 && ch.charCodeAt(0) <= 126) printable++;
    // Count non-control unicode as printable (C0 and C1 control chars excluded)
    else if (ch.charCodeAt(0) > 127 && ch.charCodeAt(0) !== 0xFEFF) printable++;
  }
  return printable / text.length;
}

// ─── Success-shaped failure detection ─────────────────────────────

const SUCCESS_SHAPED_FAILURE_MAX_CHARS = 1024;

const ERRORISH_PREFIXES = [
  "error",
  "{\"error\"",
  "{\"message\"",
  "upstream",
  "provider",
];

const SUCCESS_SHAPED_FAILURE_SIGNATURES = [
  "rate limit exceeded",
  "too many requests",
  "quota exceeded",
  "internal server error",
  "server error",
  "service temporarily unavailable",
  "temporarily unavailable",
  "temporarily overloaded",
  "model is overloaded",
  "upstream error",
  "provider error",
  "failed to process",
  "request timed out",
  "timeout",
];

export function detectSuccessShapedFailure(text: string): SemanticClassification | null {
  const lowered = text.toLowerCase().trim();
  if (!lowered || lowered.length > SUCCESS_SHAPED_FAILURE_MAX_CHARS) return null;

  const hasProviderErrorPrefix = ERRORISH_PREFIXES.some((prefix) => lowered.startsWith(prefix));
  if (!hasProviderErrorPrefix) return null;

  const signature = SUCCESS_SHAPED_FAILURE_SIGNATURES.find((marker) => lowered.includes(marker));
  if (signature) {
    return {
      issue: "success_shaped_failure",
      confidence: 0.95,
      severity: "high",
      details: `success-shaped failure: '${signature}' in 200 OK response`,
    };
  }

  return null;
}

// ─── Truncation detection ─────────────────────────────────────────

export function detectTruncation(text: string, finishReason?: string): SemanticClassification | null {
  if (finishReason === "length") {
    return { issue: "truncation", confidence: 0.95, severity: "medium", details: "finish_reason=length" };
  }

  // Check for unclosed thinking tags
  const thinkOpen = (text.match(/<think\b/g) ?? []).length;
  const thinkClose = (text.match(/<\/think>/g) ?? []).length;
  if (thinkOpen > thinkClose) {
    return { issue: "truncation", confidence: 0.9, severity: "medium", details: "unclosed_thinking_tag" };
  }

  // Check for mid-sentence cut-off
  if (text.length > 100) {
    const lastSentenceEnd = Math.max(
      text.lastIndexOf("."),
      text.lastIndexOf("!"),
      text.lastIndexOf("?"),
    );
    const tailLen = text.length - lastSentenceEnd;
    if (tailLen > text.length * 0.15 && lastSentenceEnd > 0) {
      // Long trailing fragment after last sentence end
      const tail = text.slice(lastSentenceEnd + 1).trim();
      if (tail.length > 30 && !tail.endsWith("```")) {
        return { issue: "truncation", confidence: 0.6, severity: "low", details: "trailing_fragment" };
      }
    }
  }

  return null;
}

// ─── Repetition detection ─────────────────────────────────────────

export function detectRepetition(text: string, maxRatio: number = 0.4): SemanticClassification | null {
  if (text.length < 50) return null;

  // Check for repeated lines
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length >= 4) {
    const lineCounts = new Map<string, number>();
    for (const line of lines) {
      const normalized = line.trim().toLowerCase();
      lineCounts.set(normalized, (lineCounts.get(normalized) ?? 0) + 1);
    }
    let maxCount = 0;
    let repeatedRatio = 0;
    for (const [line, count] of lineCounts) {
      if (count > maxCount) maxCount = count;
    }
    const uniqueLines = lineCounts.size;
    repeatedRatio = 1 - uniqueLines / lines.length;
    if (repeatedRatio > maxRatio && maxCount >= 3) {
      return {
        issue: "repetition_detected",
        confidence: repeatedRatio,
        severity: "medium",
        details: `repeated_lines_ratio=${repeatedRatio.toFixed(2)}, max_count=${maxCount}`,
      };
    }
  }

  // Check for repeated substrings (n-gram)
  const words = text.split(/\s+/);
  if (words.length >= 20) {
    const trigrams: string[] = [];
    for (let i = 0; i < words.length - 2; i++) {
      trigrams.push(`${words[i]} ${words[i + 1]} ${words[i + 2]}`);
    }
    const triCounts = new Map<string, number>();
    for (const tri of trigrams) {
      triCounts.set(tri, (triCounts.get(tri) ?? 0) + 1);
    }
    let maxTriCount = 0;
    for (const count of triCounts.values()) {
      if (count > maxTriCount) maxTriCount = count;
    }
    const triRepeatRatio = 1 - triCounts.size / trigrams.length;
    if (triRepeatRatio > maxRatio && maxTriCount >= 4) {
      return {
        issue: "repetition_detected",
        confidence: triRepeatRatio,
        severity: "medium",
        details: `repeated_trigrams_ratio=${triRepeatRatio.toFixed(2)}`,
      };
    }
  }

  return null;
}

// ─── Special token leak detection ─────────────────────────────────

// Pre-compiled detection regexes (no g flag — avoids lastIndex statefulness).
const SPECIAL_TOKEN_DETECT = SPECIAL_TOKENS.map(({ re, label }) => ({
  pattern: new RegExp(re),
  label,
}));

export function detectSpecialTokenLeak(text: string): SemanticClassification | null {
  const found: string[] = [];
  for (const { pattern, label } of SPECIAL_TOKEN_DETECT) {
    if (pattern.test(text)) {
      found.push(label);
    }
  }
  if (found.length > 0) {
    return {
      issue: "special_token_leak",
      confidence: 0.9,
      severity: "medium",
      details: `leaked_tokens: ${found.join(", ")}`,
    };
  }
  return null;
}

// ─── Input echo detection ─────────────────────────────────────────

function detectInputEcho(inputText: string, responseText: string, threshold = 0.7): SemanticClassification | null {
  if (!inputText || !responseText || responseText.length < 20) return null;
  const normalize = (s: string) => s.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(Boolean);
  const inputTokens = new Set(normalize(inputText));
  const responseTokens = normalize(responseText);
  if (inputTokens.size === 0) return null;
  let matchCount = 0;
  for (const t of responseTokens) { if (inputTokens.has(t)) matchCount++; }
  const uniqueResponseTokens = new Set(responseTokens).size;
  const jaccard = matchCount / (inputTokens.size + uniqueResponseTokens - matchCount);
  if (jaccard > threshold) {
    return { issue: "input_echo", confidence: jaccard, severity: "medium", details: `echo_ratio=${jaccard.toFixed(2)}` };
  }
  return null;
}

// ─── Main classifier ──────────────────────────────────────────────

export interface SemanticValidationConfig {
  minChars: number;
  minEntropy: number;
  minPrintableRatio: number;
  repetitionMaxRatio: number;
  echoThreshold?: number;
}

export function classifySemanticIssue(
  text: string,
  config: SemanticValidationConfig,
  finishReason?: string,
  inputText?: string,
): SemanticClassification | null {
  if (!text || text.trim().length === 0) {
    return { issue: "empty_response", confidence: 1.0, severity: "high", details: "empty_or_blank" };
  }

  // Low printable ratio (garbled)
  const pr = printableRatio(text);
  if (text.length >= (config.minChars || 1) && pr < (config.minPrintableRatio || 0.8)) {
    return {
      issue: "garbled_response",
      confidence: 1 - pr,
      severity: "high",
      details: `printable_ratio=${pr.toFixed(2)}`,
    };
  }

  // Low entropy
  const ent = shannonEntropy(text);
  if (text.length >= 10 && ent < (config.minEntropy || 2.5)) {
    return {
      issue: "low_entropy",
      confidence: 1 - ent / (config.minEntropy || 2.5),
      severity: "low",
      details: `entropy=${ent.toFixed(2)}`,
    };
  }

  // Null bytes
  if (text.includes("\0")) {
    return { issue: "garbled_response", confidence: 1.0, severity: "high", details: "null_bytes_detected" };
  }

  // Success-shaped failure
  const ssf = detectSuccessShapedFailure(text);
  if (ssf) return ssf;

  // Truncation
  const trunc = detectTruncation(text, finishReason);
  if (trunc) return trunc;

  // Repetition
  const rep = detectRepetition(text, config.repetitionMaxRatio);
  if (rep) return rep;

  // Special tokens
  const st = detectSpecialTokenLeak(text);
  if (st) return st;

  // Whitespace anomaly (excessive blank lines)
  const blankLines = (text.match(/\n\s*\n\s*\n/g) ?? []).length;
  if (blankLines > 5 && text.length < 200) {
    return {
      issue: "whitespace_anomaly",
      confidence: 0.6,
      severity: "low",
      details: `excessive_blank_lines=${blankLines}`,
    };
  }

  // Input echo: response mirrors user input
  if (inputText && text.length > 0) {
    const echo = detectInputEcho(inputText, text, config.echoThreshold ?? 0.7);
    if (echo) return echo;
  }

  return null;
}
