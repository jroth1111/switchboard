// Thinking/reasoning leak stripping.
// Ports behavior from litellm_logic/nim/repair/thinking.py.

// Single source of truth for thinking tag names (used here and by stream-evaluator).
export const THINKING_TAG_NAMES = [
  "think",
  "thinking",
  "think_process",
  "cot",
  "internal_thought",
  "reasoning",
  "reason",
  "scratchpad",
  "reflection",
  "thought",
  "chain_of_thought",
  "inner_monologue",
];

// Pre-compiled regex patterns for each thinking tag pair.
const THINKING_REGEX_PAIRS: Array<{
  open: string;
  close: string;
  pairRe: RegExp;
  pairNoGtRe: RegExp;
  unclosedRe: RegExp;
  closeTagPresentRe: RegExp;
}> = THINKING_TAG_NAMES.map((name) => {
  const open = `<${name}`;
  const close = `</${name}`;
  const closeTagEnd = `<\\/${name}\\b[^>]*>`;
  const closeTagEndNoGt = `<\\/${name}[^>]*>`;
  return {
    open,
    close,
    pairRe: new RegExp(open + "\\b[^>]*>(?:(?!" + open + "\\b)[\\s\\S])*?" + closeTagEnd, "gi"),
    pairNoGtRe: new RegExp(open + "\\b[^>]*>(?:(?!" + open + "\\b)[\\s\\S]){0,4096}" + closeTagEndNoGt, "gi"),
    unclosedRe: new RegExp(open + "\\b[^>]*>?", "gi"),
    closeTagPresentRe: new RegExp(`<\\/${name}\\b`, "i"),
  };
});

const REASONING_FIELDS = [
  "reasoning",
  "reasoning_content",
  "thinking",
  "scratchpad",
  "chain_of_thought",
  "internal_thought",
  "inner_monologue",
];
const HIDDEN_REASONING_CONTENT_TYPES = new Set([
  ...THINKING_TAG_NAMES,
  "reasoning_content",
]);

export function stripThinkingLeaks(text: string): string {
  let result = text;
  for (;;) {
    const next = stripThinkingLeaksOnce(result);
    if (next === result) break;
    result = next;
  }
  return result;
}

function stripThinkingLeaksOnce(text: string): string {
  let result = text;

  for (const { close, pairRe, pairNoGtRe, unclosedRe, closeTagPresentRe } of THINKING_REGEX_PAIRS) {
    // Remove matched pairs. The negative lookahead strips nested same-name tags
    // from the inside out across stripThinkingLeaksOnce() passes.
    result = result.replace(pairRe, "");

    // Also remove pairs where the open tag is malformed and lacks ">".
    result = result.replace(pairNoGtRe, "");

    // Remove unclosed thinking tags only when no matching close tag exists.
    if (!result.toLowerCase().includes(close + ">") && !closeTagPresentRe.test(result)) {
      result = result.replace(unclosedRe, "");
    }
  }

  // Clean up leading/trailing whitespace artifacts
  result = result.replace(/^\s*\n/, "").replace(/\n\s*$/, "");

  return result;
}

export function stripResponseReasoningFields(
  message: Record<string, unknown>,
): { message: Record<string, unknown>; changed: boolean } {
  let changed = false;
  const next = { ...message };

  for (const field of REASONING_FIELDS) {
    if (next[field] !== undefined && next[field] !== null && next[field] !== "") {
      delete next[field];
      changed = true;
    }
  }

  const content = next.content;
  if (Array.isArray(content)) {
    const filtered = content.filter((item) => {
      if (!item || typeof item !== "object") return true;
      const type = String((item as Record<string, unknown>).type ?? "").toLowerCase();
      return !HIDDEN_REASONING_CONTENT_TYPES.has(type);
    });
    if (filtered.length !== content.length) {
      next.content = filtered;
      changed = true;
    }
  }

  return { message: next, changed };
}
