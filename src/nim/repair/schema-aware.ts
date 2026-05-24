// Schema-aware tool-call argument repair.
// Uses JSON Schema from request tools to coerce types, prune unknowns, and fix shapes.

import { TOOL_NAME_ALIASES, ENUM_ALIASES, isDestructiveToolName } from "./aliases";

// ─── Types ────────────────────────────────────────────────────────

export interface ToolParameterSchema {
  type?: string;
  format?: string;
  properties?: Record<string, ToolParameterSchema>;
  required?: string[];
  additionalProperties?: boolean;
  items?: ToolParameterSchema;
  enum?: string[];
  description?: string;
  anyOf?: ToolParameterSchema[];
  oneOf?: ToolParameterSchema[];
  default?: unknown;
}

export type RepairKind =
  | "omit_optional_null"
  | "parse_stringified_array"
  | "parse_stringified_object"
  | "wrap_bare_string_to_array"
  | "wrap_object_to_array"
  | "coerce_string_boolean"
  | "coerce_numeric_string"
  | "enum_near_miss"
  | "prune_extra_keys"
  | "unwrap_markdown_autolink"
  | "tool_name_alias"
  | "relational_default"
  | "special_token_strip"
  | "repetition_dedup"
  | "thinking_leak_strip"
  | "reasoning_field_strip";

export interface RepairRecord {
  toolName: string;
  fieldPath: string;
  repairKind: RepairKind;
  before: string;
  after: string;
}

export interface RelationalDefaultRule {
  whenPresent: string[];
  whenMissing: string[];
  set: Record<string, unknown>;
}

export interface RepairPolicyConfig {
  allowDestructive: boolean;
  enumAliases: Record<string, Record<string, string>>;
  toolNameAliases: Record<string, string>;
  relationalDefaults: Record<string, RelationalDefaultRule[]>;
}

export interface SchemaRepairResult {
  repaired: Record<string, unknown>;
  repairs: RepairRecord[];
  changed: boolean;
}

export interface ToolCallRepairResult {
  repaired: Array<Record<string, unknown>> | null;
  repairRecords: RepairRecord[];
}

// ─── Schema extraction (provider-agnostic) ────────────────────────

export function buildToolSchemaMap(
  availableTools: Array<Record<string, unknown>>,
): Map<string, ToolParameterSchema> {
  const map = new Map<string, ToolParameterSchema>();
  for (const tool of availableTools) {
    const { name, schema } = extractToolSpec(tool);
    if (name && schema) map.set(name, schema);
  }
  return map;
}

function extractToolSpec(tool: Record<string, unknown>): { name: string; schema: ToolParameterSchema | null } {
  // OpenAI style: tools[].function.name, tools[].function.parameters
  const fn = tool.function as Record<string, unknown> | undefined;
  if (fn) {
    const name = fn.name;
    if (typeof name === "string" && name.trim()) {
      const params = fn.parameters as ToolParameterSchema | undefined;
      return { name: name.trim(), schema: params ?? null };
    }
  }
  // Anthropic style: tools[].name, tools[].input_schema
  const name = tool.name;
  if (typeof name === "string" && name.trim()) {
    const schema = (tool.input_schema ?? tool.inputSchema) as ToolParameterSchema | undefined;
    return { name: name.trim(), schema: schema ?? null };
  }
  return { name: "", schema: null };
}

// ─── Top-level schema validation for tool calls ───────────────────

export interface ToolCallSchemaValidation {
  valid: boolean;
  issues: Array<{ toolName: string; issues: SchemaIssue[] }>;
}

export function validateToolCallsAgainstSchemas(
  toolCalls: Array<Record<string, unknown>>,
  availableTools: Array<Record<string, unknown>>,
  policy: RepairPolicyConfig,
): ToolCallSchemaValidation {
  const schemaMap = buildToolSchemaMap(availableTools);
  const allIssues: Array<{ toolName: string; issues: SchemaIssue[] }> = [];

  for (const tc of toolCalls) {
    const fn = tc.function as Record<string, unknown> | undefined;
    if (!fn) continue;
    const name = fn.name;
    if (typeof name !== "string" || !name.trim()) continue;

    const schema = schemaMap.get(name);
    if (!schema) continue;

    const rawArgs = fn.arguments;
    let args: Record<string, unknown>;
    if (typeof rawArgs === "string") {
      try { args = JSON.parse(rawArgs); } catch { continue; }
    } else if (isPlainObject(rawArgs)) {
      args = rawArgs as Record<string, unknown>;
    } else {
      continue;
    }

    const issues = validateAgainstSchema(args, schema, policy);
    if (issues.length > 0) {
      allIssues.push({ toolName: name, issues });
    }
  }

  return { valid: allIssues.length === 0, issues: allIssues };
}

// ─── Tool name resolution ─────────────────────────────────────────

function resolveToolName(
  rawName: string,
  aliases: Record<string, string>,
): string | null {
  if (aliases[rawName]) return aliases[rawName];
  if (TOOL_NAME_ALIASES[rawName]) return TOOL_NAME_ALIASES[rawName];
  return null;
}

// ─── Core repair: single tool-call arguments ──────────────────────

export function repairToolArguments(
  toolName: string,
  args: Record<string, unknown>,
  schema: ToolParameterSchema,
  policy: RepairPolicyConfig,
): SchemaRepairResult {
  const repairs: RepairRecord[] = [];
  // The caller (repairToolCallsSchemaAware) passes freshly-parsed args from JSON.parse,
  // so we can mutate in place. Standalone callers must pass a copy if needed.
  let current: Record<string, unknown> = args;

  for (let pass = 0; pass < 8; pass++) {
    const issues = validateAgainstSchema(current, schema, policy);
    if (issues.length === 0) break;

    const applied = applyFirstSchemaRepair(current, issues, schema, toolName, policy);
    if (!applied) break;

    current = applied.value;
    repairs.push(applied.repair);
  }

  // Apply relational defaults (e.g. inject offset:0 for readFile when missing)
  const relationalRepairs = applyRelationalDefaults(toolName, current, policy.relationalDefaults);
  for (const r of relationalRepairs) {
    current = applyRelationalRepair(current, r);
    repairs.push(r.record);
  }

  const changed = repairs.length > 0;
  return { repaired: current, repairs, changed };
}

// ─── Schema validation (lightweight) ──────────────────────────────

export interface SchemaIssue {
  path: string;
  code: "type" | "enum" | "required" | "unknown_key" | "path_markdown_autolink";
  expected: string;
  actual: unknown;
}

const MAX_VALIDATE_DEPTH = 16; // see src/config/constants.ts

export function validateAgainstSchema(
  value: Record<string, unknown>,
  schema: ToolParameterSchema,
  policy: RepairPolicyConfig,
): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  validateNode(value, schema, "", issues, policy, 0);
  return issues;
}

function validateNode(
  value: unknown,
  schema: ToolParameterSchema,
  path: string,
  issues: SchemaIssue[],
  policy: RepairPolicyConfig,
  depth: number,
): void {
  if (depth > MAX_VALIDATE_DEPTH) return;

  // Resolve anyOf/oneOf to first matching branch
  const effectiveSchema = resolveSchemaForValue(value, schema);

  if (effectiveSchema.type === "object") {
    if (!isPlainObject(value)) {
      issues.push({ path, code: "type", expected: "object", actual: value });
      return;
    }
    const obj = value as Record<string, unknown>;
    const props = effectiveSchema.properties ?? {};
    const required = effectiveSchema.required ?? [];

    for (const key of required) {
      if (!(key in obj)) {
        issues.push({ path: `${path}.${key}`, code: "required", expected: "present", actual: undefined });
      }
    }

    for (const [key, childValue] of Object.entries(obj)) {
      const childSchema = props[key];
      if (!childSchema) {
        if (effectiveSchema.additionalProperties === false && policy.allowDestructive) {
          issues.push({ path: `${path}.${key}`, code: "unknown_key", expected: "known property", actual: childValue });
        }
        continue;
      }
      validateNode(childValue, childSchema, `${path}.${key}`, issues, policy, depth + 1);
    }
    return;
  }

  if (effectiveSchema.type === "array") {
    if (!Array.isArray(value)) {
      issues.push({ path, code: "type", expected: "array", actual: value });
      return;
    }
    const itemsSchema = effectiveSchema.items;
    if (itemsSchema) {
      for (let i = 0; i < value.length; i++) {
        validateNode(value[i], itemsSchema, `${path}[${i}]`, issues, policy, depth + 1);
      }
    }
    return;
  }

  if (effectiveSchema.type === "boolean") {
    if (typeof value !== "boolean") {
      issues.push({ path, code: "type", expected: "boolean", actual: value });
    }
    return;
  }

  if (effectiveSchema.type === "number" || effectiveSchema.type === "integer") {
    if (typeof value !== "number" || !Number.isFinite(value)) {
      issues.push({ path, code: "type", expected: effectiveSchema.type, actual: value });
    } else if (effectiveSchema.type === "integer" && !Number.isInteger(value)) {
      issues.push({ path, code: "type", expected: "integer", actual: value });
    }
    return;
  }

  if (effectiveSchema.type === "string") {
    if (typeof value !== "string") {
      issues.push({ path, code: "type", expected: "string", actual: value });
      return;
    }
    if (effectiveSchema.enum && !effectiveSchema.enum.includes(value)) {
      issues.push({ path, code: "enum", expected: effectiveSchema.enum.join("|"), actual: value });
    }
    if ((effectiveSchema.format === "path" || looksLikePathField(path)) && containsDegenerateMarkdownAutolink(value)) {
      issues.push({ path, code: "path_markdown_autolink", expected: "plain path", actual: value });
    }
    return;
  }

  if (effectiveSchema.type === "null") {
    if (value !== null) {
      issues.push({ path, code: "type", expected: "null", actual: value });
    }
  }
}

function resolveSchemaForValue(value: unknown, schema: ToolParameterSchema): ToolParameterSchema {
  if (schema.type) return schema;

  const alternatives = schema.anyOf ?? schema.oneOf;
  if (!alternatives || alternatives.length === 0) return schema;

  for (const alt of alternatives) {
    if (!alt.type) continue;
    if (typeMatches(value, alt.type)) return alt;
  }

  return alternatives[0] ?? schema;
}

function typeMatches(value: unknown, type: string): boolean {
  switch (type) {
    case "object": return isPlainObject(value);
    case "array": return Array.isArray(value);
    case "string": return typeof value === "string";
    case "number": case "integer": return typeof value === "number";
    case "boolean": return typeof value === "boolean";
    case "null": return value === null;
    default: return false;
  }
}

// ─── Repair application ───────────────────────────────────────────

interface AppliedRepair {
  value: Record<string, unknown>;
  repair: RepairRecord;
}

function applyFirstSchemaRepair(
  root: Record<string, unknown>,
  issues: SchemaIssue[],
  schema: ToolParameterSchema,
  toolName: string,
  policy: RepairPolicyConfig,
): AppliedRepair | null {
  for (const issue of issues) {
    const result = tryRepairIssue(root, issue, schema, toolName, policy);
    if (result) return result;
  }
  return null;
}

function tryRepairIssue(
  root: Record<string, unknown>,
  issue: SchemaIssue,
  rootSchema: ToolParameterSchema,
  toolName: string,
  policy: RepairPolicyConfig,
): AppliedRepair | null {
  const current = getAtPath(root, issue.path);
  const fieldSchema = schemaAtPath(rootSchema, issue.path);

  // 1. Omit optional null
  if (issue.code === "type" && current === null && fieldSchema) {
    if (isOptionalField(rootSchema, issue.path)) {
      deleteAtPath(root, issue.path);
      return {
        value: root,
        repair: { toolName, fieldPath: issue.path, repairKind: "omit_optional_null", before: "null", after: "(omitted)" },
      };
    }
  }

  // 2. Prune unknown keys
  if (issue.code === "unknown_key" && policy.allowDestructive) {
    const before = JSON.stringify(getAtPath(root, issue.path));
    deleteAtPath(root, issue.path);
    return {
      value: root,
      repair: { toolName, fieldPath: issue.path, repairKind: "prune_extra_keys", before, after: "(omitted)" },
    };
  }

  if (issue.code !== "type" && issue.code !== "enum" && issue.code !== "path_markdown_autolink") {
    return null;
  }

  if (!fieldSchema) return null;

  const effectiveSchema = resolveSchemaForValue(current, fieldSchema);

  // 3. Parse stringified array/object
  if (issue.code === "type" && typeof current === "string" && (effectiveSchema.type === "array" || effectiveSchema.type === "object")) {
    const trimmed = unwrapCodeFence(current.trim());
    try {
      const parsed = JSON.parse(trimmed);
      if (effectiveSchema.type === "array" && Array.isArray(parsed)) {
        setAtPath(root, issue.path, parsed);
        return {
          value: root,
          repair: { toolName, fieldPath: issue.path, repairKind: "parse_stringified_array", before: current, after: JSON.stringify(parsed) },
        };
      }
      if (effectiveSchema.type === "object" && isPlainObject(parsed)) {
        setAtPath(root, issue.path, parsed);
        return {
          value: root,
          repair: { toolName, fieldPath: issue.path, repairKind: "parse_stringified_object", before: current, after: JSON.stringify(parsed) },
        };
      }
    } catch {
      // Fall through
    }
  }

  // 4. Unwrap markdown autolink in paths (by format hint or field name)
  if ((issue.code === "path_markdown_autolink" || issue.code === "type") && typeof current === "string" && (effectiveSchema.format === "path" || looksLikePathField(issue.path))) {
    const unwrapped = unwrapDegenerateMarkdownAutolink(current);
    if (unwrapped !== current) {
      setAtPath(root, issue.path, unwrapped);
      return {
        value: root,
        repair: { toolName, fieldPath: issue.path, repairKind: "unwrap_markdown_autolink", before: current, after: unwrapped },
      };
    }
  }

  // 5. Coerce string boolean
  if (issue.code === "type" && effectiveSchema.type === "boolean" && typeof current === "string") {
    const bool = parseBooleanString(current);
    if (bool !== null) {
      setAtPath(root, issue.path, bool);
      return {
        value: root,
        repair: { toolName, fieldPath: issue.path, repairKind: "coerce_string_boolean", before: current, after: String(bool) },
      };
    }
  }

  // 6. Coerce numeric string
  if (issue.code === "type" && (effectiveSchema.type === "number" || effectiveSchema.type === "integer") && typeof current === "string") {
    const num = parseNumericString(current);
    if (num !== null && (effectiveSchema.type === "number" || Number.isInteger(num))) {
      setAtPath(root, issue.path, num);
      return {
        value: root,
        repair: { toolName, fieldPath: issue.path, repairKind: "coerce_numeric_string", before: current, after: String(num) },
      };
    }
  }

  // 7. Wrap bare string as array (safe shape coercion, not destructive)
  if (issue.code === "type" && effectiveSchema.type === "array" && typeof current === "string") {
    const trimmed = current.trim();
    if (trimmed.length > 0) {
      const arr = [trimmed];
      setAtPath(root, issue.path, arr);
      return {
        value: root,
        repair: { toolName, fieldPath: issue.path, repairKind: "wrap_bare_string_to_array", before: current, after: JSON.stringify(arr) },
      };
    }
  }

  // 8. Wrap object as array
  if (issue.code === "type" && effectiveSchema.type === "array" && isPlainObject(current) && policy.allowDestructive) {
    const obj = current as Record<string, unknown>;
    const after = Object.keys(obj).length === 0
      ? []
      : effectiveSchema.items?.type === "object" ? [obj] : null;

    if (after !== null) {
      setAtPath(root, issue.path, after);
      return {
        value: root,
        repair: { toolName, fieldPath: issue.path, repairKind: "wrap_object_to_array", before: JSON.stringify(current), after: JSON.stringify(after) },
      };
    }
  }

  // 9. Enum near-miss
  if (issue.code === "enum" && typeof current === "string" && effectiveSchema.enum) {
    const pathKey = issue.path.replace(/^\./, "");
    const aliases = { ...ENUM_ALIASES[`${toolName}.${pathKey}`], ...policy.enumAliases[`${toolName}.${pathKey}`] };
    const normalized = current.trim().toLowerCase();
    const aliasTarget = aliases[normalized];
    const caseTarget = effectiveSchema.enum.find((v) => v.toLowerCase() === normalized);

    const target = aliasTarget ?? caseTarget;
    if (target && effectiveSchema.enum.includes(target)) {
      setAtPath(root, issue.path, target);
      return {
        value: root,
        repair: { toolName, fieldPath: issue.path, repairKind: "enum_near_miss", before: current, after: target },
      };
    }
  }

  return null;
}

// ─── Relational defaults ──────────────────────────────────────────

interface RelationalRepair {
  fieldPath: string;
  value: unknown;
  record: RepairRecord;
}

function applyRelationalDefaults(
  toolName: string,
  args: Record<string, unknown>,
  defaults: Record<string, RelationalDefaultRule[]>,
): RelationalRepair[] {
  const rules = defaults[toolName];
  if (!rules) return [];

  const repairs: RelationalRepair[] = [];
  for (const rule of rules) {
    const allPresent = rule.whenPresent.every((f) => f in args);
    const allMissing = rule.whenMissing.every((f) => !(f in args));
    if (allPresent && allMissing) {
      for (const [field, value] of Object.entries(rule.set)) {
        repairs.push({
          fieldPath: `.${field}`,
          value,
          record: {
            toolName,
            fieldPath: `.${field}`,
            repairKind: "relational_default",
            before: "(missing)",
            after: JSON.stringify(value),
          },
        });
      }
    }
  }
  return repairs;
}

function applyRelationalRepair(
  args: Record<string, unknown>,
  repair: RelationalRepair,
): Record<string, unknown> {
  args[repair.fieldPath.replace(/^\./, "")] = repair.value;
  return args;
}

// ─── Full tool-call repair pipeline ───────────────────────────────

export function repairToolCallsSchemaAware(
  toolCalls: Array<Record<string, unknown>>,
  availableTools: Array<Record<string, unknown>>,
  policy: RepairPolicyConfig,
): ToolCallRepairResult {
  const schemaMap = buildToolSchemaMap(availableTools);
  const allRecords: RepairRecord[] = [];
  const mergedAliases = { ...TOOL_NAME_ALIASES, ...policy.toolNameAliases };

  // NOTE: Generic repair (JSON syntax, tool-name dedup) is assumed to have
  // already been run by the caller (evaluateResponse). Do not re-run here.
  const candidates = toolCalls;

  let anyChanged = false;
  const repairedCalls: Array<Record<string, unknown>> = [];

  for (const tc of candidates) {
    const fn = tc.function as Record<string, unknown> | undefined;
    if (!fn) {
      repairedCalls.push(tc);
      continue;
    }

    const rawName = fn.name as string | undefined;
    if (!rawName) {
      repairedCalls.push(tc);
      continue;
    }

    // Tool name aliasing
    let resolvedName = rawName;
    const alias = resolveToolName(rawName, mergedAliases);
    if (alias) {
      resolvedName = alias;
      allRecords.push({
        toolName: resolvedName,
        fieldPath: ".name",
        repairKind: "tool_name_alias",
        before: rawName,
        after: resolvedName,
      });
      anyChanged = true;
    }

    // Parse arguments
    let args: Record<string, unknown>;
    const rawArgs = fn.arguments;
    if (typeof rawArgs === "string") {
      try {
        args = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        repairedCalls.push({ ...tc, function: { ...fn, name: resolvedName } });
        continue;
      }
    } else if (isPlainObject(rawArgs)) {
      args = rawArgs as Record<string, unknown>;
    } else {
      repairedCalls.push({ ...tc, function: { ...fn, name: resolvedName } });
      continue;
    }

    // Schema-aware repair
    const schema = schemaMap.get(resolvedName);
    if (!schema) {
      repairedCalls.push({ ...tc, function: { ...fn, name: resolvedName, arguments: JSON.stringify(args) } });
      continue;
    }

    const toolPolicy: RepairPolicyConfig = {
      ...policy,
      allowDestructive: policy.allowDestructive && !isDestructiveToolName(resolvedName),
    };

    const result = repairToolArguments(resolvedName, args, schema, toolPolicy);
    if (result.changed) {
      anyChanged = true;
      allRecords.push(...result.repairs);
    }

    repairedCalls.push({
      ...tc,
      function: { ...fn, name: resolvedName, arguments: JSON.stringify(result.repaired) },
    });
  }

  return {
    repaired: anyChanged ? repairedCalls : null,
    repairRecords: allRecords,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getAtPath(root: Record<string, unknown>, path: string): unknown {
  const parts = parsePath(path);
  let current: unknown = root;
  for (const part of parts) {
    if ((current === null || current === undefined)) return undefined;
    current = (current as Record<string, unknown>)[part.key];
    if (part.index !== undefined && Array.isArray(current)) {
      current = current[part.index];
    }
  }
  return current;
}

function setAtPath(root: Record<string, unknown>, path: string, value: unknown): void {
  const parts = parsePath(path);
  let current: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    let next: unknown = current[part.key];
    if (part.index !== undefined && Array.isArray(next)) {
      const element = next[part.index];
      if (!isPlainObject(element)) {
        next[part.index] = {};
      }
      next = next[part.index];
    } else {
      if (part.index !== undefined) {
        if (!Array.isArray(next)) {
          next = [];
          current[part.key] = next;
        }
        const arr = next as unknown[];
        if (!isPlainObject(arr[part.index])) {
          arr[part.index] = {};
        }
        next = arr[part.index];
      } else if (!isPlainObject(next)) {
        next = {};
        current[part.key] = next;
      }
    }
    current = next as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  if (last.index !== undefined) {
    const arr = current[last.key];
    if (Array.isArray(arr)) {
      arr[last.index] = value;
    }
  } else {
    current[last.key] = value;
  }
}

function deleteAtPath(root: Record<string, unknown>, path: string): void {
  const parts = parsePath(path);
  if (parts.length === 0) return;
  let current: Record<string, unknown> = root;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    let next: unknown = current[part.key];
    if (part.index !== undefined && Array.isArray(next)) {
      next = next[part.index];
    }
    if (!isPlainObject(next)) return;
    current = next as Record<string, unknown>;
  }
  const last = parts[parts.length - 1];
  delete current[last.key];
}

interface PathPart { key: string; index?: number; }

function parsePath(path: string): PathPart[] {
  if (!path || path === ".") return [];
  const clean = path.replace(/^\./, "");
  const parts: PathPart[] = [];
  for (const segment of clean.split(".")) {
    const arrMatch = segment.match(/^([^\[\]]+)\[(\d+)\]$/);
    if (arrMatch) {
      parts.push({ key: arrMatch[1], index: parseInt(arrMatch[2], 10) });
    } else if (segment) {
      parts.push({ key: segment });
    }
  }
  return parts;
}

function schemaAtPath(schema: ToolParameterSchema, path: string): ToolParameterSchema | null {
  const parts = parsePath(path);
  let current: ToolParameterSchema | null = schema;
  for (const part of parts) {
    if (!current) return null;
    // Resolve anyOf/oneOf before traversing
    const resolved = resolveSchemaForTraversal(current);
    if (resolved.type === "object") {
      current = resolved.properties?.[part.key] ?? null;
      if (part.index !== undefined && current?.type === "array") {
        current = current.items ?? null;
      }
      continue;
    }
    if (resolved.type === "array") {
      current = resolved.items ?? null;
      continue;
    }
    return null;
  }
  return current;
}

function resolveSchemaForTraversal(schema: ToolParameterSchema): ToolParameterSchema {
  if (schema.type) return schema;
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (!alternatives || alternatives.length === 0) return schema;
  // Prefer the first branch with a type (usually the primary variant)
  for (const alt of alternatives) {
    if (alt.type === "object" || alt.type === "array") return alt;
  }
  return alternatives[0] ?? schema;
}

function isOptionalField(schema: ToolParameterSchema, path: string): boolean {
  const parts = parsePath(path);
  if (parts.length === 0) return false;
  const parentPath = parts.slice(0, -1);
  const lastKey = parts[parts.length - 1].key;

  let parent: ToolParameterSchema | null = schema;
  for (const part of parentPath) {
    if (!parent) return false;
    const resolved = resolveSchemaForTraversal(parent);
    if (resolved.type === "object") {
      parent = resolved.properties?.[part.key] ?? null;
    } else if (resolved.type === "array") {
      parent = resolved.items ?? null;
    } else {
      return false;
    }
  }

  if (!parent) return false;
  const resolvedParent = resolveSchemaForTraversal(parent);
  if (resolvedParent.type !== "object") return false;
  const required = resolvedParent.required ?? [];
  if (required.includes(lastKey)) return false;

  // Check if the field schema explicitly allows null
  const fieldSchema = resolvedParent.properties?.[lastKey];
  if (fieldSchema && schemaAllowsNull(fieldSchema)) return false;

  return true;
}

function schemaAllowsNull(schema: ToolParameterSchema): boolean {
  if (schema.type === "null") return true;
  // Array of types like ["string", "null"]
  if (Array.isArray(schema.type) && schema.type.includes("null")) return true;
  // anyOf/oneOf containing null
  const alternatives = schema.anyOf ?? schema.oneOf;
  if (alternatives?.some((a) => a.type === "null")) return true;
  return false;
}

function unwrapCodeFence(input: string): string {
  const match = input.match(/^```(?:json|JSON)?\s*([\s\S]*?)\s*```$/);
  return match ? match[1].trim() : input;
}

function parseBooleanString(input: string): boolean | null {
  const n = input.trim().toLowerCase();
  if (["true", "yes", "y", "1"].includes(n)) return true;
  if (["false", "no", "n", "0"].includes(n)) return false;
  return null;
}

function parseNumericString(input: string): number | null {
  const t = input.trim();
  if (!/^-?(?:\d+|\d+\.\d+)$/.test(t)) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
}

function containsDegenerateMarkdownAutolink(input: string): boolean {
  return unwrapDegenerateMarkdownAutolink(input) !== input;
}

function unwrapDegenerateMarkdownAutolink(input: string): string {
  return input.replace(
    /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g,
    (full, text: string, url: string) => {
      const cleanText = normalizeLinkComparable(text);
      const cleanUrl = normalizeLinkComparable(url.replace(/^https?:\/\//i, ""));
      // Only unwrap when the link text IS the URL (degenerate autolink where
      // the model echoed the display text as the href). Legitimate links like
      // [api](https://example.com/api) must NOT be stripped.
      if (cleanText === cleanUrl) {
        return text;
      }
      return full;
    },
  );
}

function normalizeLinkComparable(input: string): string {
  return input.trim().replace(/\s+/g, "").replace(/^\/+/, "").replace(/\/+$/, "").toLowerCase();
}

const PATH_FIELD_RE = /(?:path|filepath|absolutepath|relativepath|uri|filename|file|directory|dir|folder|repo|root)$/i;

function looksLikePathField(path: string): boolean {
  const fieldName = path.split(".").pop()?.split("[").shift() ?? "";
  return PATH_FIELD_RE.test(fieldName);
}
