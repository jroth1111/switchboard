import { describe, it, expect } from "vitest";
import {
  parseOAuthAccountList,
  rotateOAuthAccountCandidates,
  anthropicOAuthAccountCandidates,
} from "../../src/providers/oauth-account-pool";

describe("oauth-account-pool", () => {
  it("parses JSON account list", () => {
    expect(parseOAuthAccountList('["a","b"]')).toEqual(["a", "b"]);
  });

  it("parses comma-separated accounts", () => {
    expect(parseOAuthAccountList("acc1, acc2")).toEqual(["acc1", "acc2"]);
  });

  it("rotates candidates by requestId without dropping accounts", () => {
    const rotated = rotateOAuthAccountCandidates(["x", "y", "z"], "req_rotate_test");
    expect(rotated).toHaveLength(3);
    expect(new Set(rotated)).toEqual(new Set(["x", "y", "z"]));
    const again = rotateOAuthAccountCandidates(["x", "y", "z"], "req_rotate_test");
    expect(again).toEqual(rotated);
  });

  it("includes extra accounts in anthropic candidate list", () => {
    const ids = anthropicOAuthAccountCandidates("primary", "dep-1", ["extra-1", "extra-2"], "req_1");
    expect(ids).toContain("primary");
    expect(ids).toContain("extra-1");
    expect(ids).toContain("anthropic:dep-1");
  });
});
