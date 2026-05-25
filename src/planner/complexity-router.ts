/** Rule-based tier selection for smart-route-worker (claude-router style, no LLM). */

export type ComplexityTier = "low" | "medium" | "high";

const SIMPLE_PATTERNS = [
  /\b(what is|define|explain briefly|how do i|syntax for)\b/i,
  /\b(hello|hi|thanks|thank you)\b/i,
  /^\s*.{0,120}\s*$/s,
];

const COMPLEX_PATTERNS = [
  /\b(architect|design|refactor|migrate|debug entire|multi-?file|microservice)\b/i,
  /\b(implement|build from scratch|comprehensive review)\b/i,
];

export function classifyPromptComplexity(messages: unknown): ComplexityTier {
  const text = extractPromptText(messages);
  if (!text) return "medium";
  if (text.length > 8000 || COMPLEX_PATTERNS.some((re) => re.test(text))) return "high";
  if (text.length < 400 && SIMPLE_PATTERNS.some((re) => re.test(text))) return "low";
  return "medium";
}

export function smartRouteModelForTier(tier: ComplexityTier): string {
  switch (tier) {
    case "low":
      return "anthropic-subscription-sonnet-4-6-low";
    case "high":
      return "anthropic-subscription-opus-4-7-high";
    default:
      return "anthropic-subscription-sonnet-4-6-high";
  }
}

function extractPromptText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";
  const parts: string[] = [];
  for (const msg of messages) {
    if (!msg || typeof msg !== "object") continue;
    const role = (msg as Record<string, unknown>).role;
    if (role !== "user") continue;
    const content = (msg as Record<string, unknown>).content;
    if (typeof content === "string") parts.push(content);
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text") {
          const t = (block as Record<string, unknown>).text;
          if (typeof t === "string") parts.push(t);
        }
      }
    }
  }
  return parts.join("\n").trim();
}
