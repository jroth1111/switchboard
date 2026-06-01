import { describe, it, expect } from "vitest";
import {
  parseTeamLimits,
  parseSegmentAliases,
  resolveClientAdmissionLimits,
  resolveRateLimitTeamSegment,
  validateSegmentAliases,
} from "../../src/http/team-limits";

describe("team limits", () => {
  it("parses teams from CLIENT_KEYS_JSON", () => {
    const teams = parseTeamLimits(JSON.stringify({
      teams: { eng: { rpmLimit: 100, maxConcurrency: 5, tokenBudgetPerMinute: 50000 } },
      clients: [],
    }));
    expect(teams.get("eng")).toEqual({ rpmLimit: 100, maxConcurrency: 5, tokenBudgetPerMinute: 50000 });
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

  it("resolves team token budget for client policy", () => {
    const teams = parseTeamLimits(JSON.stringify({
      teams: { eng: { tokenBudgetPerMinute: 1200 } },
      clients: [],
    }));
    const limits = resolveClientAdmissionLimits({ teamId: "eng" }, teams);
    expect(limits.teamTokenBudgetPerMinute).toBe(1200);
  });

  it("parses segment aliases from CLIENT_KEYS_JSON", () => {
    const aliases = parseSegmentAliases(JSON.stringify({
      segmentAliases: { "acme-corp": "engineering", "": "ignored", "orphan": "" },
      teams: {},
      clients: [],
    }));
    expect(aliases.get("acme-corp")).toBe("engineering");
    expect(aliases.size).toBe(1);
  });

  it("resolveRateLimitTeamSegment accepts direct team ids", () => {
    const teams = parseTeamLimits(JSON.stringify({
      teams: { engineering: { rpmLimit: 100 } },
      clients: [],
    }));
    expect(resolveRateLimitTeamSegment("engineering", teams, new Map())).toBe("engineering");
  });

  it("resolveRateLimitTeamSegment maps alias to configured team id", () => {
    const teams = parseTeamLimits(JSON.stringify({
      teams: { engineering: { rpmLimit: 100 } },
      clients: [],
    }));
    const aliases = parseSegmentAliases(JSON.stringify({
      segmentAliases: { "acme-corp": "engineering" },
    }));
    expect(resolveRateLimitTeamSegment("acme-corp", teams, aliases)).toBe("engineering");
  });

  it("validateSegmentAliases warns on orphan team targets", () => {
    const teams = parseTeamLimits(JSON.stringify({
      teams: { engineering: { rpmLimit: 100 } },
      clients: [],
    }));
    const issues = validateSegmentAliases(JSON.stringify({
      segmentAliases: { "acme-corp": "missing-team" },
    }), teams);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.code).toBe("client_keys_segment_alias_orphan");
  });

  it("resolveRateLimitTeamSegment rejects unknown segments", () => {
    const teams = parseTeamLimits(JSON.stringify({
      teams: { engineering: { rpmLimit: 100 } },
      clients: [],
    }));
    expect(resolveRateLimitTeamSegment("unknown-tenant", teams, new Map())).toBeUndefined();
    expect(resolveRateLimitTeamSegment("unknown-tenant", teams, parseSegmentAliases(JSON.stringify({
      segmentAliases: { "unknown-tenant": "missing-team" },
    })))).toBeUndefined();
  });
});
