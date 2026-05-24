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
  return {
    open,
    close,
    pairRe: new RegExp(open + "\\b[^>]*>[\\s\\S]*?" + close + "\\b[^>]*>", "gi"),
    pairNoGtRe: new RegExp(open + "\\b[^>]*>[\\s\\S]{0,4096}?" + close + "[\\s\\S]*?(?=>|$)", "gi"),
    unclosedRe: new RegExp(open + "\\b[^>]*>?", "gi"),
    closeTagPresentRe: new RegExp(close + "\\b", "i"),
  };
});

const REASONING_FIELDS = ["reasoning", "reasoning_content", "thinking"];

export function stripThinkingLeaks(text: string): string {
  let result = text;

  for (const { close, pairRe, pairNoGtRe, unclosedRe, closeTagPresentRe } of THINKING_REGEX_PAIRS) {
    // Remove matched pairs (handles both <tag> and <tag without closing >)
    result = result.replace(pairRe, "");

    // Also remove pairs where open tag lacks >
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
      return type !== "reasoning" && type !== "thinking";
    });
    if (filtered.length !== content.length) {
      next.content = filtered;
      changed = true;
    }
  }

  return { message: next, changed };
}
