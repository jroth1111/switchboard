// Build-time manifest validation: catches misconfigurations before deploy.
// Run in tests (vitest) or build scripts to fail CI on invalid manifests.

import type { RouteManifest } from "./schema";

export interface ValidationIssue {
  kind: "error" | "warning";
  code: string;
  message: string;
  detail?: string;
}

/** Route groups that forward to other groups and intentionally own no deployments. */
export const ROUTING_ONLY_ROUTE_GROUPS = new Set(["nim-secondary"]);

export function validateManifest(m: RouteManifest): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  validateAliases(m, issues);
  validateFallbackGraph(m, issues);
  validateDeployments(m, issues);
  validatePlannerRefs(m, issues);
  validatePolicies(m, issues);

  return issues;
}

// ─── Alias resolution ──────────────────────────────────────────────

function validateAliases(m: RouteManifest, issues: ValidationIssue[]): void {
  const groupNames = new Set(Object.keys(m.routeGroups));

  for (const [alias, target] of Object.entries(m.aliases)) {
    if (!groupNames.has(target)) {
      issues.push({
        kind: "error",
        code: "alias_target_missing",
        message: `Alias "${alias}" resolves to "${target}" which is not a route group`,
      });
    }

    // Self-referencing alias is fine (e.g. "nim-primary" → "nim-primary")
    // but a chain through another alias is not allowed — aliases must point
    // directly to groups, not to other aliases.
    if (m.aliases[target] !== undefined && m.aliases[target] !== target) {
      issues.push({
        kind: "warning",
        code: "alias_chain",
        message: `Alias "${alias}" points to "${target}" which is itself an alias (not a group)`,
        detail: `Resolved chain: ${alias} → ${target} → ${m.aliases[target]}`,
      });
    }
  }

  // Check allowedAmbiguousAliases references are valid aliases
  for (const pair of m.allowedAmbiguousAliases ?? []) {
    for (const name of pair) {
      if (!(name in m.aliases)) {
        issues.push({
          kind: "warning",
          code: "ambiguous_alias_missing",
          message: `allowedAmbiguousAliases references "${name}" which is not an alias`,
        });
      }
    }
  }
}

// ─── Acyclic fallback graph ────────────────────────────────────────

function validateFallbackGraph(m: RouteManifest, issues: ValidationIssue[]): void {
  const groups = Object.keys(m.routeGroups);
  const reportedCycles = new Set<string>();

  for (const group of groups) {
    const visited = new Set<string>();
    detectCycle(m, group, group, visited, [], issues, reportedCycles);
  }

  // Check that all fallback group references exist
  for (const [group, rg] of Object.entries(m.routeGroups)) {
    for (const fb of rg.fallbacks) {
      if (!(fb in m.routeGroups)) {
        issues.push({
          kind: "error",
          code: "fallback_group_missing",
          message: `Route group "${group}" references fallback "${fb}" which does not exist`,
        });
      }
    }
  }
}

function detectCycle(
  m: RouteManifest,
  start: string,
  current: string,
  visited: Set<string>,
  path: string[],
  issues: ValidationIssue[],
  reportedCycles: Set<string>,
): void {
  if (visited.has(current)) {
    if (current === start) {
      const cyclePath = [...path, current].join(" → ");
      // Deduplicate: normalize the cycle to a canonical key so A→B→C→A and
      // B→C→A→B are recognized as the same cycle.
      const cycleNodes = [...path, current];
      const cycleKey = cycleNodes.slice(0, -1).sort().join(",");
      if (!reportedCycles.has(cycleKey)) {
        reportedCycles.add(cycleKey);
        issues.push({
          kind: "error",
          code: "fallback_cycle",
          message: `Circular fallback chain detected starting at "${start}"`,
          detail: cyclePath,
        });
      }
    }
    return;
  }

  visited.add(current);
  path.push(current);

  const rg = m.routeGroups[current];
  if (rg) {
    for (const fb of rg.fallbacks) {
      detectCycle(m, start, fb, visited, path, issues, reportedCycles);
    }
  }

  path.pop();
  visited.delete(current);
}

// ─── Deployment consistency ────────────────────────────────────────

function validateDeployments(m: RouteManifest, issues: ValidationIssue[]): void {
  const deploymentIds = new Set<string>();
  const groupsWithDeployments = new Set<string>();

  for (const d of m.deployments) {
    // Duplicate IDs
    if (deploymentIds.has(d.id)) {
      issues.push({
        kind: "error",
        code: "duplicate_deployment_id",
        message: `Duplicate deployment ID "${d.id}"`,
      });
    }
    deploymentIds.add(d.id);

    // Group must exist in routeGroups
    if (!(d.group in m.routeGroups)) {
      issues.push({
        kind: "error",
        code: "deployment_group_missing",
        message: `Deployment "${d.id}" references group "${d.group}" which is not a route group`,
      });
    }

    groupsWithDeployments.add(d.group);
  }

  // Groups with fallbacks (or that are fallback targets) should have deployments
  const fallbackTargets = new Set<string>();
  for (const rg of Object.values(m.routeGroups)) {
    for (const fb of rg.fallbacks) {
      fallbackTargets.add(fb);
    }
  }

  for (const group of Object.keys(m.routeGroups)) {
    const rg = m.routeGroups[group];
    if (ROUTING_ONLY_ROUTE_GROUPS.has(group)) continue;
    // Only warn about groups that are reachable (non-hidden, or a fallback target)
    if (!groupsWithDeployments.has(group) && (!rg.hidden || fallbackTargets.has(group))) {
      issues.push({
        kind: "warning",
        code: "group_has_no_deployments",
        message: `Route group "${group}" has no deployments`,
        detail: rg.hidden
          ? "Hidden group is a fallback target but has no deployments"
          : undefined,
      });
    }
  }
}

// ─── Planner references ──────────────────────────────────────────────

function validatePlannerRefs(m: RouteManifest, issues: ValidationIssue[]): void {
  for (const [group, rg] of Object.entries(m.routeGroups)) {
    const planner = rg.planner;
    if (!planner) continue;

    for (const field of ["toolGroup", "strictToolGroup"] as const) {
      const ref = planner[field];
      if (!ref) continue;
      if (!(ref in m.routeGroups)) {
        issues.push({
          kind: "error",
          code: "planner_group_missing",
          message: `Route group "${group}" planner.${field} references "${ref}" which is not a route group`,
        });
      }
    }
  }
}

// ─── Policy existence ──────────────────────────────────────────────

function validatePolicies(m: RouteManifest, issues: ValidationIssue[]): void {
  for (const group of Object.keys(m.routeGroups)) {
    if (!(group in m.policies)) {
      issues.push({
        kind: "warning",
        code: "missing_policy",
        message: `Route group "${group}" has no policy (will use default)`,
      });
    }
  }

  for (const group of Object.keys(m.policies)) {
    if (!(group in m.routeGroups)) {
      issues.push({
        kind: "error",
        code: "orphan_policy",
        message: `Policy "${group}" has no matching route group`,
      });
    }
  }

  // Validate default policy exists
  if (!m.defaultPolicy) {
    issues.push({
      kind: "error",
      code: "no_default_policy",
      message: "Manifest has no defaultPolicy",
    });
  }
}
