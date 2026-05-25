# Competitive audit — implementation status

Integration PR [#18](https://github.com/jroth1111/switchboard/pull/18) on branch `cursor/close-audit-gaps-cb1e` supersedes draft PRs #3–#17. Tracking table: [competitive-audit-pr-tracking.md](competitive-audit-pr-tracking.md).

Plan source: `docs/competitive-audit-2026-05-25.md` on branch `cursor/competitive-audit-cb1e` (PR #2).

## P0 — Supersession

| ID | Status | Notes |
|----|--------|-------|
| P0-1 | Done | VibeProxy-style aliases in manifest |
| P0-2 | Done | `oauthExcludedModels` merge (manifest + client policy); health `aliasVisibility.oauthExcluded` |
| P0-3 | Done | OAuth account pool + deployment `accountIds` |
| P0-4 | Done | OpenAI-shaped errors on denials and provider failures |
| P0-5 | Adapt | Thinking suffix via planner transforms (not full VibeProxy table) |

## P1 — Reliability

| ID | Status | Notes |
|----|--------|-------|
| P1-1 | Done | Complexity router for `smart-route-worker` (skips tool/json/multimodal) |
| P1-2 | Done | `fallbackByProfile` on manifest route groups |
| P1-3 | Done | Typed fallback profiles in schema |
| P1-4 | Pre-existing | Hedge enabled on `main` for relevant profiles |
| P1-5 | Done | `Helicone-RateLimit-Policy` segment parsing |

## P2 — Operator

| ID | Status | Notes |
|----|--------|-------|
| P2-1 | Done | Receipt metadata headers wired in handler + DO |
| P2-2 | Done | Admin `/admin/usage?format=csv` with `estimated_cost_usd` |
| P2-3 | Done | Usage cost columns + `usage-pricing.ts` heuristics |
| P2-4 | Done | `pnpm sync-free-models`; validate checks endpoint registry |
| P2-5 | Rejected | Inline KV cache (external Cache Rules) |

## P3 — Nice-to-have

| ID | Status | Notes |
|----|--------|-------|
| P3-2 | Done | `CLIENT_KEYS_JSON` teams: RPM, concurrency, **token budget**; client `teamId` |
| P3-1, P3-3, P3-4 | Rejected | Per plan |

## Residual / operator-owned

- **OAuth exclusions:** `manifest.oauthExcludedModels` defaults to `{}`; operators set provider → model list (VibeProxy-style).
- **Billing:** `estimated_cost_usd` uses heuristic pricing, not invoice-grade.
- **Live smoke:** Subscription routes need secrets in operator CI (`CHATGPT_AUTH_JSON`, etc.).
- **Draft PRs:** Close #3–#17 after merging #18.

## Verification

```bash
pnpm test
pnpm bundle-size
pnpm validate
pnpm sync-free-models   # optional; network probes
```
