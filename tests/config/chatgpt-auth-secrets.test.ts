import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadLocalSecretEnv, validateChatGPTStructuredAuthSurface } from "../../scripts/chatgpt-auth-secrets";

function structuredAuth(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    access_token: "access-secret",
    refresh_token: "refresh-secret",
    id_token: "id-secret",
    ...overrides,
  });
}

function issues(env: Record<string, string | undefined>, localSecretSurfacePresent = true) {
  return validateChatGPTStructuredAuthSurface(env, {
    localSecretSurfacePresent,
    chatgptResponsesEnabled: true,
  });
}

function messages(env: Record<string, string | undefined>, localSecretSurfacePresent = true): string[] {
  return issues(env, localSecretSurfacePresent).map((issue) => issue.message);
}

describe("ChatGPT structured auth validation", () => {
  it("accepts structured CHATGPT_AUTH_JSON", () => {
    expect(messages({ CHATGPT_AUTH_JSON: structuredAuth() })).toEqual([]);
  });

  it("warns when legacy CHATGPT_OAUTH is present with structured CHATGPT_AUTH_JSON", () => {
    const result = issues({
      CHATGPT_AUTH_JSON: structuredAuth(),
      CHATGPT_OAUTH: "legacy-token-secret",
    });
    const output = result.map((issue) => issue.message).join("\n");

    expect(result).toEqual([expect.objectContaining({
      kind: "warning",
      message: expect.stringContaining("CHATGPT_OAUTH is legacy bare-token auth and is ignored"),
    })]);
    expect(output).not.toContain("legacy-token-secret");
    expect(output).not.toContain("access-secret");
    expect(output).not.toContain("refresh-secret");
    expect(output).not.toContain("id-secret");
  });

  it("warns when legacy CHATGPT_OAUTH is present with structured CHATGPT_AUTH_FILE content", () => {
    const result = issues({
      CHATGPT_AUTH_FILE: structuredAuth(),
      CHATGPT_OAUTH: "legacy-token-secret",
    });
    const output = result.map((issue) => issue.message).join("\n");

    expect(result).toEqual([expect.objectContaining({
      kind: "warning",
      message: expect.stringContaining("remove it from local secrets"),
    })]);
    expect(output).not.toContain("legacy-token-secret");
    expect(output).not.toContain("access-secret");
    expect(output).not.toContain("refresh-secret");
    expect(output).not.toContain("id-secret");
  });

  it("rejects missing local structured auth surface", () => {
    const issues = validateChatGPTStructuredAuthSurface({}, {
      localSecretSurfacePresent: false,
      chatgptResponsesEnabled: true,
    });

    expect(issues).toEqual([expect.objectContaining({
      kind: "error",
      message: expect.stringContaining("require a local structured auth secret surface"),
    })]);
  });

  it("rejects a local secret surface with no structured ChatGPT auth", () => {
    expect(messages({ NIM_KEY_1: "nim-secret" })).toEqual([
      expect.stringContaining("require structured CHATGPT_AUTH_JSON or CHATGPT_AUTH_FILE"),
    ]);
  });

  it("rejects legacy CHATGPT_OAUTH-only auth without leaking the token", () => {
    const result = issues({ CHATGPT_OAUTH: "legacy-token-secret" });
    const output = result.map((issue) => issue.message).join("\n");

    expect(result).toEqual([expect.objectContaining({
      kind: "error",
      message: expect.stringContaining("CHATGPT_OAUTH is legacy bare-token auth"),
    })]);
    expect(output).not.toContain("legacy-token-secret");
  });

  it("rejects path-like CHATGPT_AUTH_FILE values without leaking the path", () => {
    const result = messages({
      CHATGPT_AUTH_FILE: ".secrets/chatgpt-auth.json",
      CHATGPT_OAUTH: "legacy-token-secret",
    });

    expect(result.join("\n")).toContain("CHATGPT_AUTH_FILE must contain structured ChatGPT subscription auth JSON");
    expect(result.join("\n")).not.toContain(".secrets/chatgpt-auth.json");
    expect(result.join("\n")).not.toContain("legacy-token-secret");
  });

  it("rejects malformed structured auth without leaking secret values", () => {
    const result = messages({
      CHATGPT_AUTH_JSON: structuredAuth({ refresh_token: "", id_token: undefined }),
    });

    expect(result.join("\n")).toContain("missing required fields: refresh_token, id_token");
    expect(result.join("\n")).not.toContain("access-secret");
    expect(result.join("\n")).not.toContain("refresh-secret");
    expect(result.join("\n")).not.toContain("id-secret");
  });

  it("does not mask malformed structured auth with a stale OAuth warning", () => {
    const result = issues({
      CHATGPT_AUTH_JSON: structuredAuth({ refresh_token: "", id_token: undefined }),
      CHATGPT_OAUTH: "legacy-token-secret",
    });
    const output = result.map((issue) => issue.message).join("\n");

    expect(result).toEqual([expect.objectContaining({
      kind: "error",
      message: expect.stringContaining("missing required fields: refresh_token, id_token"),
    })]);
    expect(output).not.toContain("ignored while structured ChatGPT auth is present");
    expect(output).not.toContain("legacy-token-secret");
  });

  it("loads direct structured auth JSON from local .secrets files without leaking extra fields", () => {
    const cwd = mkdtempSync("/tmp/switchboard-chatgpt-auth-");
    try {
      mkdirSync(join(cwd, ".secrets"));
      writeFileSync(join(cwd, ".secrets", "chatgpt-auth.json"), JSON.stringify({
        access_token: "access-secret",
        refresh_token: "refresh-secret",
        id_token: "id-secret",
        unrelated_secret: "do-not-materialize",
      }));

      const env = loadLocalSecretEnv(cwd, {});

      expect(env.localSecretSurfacePresent).toBe(true);
      expect(env.loadErrors).toEqual([]);
      expect(env.values.CHATGPT_AUTH_JSON).toBe(structuredAuth());
      expect(env.values.unrelated_secret).toBeUndefined();
      expect(env.values.CHATGPT_AUTH_JSON).not.toContain("do-not-materialize");
      expect(messages(env.values)).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
