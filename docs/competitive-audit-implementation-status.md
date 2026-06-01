# Competitive audit — implementation status

Historical checklist from the May 2026 competitive audit. Integration work landed on `main`; use this doc only to see which planned items were completed, adapted, or rejected.

## P0 — Supersession

| ID | Status | Notes |
|----|--------|-------|
| P0-1 | Done | Editor/client aliases in manifest |
| P0-2 | Done | `oauthExcludedModels` merge (manifest + client policy); health `aliasVisibility.oauthExcluded` |
| P0-3 | Done | OAuth account pool + deployment `accountIds` |
| P0-4 | Done | OpenAI-shaped errors on denials and provider failures |
| P0-5 | Adapt | Thinking suffix via planner transforms |

## P1 — Reliability

| ID | Status | Notes |
|----|--------|-------|
| P1-1 | Done | Complexity router for `smart-route-worker` (skips tool/json/multimodal) |
| P1-2 | Done | `fallbackByProfile` on manifest route groups |
| P1-3 | Done | Typed fallback profiles in schema |
| P1-4 | Pre-existing | Hedge enabled on `main` for relevant profiles |
| P1-5 | Done | `X-Switchboard-RateLimit-Segment` (primary), `Helicone-RateLimit-Policy` (`s=`), Helicone tenant/user headers; `segmentAliases` in `CLIENT_KEYS_JSON`; segment applied only when resolved id matches a configured team |

## P2 — Operator

| ID | Status | Notes |
|----|--------|-------|
| P2-1 | Done | Receipt metadata headers wired in handler + DO |
| P2-2 | Done | Admin `/admin/usage?format=csv` with `estimated_cost_usd` |
| P2-3 | Done | Usage cost columns + `usage-pricing.ts` heuristics |
| P2-4 | Done | `pnpm sync-free-models` + `generate-free-routes`; billingClass taxonomy; CI PR workflow |
| P2-5 | Rejected | Inline KV cache (external Cache Rules) |

## P3 — Nice-to-have

| ID | Status | Notes |
|----|--------|-------|
| P3-2 | Done | `CLIENT_KEYS_JSON` teams: RPM, concurrency, **token budget**; client `teamId` |
| P3-1, P3-3, P3-4 | Rejected | Per plan |

## Post-merge audit (2026-05-25)

| Check | Result |
|-------|--------|
| PR #2 audit docs | Merged |
| PR #18 integration | Merged |
| PR #3–#17 drafts | Merged via integration history; do not cherry-pick individually |
| `extractRequestMetadata` → receipts + client requests | Wired |
| Admin JSON usage `totals.estimatedCostUsd` | Wired |
| GitHub Actions `ci.yml` | Single `pnpm verify` job (`tsc`, `validate`, `test`, `bundle-size`) |
| `oauthExcludedModels` manifest validation | Provider keys enforced at validate |
| PR #20 post-merge gaps | Merged (usage totals, client metadata, CI workflow) |
| CI strict ChatGPT validate | `config/fixtures/chatgpt-auth.ci.json` when `CI=true` |
| Operator examples | `config/client-keys.example.json`, `.dev.vars.example` |
| `cost_estimate_source: "heuristic"` on admin usage JSON | Wired |
| `segmentAliases` validate (orphan team warnings) | `pnpm validate` + `client-keys.ci.json` |
| Query event capture (`incoming` + `post_transform`) | Opt-in via env; `GET /admin/query-events` |
| Smart-route shadow log | `SMART_ROUTE_SHADOW_LOG=true` (no routing change) |

## Residual / operator-owned

- **OAuth exclusions:** `manifest.oauthExcludedModels` defaults to `{}`; copy patterns from `config/client-keys.example.json`.
- **Billing:** `estimated_cost_usd` uses heuristic pricing, not invoice-grade.
- **Production secrets:** Replace CI fixture tokens with real `CHATGPT_AUTH_JSON` / `../switchboard-local/.dev.vars` for deploy and `pnpm live:smoke`.

## Verification

```bash
pnpm verify             # tsc + validate + test + bundle-size
pnpm tsc
pnpm test
pnpm bundle-size
pnpm validate
pnpm sync-free-models   # optional; network probes
```
