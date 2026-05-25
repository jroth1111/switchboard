// Tool-call repair and validation.
// Ports behavior from litellm_logic/nim/repair/tool_calls.py.

export interface ToolCallValidation {
  valid: boolean;
  reason?: string;
}

export function validateToolContract(
  toolCalls: Array<Record<string, unknown>>,
  availableTools: Array<Record<string, unknown>>,
): ToolCallValidation {
  if (!Array.isArray(toolCalls) || toolCalls.length === 0) {
    return { valid: false, reason: "missing_tool_calls" };
  }

  const allowed = allowedToolNames(availableTools);
  const requiredByTool = requiredToolArgs(availableTools);

  for (const tc of toolCalls) {
    const fn = tc.function as Record<string, unknown> | undefined;
    if (!fn) {
      return { valid: false, reason: "tool_call_missing_function" };
    }
    if (!fn.name || typeof fn.name !== "string" || fn.name.trim() === "") {
      return { valid: false, reason: "tool_call_missing_name" };
    }
    const name = fn.name.trim();
    if (allowed.size === 0) {
      return {
        valid: false,
        reason: `unexpected_tool_name: response emitted tool call '${name}' without requested tools`,
      };
    }
    if (!allowed.has(name)) {
      return {
        valid: false,
        reason: `unexpected_tool_name: response tool call '${name}' was not requested`,
      };
    }

    const invalidName = detectInvalidToolCallNames([tc], allowed);
    if (invalidName) {
      return { valid: false, reason: invalidName };
    }

    // Validate arguments is parseable JSON
    let parsedArgs: unknown = {};
    if (fn.arguments !== undefined && fn.arguments !== null) {
      if (typeof fn.arguments !== "string") {
        return { valid: false, reason: `invalid_json: tool '${name}' arguments must be a JSON string` };
      }
      try {
        parsedArgs = JSON.parse(fn.arguments || "{}");
      } catch (err) {
        const message = err instanceof Error ? err.message : "malformed";
        return { valid: false, reason: `invalid_json: tool '${name}' arguments are malformed: ${message}` };
      }
    }

    if (!parsedArgs || typeof parsedArgs !== "object" || Array.isArray(parsedArgs)) {
      return {
        valid: false,
        reason: `invalid_json: tool '${name}' arguments must be an object`,
      };
    }

    const required = requiredByTool.get(name);
    if (required?.size) {
      const present = parsedArgs as Record<string, unknown>;
      const missing = [...required].filter((arg) => !(arg in present)).sort();
      if (missing.length > 0) {
        return {
          valid: false,
          reason: `missing_tool_arguments: tool '${name}' missing required ${missing.join(",")}`,
        };
      }
    }
  }
  return { valid: true };
}

export function repairToolCalls(
  toolCalls: Array<Record<string, unknown>>,
  availableTools: Array<Record<string, unknown>> = [],
): Array<Record<string, unknown>> | null {
  let anyRepaired = false;
  const allowed = allowedToolNames(availableTools);
  let hasUnrepairable = false;
  const repaired = toolCalls.map((tc) => {
    const fn = tc.function as Record<string, unknown> | undefined;
    if (!fn) return tc;

    const patched = { ...fn };
    let changed = false;

    // Fix missing/empty name — can't auto-repair.
    if (!patched.name || typeof patched.name !== "string" || patched.name.trim() === "") {
      hasUnrepairable = true;
      return null;
    }
    const fixedName = repairToolName(patched.name, allowed);
    if (fixedName) {
      patched.name = fixedName;
      changed = true;
    }

    // Fix malformed JSON arguments
    if (patched.arguments !== undefined && patched.arguments !== null) {
      const wasString = typeof patched.arguments === "string";
      const argsStr = wasString
        ? (patched.arguments as string)
        : safeStringify(patched.arguments);
      if (argsStr === null) {
        hasUnrepairable = true;
        return null;
      }
      try {
        JSON.parse(argsStr);
        patched.arguments = argsStr;
        if (!wasString) changed = true;
      } catch {
        const fixed = repairJson(argsStr);
        if (fixed) {
          patched.arguments = fixed;
          changed = true;
        } else {
          // Can't repair — return as-is but flag
          patched.arguments = argsStr;
        }
      }
    }

    if (changed) {
      anyRepaired = true;
      return { ...tc, function: patched };
    }
    return tc;
  });

  // Filter out nulls (unrepairable tool calls)
  if (hasUnrepairable) return null;
  const filtered = repaired.filter((tc): tc is Record<string, unknown> => tc !== null);
  if (filtered.length === 0 && toolCalls.length > 0) return null;
  return anyRepaired || filtered.length < toolCalls.length ? filtered : null;
}

export function repairToolName(toolName: unknown, allowed: Set<string>): string | null {
  if (typeof toolName !== "string" || !toolName || allowed.size === 0) return null;
  const trimmed = toolName.trim();
  if (!trimmed) return null;
  if (allowed.has(trimmed)) return trimmed === toolName ? null : trimmed;

  const candidates = [...allowed].filter(Boolean).sort((a, b) => b.length - a.length || a.localeCompare(b));
  for (const candidate of candidates) {
    if (
      trimmed.length > candidate.length
      && trimmed.length % candidate.length === 0
      && trimmed === candidate.repeat(trimmed.length / candidate.length)
    ) {
      return candidate;
    }
    if (trimmed === `${candidate}.${candidate}`) return candidate;
    if (trimmed === `${candidate}(${candidate})`) return candidate;
  }
  return null;
}

export function detectInvalidToolCallNames(
  toolCalls: unknown,
  allowed: Set<string> = new Set(),
): string | null {
  if (!Array.isArray(toolCalls)) return null;
  for (const toolCall of toolCalls) {
    if (!toolCall || typeof toolCall !== "object") continue;
    const fn = (toolCall as Record<string, unknown>).function;
    if (!fn || typeof fn !== "object") continue;
    const name = (fn as Record<string, unknown>).name;
    if (typeof name !== "string" || !name) continue;
    if (allowed.has(name)) continue;

    const lower = name.toLowerCase().trim();
    if (lower.length % 2 === 0) {
      const half = lower.length / 2;
      if (half >= 3 && lower.slice(0, half) === lower.slice(half)) {
        return `invalid_tool_name: '${name}' appears duplicated`;
      }
    }

    for (let i = 1; i <= Math.floor(lower.length / 2); i++) {
      if (lower.length % i !== 0) continue;
      const sub = lower.slice(0, i);
      if (sub.length >= 3 && sub.repeat(lower.length / i) === lower) {
        return `invalid_tool_name: repeated pattern '${sub}' in '${name}'`;
      }
    }
  }
  return null;
}

export function repairJson(text: string): string | null {
  let candidate = text.trim();
  if (!candidate) return null;

  // Strip code fences
  if (candidate.startsWith("```json")) {
    candidate = candidate.slice(7);
  } else if (candidate.startsWith("```")) {
    candidate = candidate.slice(3);
  }
  if (candidate.endsWith("```")) {
    candidate = candidate.slice(0, -3);
  }
  candidate = candidate.trim();

  // Try as-is first
  try {
    JSON.parse(candidate);
    return candidate;
  } catch {
    // Continue with repair.
  }

  for (const repaired of repairCandidates(candidate)) {
    try {
      JSON.parse(repaired);
      return repaired;
    } catch {
      // Try the next local repair candidate.
    }
  }
  return null;
}

function repairCandidates(candidate: string): string[] {
  const candidates = [
    stripJsonComments(candidate),
    pythonLikeToJson(candidate),
  ];
  candidates.push(...candidates.map(closeTruncatedJson));
  return [...new Set(candidates.map((item) => item.trim()).filter(Boolean))];
}

function stripJsonComments(text: string): string {
  let result = "";
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];
    if (inString) {
      result += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      result += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      result += "\n";
      continue;
    }
    if (ch === "/" && next === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
      continue;
    }
    result += ch;
  }
  return removeTrailingCommas(result);
}

function pythonLikeToJson(text: string): string {
  let result = "";
  let inDoubleString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inDoubleString) {
      result += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inDoubleString = false;
      continue;
    }
    if (ch === "\"") {
      inDoubleString = true;
      result += ch;
      continue;
    }
    if (ch === "'") {
      const parsed = readSingleQuotedString(text, i);
      result += JSON.stringify(parsed.value);
      i = parsed.endIndex;
      continue;
    }
    if (startsBareWord(text, i, "True")) {
      result += "true";
      i += 3;
      continue;
    }
    if (startsBareWord(text, i, "False")) {
      result += "false";
      i += 4;
      continue;
    }
    if (startsBareWord(text, i, "None")) {
      result += "null";
      i += 3;
      continue;
    }
    result += ch;
  }
  return removeTrailingCommas(result);
}

function readSingleQuotedString(text: string, startIndex: number): { value: string; endIndex: number } {
  let value = "";
  let escaped = false;
  for (let i = startIndex + 1; i < text.length; i++) {
    const ch = text[i];
    if (escaped) {
      value += ch;
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === "'") return { value, endIndex: i };
    value += ch;
  }
  return { value, endIndex: text.length - 1 };
}

function startsBareWord(text: string, index: number, word: string): boolean {
  if (!text.startsWith(word, index)) return false;
  const before = text[index - 1];
  const after = text[index + word.length];
  return !isWordChar(before) && !isWordChar(after);
}

function isWordChar(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

function closeTruncatedJson(text: string): string {
  let result = text.trim();
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const ch of result) {
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
      continue;
    }
    if (ch === "\"") {
      inString = true;
      continue;
    }
    if (ch === "{") stack.push("}");
    else if (ch === "[") stack.push("]");
    else if (ch === "}" || ch === "]") {
      if (stack[stack.length - 1] === ch) stack.pop();
    }
  }
  if (inString) result += "\"";
  for (let i = stack.length - 1; i >= 0; i--) {
    result = result.replace(/,\s*$/u, "");
    result += stack[i];
  }
  return removeTrailingCommas(result);
}

function removeTrailingCommas(text: string): string {
  return text.replace(/,\s*([}\]])/gu, "$1");
}

function allowedToolNames(availableTools: Array<Record<string, unknown>>): Set<string> {
  const names = new Set<string>();
  for (const tool of availableTools) {
    // OpenAI: tool.function.name
    const fn = tool.function as Record<string, unknown> | undefined;
    const openaiName = fn?.name;
    if (typeof openaiName === "string" && openaiName.trim()) {
      names.add(openaiName.trim());
      continue;
    }
    // Anthropic: tool.name
    const name = tool.name;
    if (typeof name === "string" && name.trim()) {
      names.add(name.trim());
    }
  }
  return names;
}

function requiredToolArgs(availableTools: Array<Record<string, unknown>>): Map<string, Set<string>> {
  const result = new Map<string, Set<string>>();
  for (const tool of availableTools) {
    // OpenAI: tool.function.name, tool.function.parameters.required
    const fn = tool.function as Record<string, unknown> | undefined;
    let name: unknown = fn?.name;
    let parameters: Record<string, unknown> | undefined = fn?.parameters as Record<string, unknown> | undefined;

    // Anthropic: tool.name, tool.input_schema.required
    if (typeof name !== "string" || !name.trim()) {
      name = tool.name;
      parameters = (tool.input_schema ?? tool.inputSchema) as Record<string, unknown> | undefined;
    }

    const required = parameters?.required;
    if (typeof name !== "string" || !name.trim() || !Array.isArray(required)) continue;
    const names = new Set(required.filter((item): item is string => typeof item === "string" && !!item.trim()));
    if (names.size > 0) result.set((name as string).trim(), names);
  }
  return result;
}

function safeStringify(value: unknown): string | null {
  try {
    const serialized = JSON.stringify(value);
    return typeof serialized === "string" ? serialized : null;
  } catch {
    return null;
  }
}
