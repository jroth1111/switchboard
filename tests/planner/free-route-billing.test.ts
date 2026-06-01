import { describe, it, expect } from "vitest";
import {
  inferRouteGroupBillingClass,
  selectCandidateGroups,
  type RequestEnvelope,
} from "../../src/planner/planner";
import { MANIFEST } from "../../src/config/manifest";

function envelope(overrides: Partial<RequestEnvelope> = {}): RequestEnvelope {
  return {
    requestId: "req-test",
    originalModel: "free",
    stream: false,
    hasTools: false,
    hasStrictTools: false,
    body: { model: "free", messages: [{ role: "user", content: "hi" }] },
    ...overrides,
  };
}

describe("free route billing", () => {
  it("canonicalizes freemium compat alias to free", () => {
    expect(MANIFEST.aliases.freemium).toBe("free");
  });
  it("tags free multiplex groups as free billing class", () => {
    expect(inferRouteGroupBillingClass("free", MANIFEST.routeGroups.free!)).toBe("free");
    const kilo = MANIFEST.routeGroups["free-kilo"];
    expect(kilo).toBeDefined();
    expect(inferRouteGroupBillingClass("free-kilo", kilo!)).toBe("free");
  });

  it("queues routeGroup.target before fallbacks for routing-only free parent", () => {
    const freeParent = MANIFEST.routeGroups.free;
    const kiloGroup = MANIFEST.routeGroups["free-kilo"];
    expect(freeParent).toBeDefined();
    expect(kiloGroup).toBeDefined();
    expect(freeParent!.target).toBe("free-kilo");

    const candidates = selectCandidateGroups("free", envelope());
    const groups = candidates.map((c) => c.group);
    const kiloIdx = groups.indexOf("free-kilo");
    const zenIdx = groups.indexOf("free-opencode-zen");
    expect(kiloIdx).toBeGreaterThanOrEqual(0);
    if (zenIdx >= 0) {
      expect(kiloIdx).toBeLessThan(zenIdx);
    }
  });

  it("rejects subscription groups when canonical target is free", () => {
    const candidates = selectCandidateGroups("free", envelope());
    const subscriptionGroups = candidates.filter(
      (c) => inferRouteGroupBillingClass(c.group, c.routeGroup) === "subscription",
    );
    expect(subscriptionGroups.length).toBeGreaterThan(0);
    for (const candidate of subscriptionGroups) {
      expect(candidate.rejectionReason).toBe("subscription_not_allowed_for_free_route");
    }
  });

  it("filters modelPassthrough deployments to requested provider model", () => {
    const zenGroup = MANIFEST.routeGroups["free-opencode-zen"];
    expect(zenGroup?.modelPassthrough).toBe(true);
    const deployments = MANIFEST.deploymentsByGroup["free-opencode-zen"] ?? [];
    expect(deployments.length).toBeGreaterThanOrEqual(2);

    const targetModel = deployments[0]!.providerModel;
    const candidates = selectCandidateGroups("free", envelope({
      originalModel: targetModel,
      body: { model: targetModel, messages: [{ role: "user", content: "hi" }] },
    }));
    const zenCandidate = candidates.find((c) => c.group === "free-opencode-zen");
    expect(zenCandidate?.deployments.every((d) => d.providerModel === targetModel)).toBe(true);
  });

  it("matches modelPassthrough using stripped body.model when originalModel has thinking suffix", () => {
    const zenGroup = MANIFEST.routeGroups["free-opencode-zen"];
    expect(zenGroup?.modelPassthrough).toBe(true);
    const deployments = MANIFEST.deploymentsByGroup["free-opencode-zen"] ?? [];
    expect(deployments.length).toBeGreaterThan(0);
    const targetModel = deployments[0]!.providerModel;
    const thinkingAlias = `${targetModel}-thinking-4096`;

    const candidates = selectCandidateGroups("free", envelope({
      originalModel: thinkingAlias,
      body: {
        model: targetModel,
        messages: [{ role: "user", content: "hi" }],
      },
    }));
    const zenCandidate = candidates.find((c) => c.group === "free-opencode-zen");
    expect(zenCandidate?.rejectionReason).toBeUndefined();
    expect(zenCandidate?.deployments.every((d) => d.providerModel === targetModel)).toBe(true);
  });

  it("keeps full child-group pool for generic free alias", () => {
    const kilo = MANIFEST.deploymentsByGroup["free-kilo"] ?? [];
    expect(kilo.length).toBeGreaterThanOrEqual(2);
    const candidates = selectCandidateGroups("free", envelope({ originalModel: "free" }));
    const kiloCandidate = candidates.find((c) => c.group === "free-kilo");
    expect(kiloCandidate).toBeDefined();
    expect(kiloCandidate!.deployments.length).toBe(kilo.length);
  });

  it("never marks subscription-shaped groups viable for free canonical target", () => {
    const candidates = selectCandidateGroups("free", envelope());
    for (const c of candidates) {
      if (inferRouteGroupBillingClass(c.group, c.routeGroup) === "subscription") {
        expect(c.rejectionReason).toBe("subscription_not_allowed_for_free_route");
      }
    }
  });
});
