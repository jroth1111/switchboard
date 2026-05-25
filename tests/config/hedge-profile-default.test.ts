import { describe, it, expect } from "vitest";
import { MANIFEST } from "../../src/config/manifest";

describe("nim-openai-chat hedge profile", () => {
  it("enables hedging on nim-primary policy", () => {
    const hedge = MANIFEST.policies["nim-primary"]?.retry.hedge;
    expect(hedge?.enabled).toBe(true);
    expect(hedge?.maxCandidates).toBeGreaterThanOrEqual(2);
    expect(hedge?.onlyWhenSuspect).toBe(true);
  });

  it("keeps global default hedge disabled", () => {
    expect(MANIFEST.defaultPolicy.retry.hedge?.enabled).toBe(false);
  });
});
