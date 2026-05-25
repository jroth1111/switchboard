// Tool-call repair aliases and policy patterns.

export const TOOL_NAME_ALIASES: Record<string, string> = {};

export const ENUM_ALIASES: Record<string, Record<string, string>> = {};

const DESTRUCTIVE_TOOL_VERBS = [
  "append",
  "chmod",
  "chown",
  "commit",
  "create",
  "delete",
  "deploy",
  "destroy",
  "drop",
  "execute",
  "insert",
  "mkdir",
  "modify",
  "move",
  "overwrite",
  "patch",
  "publish",
  "push",
  "remove",
  "rename",
  "replace",
  "run",
  "send",
  "set",
  "touch",
  "truncate",
  "update",
  "upsert",
  "write",
];

export const DESTRUCTIVE_TOOL_PATTERNS: RegExp[] = [
  /\b(?:append|chmod|chown|commit|create|delete|deploy|destroy|drop|execute|insert|mkdir|modify|move|overwrite|patch|publish|push|remove|rename|replace|run|send|set|touch|truncate|update|upsert|write)(?:\b|[_-]|[A-Z])/,
];

export function buildConfiguredPatterns(patterns: string[]): RegExp[] {
  const result: RegExp[] = [];
  for (const p of patterns) {
    try { result.push(new RegExp(p, "i")); } catch { /* skip invalid */ }
  }
  return result;
}

export function isDestructiveToolName(name: string, configuredPatterns: RegExp[] = []): boolean {
  for (const verb of DESTRUCTIVE_TOOL_VERBS) {
    if (hasDestructiveVerbBoundary(name, verb)) return true;
  }
  for (const re of configuredPatterns) {
    if (re.test(name)) return true;
  }
  return false;
}

function hasDestructiveVerbBoundary(name: string, verb: string): boolean {
  const lowerName = name.toLowerCase();
  let index = lowerName.indexOf(verb);
  while (index !== -1) {
    const before = name[index - 1];
    const after = name[index + verb.length];
    const validBefore = before === undefined || !/[A-Za-z0-9]/.test(before);
    const validAfter = after === undefined || !/[A-Za-z0-9]/.test(after) || /[A-Z]/.test(after);
    if (validBefore && validAfter) return true;
    index = lowerName.indexOf(verb, index + 1);
  }
  return false;
}
