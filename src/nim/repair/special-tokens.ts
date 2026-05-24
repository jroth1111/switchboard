// Special token repair and detection patterns.
// Single source of truth for special token strings used by both repair and detection.

export const SPECIAL_TOKENS: Array<{ re: string; label: string }> = [
  // Generic <|...|> family (Llama-3, Qwen, and any <|pipe|> style tokens)
  { re: "<\\|[^|]+\\|>", label: "tokenizer_special" },
  { re: "<s>", label: "bos_token" },
  { re: "<\\/s>", label: "eos_token" },
  { re: "<\\|im_start\\|>", label: "chatml_start" },
  { re: "<\\|im_end\\|>", label: "chatml_end" },
  { re: "<\\|begin_of_text\\|>", label: "begin_of_text" },
  { re: "<\\|end_of_text\\|>", label: "end_of_text" },
  { re: "\\[INST\\]", label: "llama_inst" },
  { re: "\\[\\/INST\\]", label: "llama_inst_close" },
  // DeepSeek tokens (use Unicode fullwidth pipe ｜ and word-joiner ▁ — not covered by <|...|>)
  { re: "<｜begin▁of▁sentence｜>", label: "deepseek_bos" },
  { re: "<｜end▁of▁sentence｜>", label: "deepseek_eos" },
  { re: "<｜User｜>", label: "deepseek_user" },
  { re: "<｜Assistant｜>", label: "deepseek_assistant" },
  { re: "<｜fim▁begin｜>", label: "deepseek_fim_begin" },
  { re: "<｜fim▁hole｜>", label: "deepseek_fim_hole" },
  { re: "<｜fim▁end｜>", label: "deepseek_fim_end" },
];

// Combined alternation regex for efficient removal (global).
const SPECIAL_TOKEN_RE = new RegExp(SPECIAL_TOKENS.map((t) => t.re).join("|"), "g");

export function repairSpecialTokens(text: string): string {
  return text.replace(SPECIAL_TOKEN_RE, "");
}
