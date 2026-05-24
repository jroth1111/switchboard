// Tool-call repair aliases and policy patterns.

export const TOOL_NAME_ALIASES: Record<string, string> = {};

export const ENUM_ALIASES: Record<string, Record<string, string>> = {};

export const DESTRUCTIVE_TOOL_PATTERNS: RegExp[] = [
  /\b(write|delete|remove|destroy|drop|update|modify|create|insert)/i,
];

const configuredPatterns: RegExp[] = [];

export function loadConfiguredPatterns(patterns: string[]): void {
  configuredPatterns.length = 0;
  for (const p of patterns) {
    try { configuredPatterns.push(new RegExp(p, "i")); } catch { /* skip invalid */ }
  }
}

export function isDestructiveToolName(name: string): boolean {
  for (const re of DESTRUCTIVE_TOOL_PATTERNS) {
    if (re.test(name)) return true;
  }
  for (const re of configuredPatterns) {
    if (re.test(name)) return true;
  }
  return false;
}
