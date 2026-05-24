import { describe, it, expect } from "vitest";
import {
  repairToolArguments,
  repairToolCallsSchemaAware,
  buildToolSchemaMap,
  validateAgainstSchema,
  validateToolCallsAgainstSchemas,
  type ToolParameterSchema,
  type RepairPolicyConfig,
} from "../../src/nim/repair/schema-aware";
import { isDestructiveToolName } from "../../src/nim/repair/aliases";

const defaultPolicy: RepairPolicyConfig = {
  allowDestructive: true,
  enumAliases: {},
  toolNameAliases: {},
  relationalDefaults: {},
};

// ─── Helpers ──────────────────────────────────────────────────────

function makeTool(name: string, parameters: ToolParameterSchema) {
  return { type: "function", function: { name, parameters } };
}

function makeToolCall(name: string, args: Record<string, unknown>) {
  return {
    id: "call_1",
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

// ─── buildToolSchemaMap ───────────────────────────────────────────

describe("buildToolSchemaMap", () => {
  it("extracts schemas from tool definitions", () => {
    const tools = [
      makeTool("readFile", {
        type: "object",
        required: ["path"],
        properties: { path: { type: "string" }, limit: { type: "integer" } },
      }),
      makeTool("search", {
        type: "object",
        required: ["query"],
        properties: { query: { type: "string" } },
      }),
    ];
    const map = buildToolSchemaMap(tools);
    expect(map.size).toBe(2);
    expect(map.get("readFile")?.type).toBe("object");
    expect(map.get("search")?.required).toEqual(["query"]);
  });

  it("skips tools without valid names or parameters", () => {
    const tools = [
      { type: "function", function: { name: "", parameters: { type: "object" } } },
      { type: "function", function: { name: "ok" } },
    ];
    const map = buildToolSchemaMap(tools);
    expect(map.size).toBe(0);
  });
});

// ─── Repair: omit_optional_null ───────────────────────────────────

describe("repairToolArguments: omit_optional_null", () => {
  const schema: ToolParameterSchema = {
    type: "object",
    required: ["path"],
    properties: {
      path: { type: "string" },
      encoding: { type: "string" },
    },
  };

  it("removes null for optional fields", () => {
    const result = repairToolArguments("readFile", { path: "/foo", encoding: null }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect(result.repaired.encoding).toBeUndefined();
    expect(result.repaired.path).toBe("/foo");
    expect(result.repairs[0].repairKind).toBe("omit_optional_null");
  });

  it("does not remove null for required fields", () => {
    const result = repairToolArguments("readFile", { path: null }, schema, defaultPolicy);
    // path is required, so null is not omitted — it remains a type error
    expect(result.repairs.every((r) => r.repairKind !== "omit_optional_null")).toBe(true);
  });

  it("omits null for optional field nested inside anyOf parent", () => {
    const anyOfSchema: ToolParameterSchema = {
      type: "object",
      properties: {
        config: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                verbose: { type: "boolean" },
              },
            },
          ],
        },
      },
    };
    const result = repairToolArguments("tool", { config: { verbose: null } }, anyOfSchema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect((result.repaired.config as Record<string, unknown>).verbose).toBeUndefined();
    expect(result.repairs.some((r) => r.repairKind === "omit_optional_null")).toBe(true);
  });
});

// ─── Repair: parse_stringified_array ──────────────────────────────

describe("repairToolArguments: parse_stringified_array", () => {
  const schema: ToolParameterSchema = {
    type: "object",
    required: ["paths"],
    properties: {
      paths: { type: "array", items: { type: "string" } },
    },
  };

  it('parses stringified JSON array "["a","b"]" into array', () => {
    const result = repairToolArguments("tool", { paths: '["a","b"]' }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect(result.repaired.paths).toEqual(["a", "b"]);
    expect(result.repairs[0].repairKind).toBe("parse_stringified_array");
  });

  it("does not touch already-valid arrays", () => {
    const result = repairToolArguments("tool", { paths: ["a", "b"] }, schema, defaultPolicy);
    expect(result.changed).toBe(false);
  });
});

// ─── Repair: parse_stringified_object ─────────────────────────────

describe("repairToolArguments: parse_stringified_object", () => {
  const schema: ToolParameterSchema = {
    type: "object",
    properties: {
      config: { type: "object", properties: { key: { type: "string" } } },
    },
  };

  it('parses stringified JSON object into object', () => {
    const result = repairToolArguments("tool", { config: '{"key":"val"}' }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect(result.repaired.config).toEqual({ key: "val" });
    expect(result.repairs[0].repairKind).toBe("parse_stringified_object");
  });
});

// ─── Repair: wrap_bare_string_to_array ────────────────────────────

describe("repairToolArguments: wrap_bare_string_to_array", () => {
  const schema: ToolParameterSchema = {
    type: "object",
    required: ["queries"],
    properties: {
      queries: { type: "array", items: { type: "string" } },
    },
  };

  it('wraps bare string "foo" as ["foo"]', () => {
    const result = repairToolArguments("tool", { queries: "foo" }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect(result.repaired.queries).toEqual(["foo"]);
    expect(result.repairs[0].repairKind).toBe("wrap_bare_string_to_array");
  });

  it('trims whitespace before wrapping "  foo  " as ["foo"]', () => {
    const result = repairToolArguments("tool", { queries: "  foo  " }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect(result.repaired.queries).toEqual(["foo"]);
  });
});

// ─── Repair: wrap_object_to_array ─────────────────────────────────

describe("repairToolArguments: wrap_object_to_array", () => {
  const schema: ToolParameterSchema = {
    type: "object",
    required: ["items"],
    properties: {
      items: { type: "array", items: { type: "object", properties: { name: { type: "string" } } } },
    },
  };

  it("wraps empty object {} as []", () => {
    const result = repairToolArguments("tool", { items: {} }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect(result.repaired.items).toEqual([]);
    expect(result.repairs[0].repairKind).toBe("wrap_object_to_array");
  });

  it("wraps singleton object as [object] when items type is object", () => {
    const result = repairToolArguments("tool", { items: { name: "foo" } }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect(result.repaired.items).toEqual([{ name: "foo" }]);
  });
});

// ─── Repair: coerce_string_boolean ────────────────────────────────

describe("repairToolArguments: coerce_string_boolean", () => {
  const schema: ToolParameterSchema = {
    type: "object",
    properties: {
      verbose: { type: "boolean" },
    },
  };

  it('converts "true" to true', () => {
    const result = repairToolArguments("tool", { verbose: "true" }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect(result.repaired.verbose).toBe(true);
    expect(result.repairs[0].repairKind).toBe("coerce_string_boolean");
  });

  it('converts "false" to false', () => {
    const result = repairToolArguments("tool", { verbose: "false" }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect(result.repaired.verbose).toBe(false);
  });

  it('converts "yes" to true and "no" to false', () => {
    expect(repairToolArguments("tool", { verbose: "yes" }, schema, defaultPolicy).repaired.verbose).toBe(true);
    expect(repairToolArguments("tool", { verbose: "no" }, schema, defaultPolicy).repaired.verbose).toBe(false);
  });
});

// ─── Repair: coerce_numeric_string ────────────────────────────────

describe("repairToolArguments: coerce_numeric_string", () => {
  const schema: ToolParameterSchema = {
    type: "object",
    properties: {
      count: { type: "integer" },
      ratio: { type: "number" },
    },
  };

  it('converts "10" to 10 for integer field', () => {
    const result = repairToolArguments("tool", { count: "10" }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect(result.repaired.count).toBe(10);
    expect(result.repairs[0].repairKind).toBe("coerce_numeric_string");
  });

  it('converts "0.8" to 0.8 for number field', () => {
    const result = repairToolArguments("tool", { ratio: "0.8" }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect(result.repaired.ratio).toBe(0.8);
  });

  it("coerces numeric strings through JSON Schema union type", () => {
    const unionSchema: ToolParameterSchema = {
      type: "object",
      properties: {
        count: { type: ["integer", "null"] },
      },
    };
    const result = repairToolArguments("tool", { count: "7" }, unionSchema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect(result.repaired.count).toBe(7);
  });

  it("accepts null through JSON Schema union type", () => {
    const unionSchema: ToolParameterSchema = {
      type: "object",
      properties: {
        count: { type: ["integer", "null"] },
      },
    };
    const result = repairToolArguments("tool", { count: null }, unionSchema, defaultPolicy);
    expect(result.changed).toBe(false);
    expect(result.repairs).toHaveLength(0);
  });
});

// ─── Repair: enum_near_miss ───────────────────────────────────────

describe("repairToolArguments: enum_near_miss", () => {
  const schema: ToolParameterSchema = {
    type: "object",
    required: ["language"],
    properties: {
      language: { type: "string", enum: ["javascript", "typescript", "python"] },
    },
  };

  it("maps enum alias when configured", () => {
    const policy: RepairPolicyConfig = {
      ...defaultPolicy,
      enumAliases: { "tool.language": { js: "javascript", ts: "typescript", py: "python" } },
    };
    const result = repairToolArguments("tool", { language: "js" }, schema, policy);
    expect(result.changed).toBe(true);
    expect(result.repaired.language).toBe("javascript");
    expect(result.repairs[0].repairKind).toBe("enum_near_miss");
  });

  it("case-insensitive match when no alias", () => {
    const result = repairToolArguments("tool", { language: "Python" }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect(result.repaired.language).toBe("python");
  });
});

// ─── Repair: prune_extra_keys ─────────────────────────────────────

describe("repairToolArguments: prune_extra_keys", () => {
  const schema: ToolParameterSchema = {
    type: "object",
    additionalProperties: false,
    properties: {
      path: { type: "string" },
    },
  };

  it("removes unknown keys when additionalProperties is false", () => {
    const result = repairToolArguments("tool", { path: "/foo", reasoning: "because" }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect(result.repaired.reasoning).toBeUndefined();
    expect(result.repaired.path).toBe("/foo");
    expect(result.repairs.some((r) => r.repairKind === "prune_extra_keys")).toBe(true);
  });

  it("does not prune when allowDestructive is false", () => {
    const conservative: RepairPolicyConfig = { ...defaultPolicy, allowDestructive: false };
    const result = repairToolArguments("tool", { path: "/foo", reasoning: "because" }, schema, conservative);
    expect(result.repaired.reasoning).toBe("because");
    expect(result.repairs.some((r) => r.repairKind === "prune_extra_keys")).toBe(false);
  });

  it("still reports unknown-key schema issues when destructive repair is disabled", () => {
    const conservative: RepairPolicyConfig = { ...defaultPolicy, allowDestructive: false };
    const issues = validateAgainstSchema({ path: "/foo", reasoning: "because" }, schema, conservative);
    expect(issues.some((issue) => issue.code === "unknown_key" && issue.path === ".reasoning")).toBe(true);
  });
});

// ─── Repair: unwrap_markdown_autolink ─────────────────────────────

describe("repairToolArguments: unwrap_markdown_autolink", () => {
  const schema: ToolParameterSchema = {
    type: "object",
    required: ["filePath"],
    properties: {
      filePath: { type: "string", format: "path" },
    },
  };

  it("unwraps markdown autolink in path", () => {
    const result = repairToolArguments("tool", { filePath: "/proj/[notes.md](http://notes.md)" }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect(result.repaired.filePath).toBe("/proj/notes.md");
    expect(result.repairs[0].repairKind).toBe("unwrap_markdown_autolink");
  });

  it("does not touch clean paths", () => {
    const result = repairToolArguments("tool", { filePath: "/foo/bar.ts" }, schema, defaultPolicy);
    expect(result.changed).toBe(false);
  });
});

// ─── Repair: relational_default ───────────────────────────────────

describe("repairToolArguments: relational_default", () => {
  const schema: ToolParameterSchema = {
    type: "object",
    properties: {
      offset: { type: "integer" },
      limit: { type: "integer" },
    },
  };

  it("injects missing field when whenPresent condition met", () => {
    const policy: RepairPolicyConfig = {
      ...defaultPolicy,
      relationalDefaults: {
        readFile: [{ whenPresent: ["limit"], whenMissing: ["offset"], set: { offset: 0 } }],
      },
    };
    const result = repairToolArguments("readFile", { limit: 50 }, schema, policy);
    expect(result.changed).toBe(true);
    expect(result.repaired.offset).toBe(0);
    expect(result.repaired.limit).toBe(50);
    expect(result.repairs.some((r) => r.repairKind === "relational_default")).toBe(true);
  });

  it("does not inject when whenPresent field is missing", () => {
    const policy: RepairPolicyConfig = {
      ...defaultPolicy,
      relationalDefaults: {
        readFile: [{ whenPresent: ["limit"], whenMissing: ["offset"], set: { offset: 0 } }],
      },
    };
    const result = repairToolArguments("readFile", {}, schema, policy);
    expect(result.repaired.offset).toBeUndefined();
  });

  it("does not inject when field already present", () => {
    const policy: RepairPolicyConfig = {
      ...defaultPolicy,
      relationalDefaults: {
        readFile: [{ whenPresent: ["limit"], whenMissing: ["offset"], set: { offset: 0 } }],
      },
    };
    const result = repairToolArguments("readFile", { offset: 10, limit: 50 }, schema, policy);
    expect(result.changed).toBe(false);
  });
});

// ─── Repair ordering ──────────────────────────────────────────────

describe("repair ordering", () => {
  it("parses stringified array before wrapping bare string", () => {
    const schema: ToolParameterSchema = {
      type: "object",
      required: ["items"],
      properties: {
        items: { type: "array", items: { type: "string" } },
      },
    };
    // '["a","b"]' should parse as array, NOT be wrapped as ['["a","b"]']
    const result = repairToolArguments("tool", { items: '["a","b"]' }, schema, defaultPolicy);
    expect(result.repaired.items).toEqual(["a", "b"]);
    expect(result.repairs[0].repairKind).toBe("parse_stringified_array");
  });
});

// ─── Full pipeline: repairToolCallsSchemaAware ────────────────────

describe("repairToolCallsSchemaAware", () => {
  const tools = [
    makeTool("readFile", {
      type: "object",
      required: ["path"],
      additionalProperties: false,
      properties: {
        path: { type: "string", format: "path" },
        limit: { type: "integer" },
        encoding: { type: "string" },
      },
    }),
    makeTool("search", {
      type: "object",
      required: ["queries"],
      properties: {
        queries: { type: "array", items: { type: "string" } },
      },
    }),
  ];

  it("repairs stringified args + null omission + unknown key pruning", () => {
    const toolCall = makeToolCall("readFile", { path: "/foo.ts", encoding: null, reasoning: "test" });
    const result = repairToolCallsSchemaAware([toolCall], tools, defaultPolicy);
    expect(result.repaired).not.toBeNull();

    const repairedFn = result.repaired![0].function as { name: string; arguments: string };
    const repairedArgs = JSON.parse(repairedFn.arguments);
    expect(repairedArgs.path).toBe("/foo.ts");
    expect(repairedArgs.encoding).toBeUndefined();
    expect(repairedArgs.reasoning).toBeUndefined();

    const kinds = result.repairRecords.map((r) => r.repairKind);
    expect(kinds).toContain("omit_optional_null");
    expect(kinds).toContain("prune_extra_keys");
  });

  it("returns null when no repairs needed", () => {
    const toolCall = makeToolCall("readFile", { path: "/foo.ts" });
    const result = repairToolCallsSchemaAware([toolCall], tools, defaultPolicy);
    expect(result.repaired).toBeNull();
  });

  it("applies tool name aliases", () => {
    const policy: RepairPolicyConfig = {
      ...defaultPolicy,
      toolNameAliases: { read_file: "readFile" },
    };
    const toolCall = makeToolCall("read_file", { path: "/foo.ts" });
    const result = repairToolCallsSchemaAware([toolCall], tools, policy);
    const repairedFn = result.repaired![0].function as { name: string; arguments: string };
    expect(repairedFn.name).toBe("readFile");
    expect(result.repairRecords.some((r) => r.repairKind === "tool_name_alias")).toBe(true);
  });

  it("wraps bare string as array for search tool", () => {
    const toolCall = makeToolCall("search", { queries: "error" });
    const result = repairToolCallsSchemaAware([toolCall], tools, defaultPolicy);
    const repairedFn = result.repaired![0].function as { name: string; arguments: string };
    const repairedArgs = JSON.parse(repairedFn.arguments);
    expect(repairedArgs.queries).toEqual(["error"]);
  });

  it("schema validation rejects non-object parsed arguments", () => {
    const result = validateToolCallsAgainstSchemas([
      {
        id: "call_1",
        type: "function",
        function: { name: "readFile", arguments: "[]" },
      },
    ], tools, defaultPolicy);

    expect(result.valid).toBe(false);
    expect(result.issues[0].issues[0]).toMatchObject({ path: "", code: "type", expected: "object" });
  });
});

// ─── isDestructiveToolName ────────────────────────────────────────

describe("isDestructiveToolName", () => {
  it("detects destructive tool names", () => {
    expect(isDestructiveToolName("writeFile")).toBe(true);
    expect(isDestructiveToolName("deleteRecord")).toBe(true);
    expect(isDestructiveToolName("removeItem")).toBe(true);
    expect(isDestructiveToolName("updateConfig")).toBe(true);
  });

  it("passes for non-destructive tool names", () => {
    expect(isDestructiveToolName("readFile")).toBe(false);
    expect(isDestructiveToolName("search")).toBe(false);
    expect(isDestructiveToolName("listItems")).toBe(false);
  });
});

// ─── No-op on valid input ─────────────────────────────────────────

describe("no-op on valid input", () => {
  it("returns unchanged when args match schema", () => {
    const schema: ToolParameterSchema = {
      type: "object",
      required: ["name"],
      properties: {
        name: { type: "string" },
        count: { type: "integer" },
        active: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
      },
    };
    const result = repairToolArguments("tool", { name: "test", count: 5, active: true, tags: ["a"] }, schema, defaultPolicy);
    expect(result.changed).toBe(false);
    expect(result.repairs).toHaveLength(0);
  });
});

// ─── Nested object repair ─────────────────────────────────────────

describe("nested object repair", () => {
  it("recurses into nested objects", () => {
    const schema: ToolParameterSchema = {
      type: "object",
      properties: {
        config: {
          type: "object",
          properties: {
            verbose: { type: "boolean" },
          },
        },
      },
    };
    const result = repairToolArguments("tool", { config: { verbose: "true" } }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect((result.repaired.config as Record<string, unknown>).verbose).toBe(true);
  });
});

// ─── anyOf/oneOf resolution ───────────────────────────────────────

describe("anyOf/oneOf resolution", () => {
  it("resolves anyOf to matching type branch", () => {
    const schema: ToolParameterSchema = {
      type: "object",
      properties: {
        value: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
      },
    };
    // Send an array — should resolve to the array branch
    const result = repairToolArguments("tool", { value: ["a", "b"] }, schema, defaultPolicy);
    expect(result.changed).toBe(false);
  });

  it("repairs bare string in anyOf array branch", () => {
    const schema: ToolParameterSchema = {
      type: "object",
      required: ["items"],
      properties: {
        items: {
          anyOf: [
            { type: "string" },
            { type: "array", items: { type: "string" } },
          ],
        },
      },
    };
    // "foo" is a valid string — anyOf resolves to string branch, no repair
    const result = repairToolArguments("tool", { items: "foo" }, schema, defaultPolicy);
    expect(result.changed).toBe(false);
  });

  it("repairs nested object inside anyOf object branch", () => {
    const schema: ToolParameterSchema = {
      type: "object",
      properties: {
        config: {
          anyOf: [
            { type: "string" },
            {
              type: "object",
              properties: {
                verbose: { type: "boolean" },
              },
            },
          ],
        },
      },
    };
    // Send object with string boolean — anyOf resolves to object branch, verbose gets coerced
    const result = repairToolArguments("tool", { config: { verbose: "true" } }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect((result.repaired.config as Record<string, unknown>).verbose).toBe(true);
  });
});

// ─── Hyphenated field names ──────────────────────────────────────

describe("repairToolArguments: array element null omission", () => {
  it("splices null elements from arrays instead of deleting the whole array", () => {
    const schema: ToolParameterSchema = {
      type: "object",
      properties: {
        tags: { type: "array", items: { type: "string" } },
      },
    };
    const result = repairToolArguments("tool", { tags: [null, "a"] }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect(result.repaired.tags).toEqual(["a"]);
    expect(result.repairs.some((r) => r.repairKind === "omit_optional_null")).toBe(true);
  });
});

describe("repairToolArguments: JSON Schema type unions", () => {
  it("accepts null for type: [string, null] fields", () => {
    const schema: ToolParameterSchema = {
      type: "object",
      properties: {
        note: { type: ["string", "null"] },
      },
    };
    const result = repairToolArguments("tool", { note: null }, schema, defaultPolicy);
    expect(result.changed).toBe(false);
    expect(result.repaired.note).toBeNull();
  });
});

describe("hyphenated field names with array indices", () => {
  it("repairs bare string in hyphenated array field", () => {
    const schema: ToolParameterSchema = {
      type: "object",
      required: ["search-queries"],
      properties: {
        "search-queries": { type: "array", items: { type: "string" } },
      },
    };
    const result = repairToolArguments("tool", { "search-queries": "error" }, schema, defaultPolicy);
    expect(result.changed).toBe(true);
    expect(result.repaired["search-queries"]).toEqual(["error"]);
  });
});
