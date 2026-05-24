// Smoke test: the four core repair cases from the catalogue
import { describe, it, expect } from "vitest";
import { repairToolCallsSchemaAware, type RepairPolicyConfig } from "../../src/nim/repair/schema-aware";

const policy: RepairPolicyConfig = {
  allowDestructive: true,
  enumAliases: {},
  toolNameAliases: {},
  relationalDefaults: {},
};

// Realistic writeFile schema
const writeFileTool = {
  type: "function",
  function: {
    name: "writeFile",
    parameters: {
      type: "object",
      required: ["filePath", "content"],
      additionalProperties: false,
      properties: {
        filePath: { type: "string", format: "path" },
        content: { type: "string" },
        createParents: { type: "boolean" },
      },
    },
  },
};

// Realistic readFile schema with optional fields
const readFileTool = {
  type: "function",
  function: {
    name: "readFile",
    parameters: {
      type: "object",
      required: ["absolutePath"],
      properties: {
        absolutePath: { type: "string", format: "path" },
        offset: { type: "integer" },
        limit: { type: "integer" },
        encoding: { type: "string" },
      },
    },
  },
};

// Realistic searchFiles schema expecting arrays
const searchFilesTool = {
  type: "function",
  function: {
    name: "searchFiles",
    parameters: {
      type: "object",
      required: ["queries"],
      properties: {
        queries: { type: "array", items: { type: "string" } },
        globs: { type: "array", items: { type: "string" } },
      },
    },
  },
};

function tc(name: string, args: Record<string, unknown>) {
  return {
    id: "call_test",
    type: "function",
    function: { name, arguments: JSON.stringify(args) },
  };
}

const tools = [writeFileTool, readFileTool, searchFilesTool];

describe("four core repair cases", () => {
  it("1. null for optional field -> omit it", () => {
    const call = tc("readFile", { absolutePath: "/foo.ts", encoding: null });
    const result = repairToolCallsSchemaAware([call], tools, policy);
    expect(result.repaired).not.toBeNull();
    const args = JSON.parse((result.repaired![0].function as any).arguments);
    expect(args.absolutePath).toBe("/foo.ts");
    expect(args.encoding).toBeUndefined();
    expect(args).not.toHaveProperty("encoding");
  });

  it("2. array emitted as JSON string -> parse it", () => {
    const call = tc("searchFiles", { queries: '["error","bug"]' });
    const result = repairToolCallsSchemaAware([call], tools, policy);
    expect(result.repaired).not.toBeNull();
    const args = JSON.parse((result.repaired![0].function as any).arguments);
    expect(args.queries).toEqual(["error", "bug"]);
  });

  it("3. bare string where array expected -> wrap as [value]", () => {
    const call = tc("searchFiles", { queries: "error" });
    const result = repairToolCallsSchemaAware([call], tools, policy);
    expect(result.repaired).not.toBeNull();
    const args = JSON.parse((result.repaired![0].function as any).arguments);
    expect(args.queries).toEqual(["error"]);
  });

  it("4. markdown autolink in path -> unwrap it", () => {
    const call = tc("writeFile", {
      filePath: "/Users/x/proj/[notes.md](http://notes.md)",
      content: "hello",
    });
    const result = repairToolCallsSchemaAware([call], tools, policy);
    expect(result.repaired).not.toBeNull();
    const args = JSON.parse((result.repaired![0].function as any).arguments);
    expect(args.filePath).toBe("/Users/x/proj/notes.md");
    expect(args.content).toBe("hello");
  });
});

describe("repair ordering", () => {
  it("json-array parse runs before bare-string wrap (the ordering bug)", () => {
    // '["a","b"]' must parse as array, NOT become ['["a","b"]']
    const call = tc("searchFiles", { queries: '["a","b"]' });
    const result = repairToolCallsSchemaAware([call], tools, policy);
    const args = JSON.parse((result.repaired![0].function as any).arguments);
    expect(args.queries).toEqual(["a", "b"]);
    expect(result.repairRecords[0].repairKind).toBe("parse_stringified_array");
  });
});

describe("valid input is never touched", () => {
  it("returns null (no change) for valid tool calls", () => {
    const call = tc("readFile", { absolutePath: "/foo.ts", limit: 30 });
    const result = repairToolCallsSchemaAware([call], tools, policy);
    expect(result.repaired).toBeNull();
  });
});
