// VibeProxy-style model suffix rewriting before canonicalize/planning.
// Strips `-thinking-NUMBER` from model id and injects Anthropic thinking budget.

const THINKING_SUFFIX = "-thinking-";

export interface ModelSuffixRewrite {
  /** Model id used for routing (suffix stripped). */
  model: string;
  /** Client-supplied model string preserved on the envelope. */
  originalModel: string;
  /** Whether extended thinking was requested via suffix. */
  requiresReasoning: boolean;
}

export function applyModelSuffixToBody(body: Record<string, unknown>): ModelSuffixRewrite {
  const raw = typeof body.model === "string" ? body.model.trim() : "";
  if (!raw) return { model: raw, originalModel: raw, requiresReasoning: false };

  const idx = raw.lastIndexOf(THINKING_SUFFIX);
  if (idx === -1) {
    return { model: raw, originalModel: raw, requiresReasoning: false };
  }

  const budgetStr = raw.slice(idx + THINKING_SUFFIX.length);
  if (!/^\d+$/.test(budgetStr)) {
    return { model: raw, originalModel: raw, requiresReasoning: false };
  }
  const budget = Number.parseInt(budgetStr, 10);
  const stripped = raw.slice(0, idx);
  if (!Number.isFinite(budget) || budget <= 0 || !stripped) {
    return { model: raw, originalModel: raw, requiresReasoning: false };
  }

  body.model = stripped; // intentional mutation: envelope reads the same object downstream
  if (body.thinking === undefined) {
    body.thinking = { type: "enabled", budget_tokens: budget };
  }
  return { model: stripped, originalModel: raw, requiresReasoning: true };
}
