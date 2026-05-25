import { describe, it, expect } from "vitest";
import { parseTeamLimits, resolveClientAdmissionLimits } from "../../src/http/team-limits";

describe("team limits", () => {
  it("parses teams from CLIENT_KEYS_JSON", () => {
    const teams = parseTeamLimits(JSON.stringify({
      teams: { eng: { rpmLimit: 100, maxConcurrency: 5 } },
      clients: [],
    }));
    expect(teams.get("eng")).toEqual({ rpmLimit: 100, maxConcurrency: 5 });
  });

  it("resolves team limits for client policy", () => {
    const teams = parseTeamLimits(JSON.stringify({
      teams: { eng: { rpmLimit: 50 } },
      clients: [],
    }));
    const limits = resolveClientAdmissionLimits({ teamId: "eng", rpmLimit: 10 }, teams);
    expect(limits.teamRpmLimit).toBe(50);
    expect(limits.rpmLimit).toBe(10);
  });
});
