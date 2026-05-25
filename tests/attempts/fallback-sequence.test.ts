import { describe, it, expect } from "vitest";
import { promoteProfileFallbacks } from "../../src/attempts/fallback-sequence";
import { MANIFEST } from "../../src/config/manifest";

describe("promoteProfileFallbacks", () => {
  it("moves profile-matched fallback group earlier in remaining sequence", () => {
    const policy = MANIFEST.defaultPolicy;
    const seq = [
      { group: "smart-route-worker", policy, deployments: [] },
      { group: "nim-deepseek-v4-pro", policy, deployments: [] },
      { group: "nim-primary", policy, deployments: [] },
    ];
    const out = promoteProfileFallbacks(seq, 1, "context_length_exceeded", "smart-route-worker");
    expect(out[1].group).toBe("nim-primary");
  });
});
