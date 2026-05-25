# LiteLLM diff vs switchboard (2026-05-25)

## Context

Switchboard ports an internal **`litellm_logic`** tree (not present in upstream `BerriAI/litellm`). Comments in switchboard map modules to that tree.

## Switchboard modules with litellm_logic lineage

| Switchboard path | Claimed source |
|------------------|----------------|
| `src/planner/planner.ts` | `routing/planner.py`, `candidates.py`, `preflight.py` |
| `src/attempts/attempt-loop.ts` | `routing/attempts.py` |
| `src/nim/classify/*.ts` | `nim/classify/*.py` |
| `src/nim/repair/*.ts` | `nim/repair/*.py` |
| `src/nim/evaluate/response.ts` | `nim/evaluate/response.py` |
| `src/observability/receipt.ts` | `obs/route_receipts.py` |
| `src/observability/failed-request-finalizer.ts` | `obs/failed_request_finalizer.py` |
| `src/probes/health-endpoint.ts` | `obs/health_endpoint.py` |
| `src/providers/anthropic-subscription.ts` | `adapters/litellm/anthropic_subscription.py` |

## Upstream LiteLLM proxy features (BerriAI/litellm) — gap scan

Searched `litellm/proxy/` in cloned repo. Notable upstream capabilities **outside** switchboard’s current surface:

| Upstream feature | Evidence | Switchboard status | Borrow tag |
|------------------|----------|-------------------|------------|
| Fallback types `general`, `context_window`, `content_policy` | `get_all_fallbacks`, `valid_fallback_types` in `proxy/utils.py` | Manifest fallbacks are deployment-level, not typed by failure class | **Adapt** — map failure classes to fallback profiles in manifest |
| MCP semantic tool filtering | `proxy_setting_endpoints.py` MCP semantic filter | No MCP | **Reject** hosted (bundle + scope) |
| Postgres/Prisma admin UI, teams, budgets | `litellm/proxy/ui_*`, DB layer | DO SQLite + admin JSON only | **Adapt** — export-only; no Postgres in Worker |
| Router config hot-reload via DB | proxy management API | Static manifest + validate at load | **Adapt** — optional KV/manifest version bump, not full DB |
| Email alerting / guardrail integrations | `proxy/utils.py` SendGrid/Resend | None | **Reject** inline; webhook from cron OK |
| Content-policy fallbacks | fallback_type enum | Partial via NIM classify | **Port** small policy bit on planner |

## NIM / response quality

Switchboard already ships 11 NIM modules under `src/nim/`. Upstream LiteLLM proxy does **not** expose a parallel `nim/` package in this clone — NIM logic appears proprietary to `litellm_logic`.

**Conclusion:** Do not re-port LiteLLM Python NIM. Maintain switchboard as source of truth; diff upstream only for **routing/fallback taxonomy** and **admin metadata** patterns.

## Recommended litellm-sourced borrows (CF-safe)

1. **P1:** Typed fallback profiles (`context_window`, `content_policy`) wired from existing `FailureClass` in schema.
2. **P2:** Admin export shape compatible with LiteLLM proxy logs (JSONL fields: model, deployment, latency, cost) without Postgres.
3. **P3:** `tomaasz/litellm-free-models-proxy` model discovery as **offline** `scripts/sync-free-models.ts` updating manifest snapshots — never runtime discovery on Worker.
