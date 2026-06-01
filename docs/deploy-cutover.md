# Deploy cutover checklist

Operator checklist for deploying the **llm-control-plane** Cloudflare Worker (this repo). Routes live under `/nim/*`; client policy and team limits come from `CLIENT_KEYS_JSON`.

## Pre-deploy verification

Run locally before every cutover:

```bash
pnpm verify   # tsc + validate + test + bundle-size
```

Fix any validate **errors** before deploy. Warnings (for example missing model-specific usage pricing) are informational but should be reviewed.

## Worker identity

| Item | Value |
|------|-------|
| Wrangler `name` | `llm-control-plane` |
| Config | `wrangler.jsonc` (production), `wrangler.dev.jsonc` (staging) |
| Deploy | `pnpm deploy` or `pnpm deploy:staging` |

## Required secrets

Set via `wrangler secret put` (production) or `../switchboard-local/.dev.vars` (local; see repo README). Do not commit values.

| Secret | Purpose |
|--------|---------|
| `CLIENT_KEYS_JSON` | Per-client auth (`token_sha256`), allowed models, RPM/concurrency/token budgets, optional `teamId` and `oauthExcludedModels`. See `config/client-keys.example.json`. |
| `ADMIN_API_KEY` | Bearer auth for `/admin/*` routes and live smoke admin probes. |
| `NIM_HEALTH_TOKEN` | Bearer auth for `/nim/health` and `/nim/failures` when `ADMIN_API_KEY` is not used. |
| `METADATA_SIGNING_KEY` | Signs receipt metadata headers returned to clients. |
| Provider keys | `NIM_KEY_*`, `ZAI_KEY_*`, `OPENROUTER_API_KEY_1` (+ `_2`, …), `GROQ_API_KEY_1`, `KILO_API_KEY_1`, `OPENCODE_API_KEY_1`, `CHATGPT_AUTH_JSON`, Anthropic OAuth material, `ENCRYPTION_KEY` as required by manifest deployments. Run `pnpm migrate:api-keys` on `.dev.vars` after upgrading from singular `OPENROUTER_API_KEY`-style names. |

## URL configuration

| Variable | Purpose |
|----------|---------|
| `LIVE_BASE_URL` or `CONTROL_PLANE_URL` | Deployed Worker base URL for `pnpm live:smoke`, `pnpm failures`, and operator scripts. |
| `SWITCHBOARD_API_KEY` or `PROXY_API_KEY` | Client proxy auth for smoke tests and editor integrations. |

After deploy, confirm the public URL matches what clients and smoke scripts use.

## Health and failure telemetry

| Route | Auth | Notes |
|-------|------|-------|
| `GET /nim/health` | `Authorization: Bearer <NIM_HEALTH_TOKEN>` or `ADMIN_API_KEY` | NIM mitigation health snapshot. |
| `GET /nim/failures` | Same | Recent failure receipts; filter by route, group, model, failure class. |
| `GET /nim/failures/{receipt_id}` | Same | Single receipt; optional `include_receipt=true`. |

CLI helper: `pnpm failures -- recent` (requires `CONTROL_PLANE_URL` and health token).

## Scheduled crons

Both `wrangler.jsonc` and `wrangler.dev.jsonc` must declare:

```
*/2 * * * *
*/5 * * * *
0 * * * *
```

`pnpm validate` fails if any required cron is missing. On Cloudflare **Free** plan, cron frequency is limited (typically one cron per Worker); upgrade or consolidate schedules if deploy rejects trigger configuration.

## Client policy and rate-limit segments

- `CLIENT_KEYS_JSON` defines **teams** (`teams.<id>`) with optional `rpmLimit`, `maxConcurrency`, and `tokenBudgetPerMinute`.
- Each **client** may set `teamId` to inherit team limits.
- Incoming `X-Switchboard-RateLimit-Segment`, `Helicone-RateLimit-Policy` (`s=tenant|user|…`), or Helicone tenant/user headers are resolved via optional root-level **`segmentAliases`** (external id → team id).
- The resolved segment is applied **only when it matches a team id** in `CLIENT_KEYS_JSON` `teams{}`. Mismatched segments are ignored.

Verify team ids and `segmentAliases` in production JSON match the segment headers your callers send.

## Optional observability

| Env | Purpose |
|-----|---------|
| `SWITCHBOARD_QUERY_CAPTURE_ENABLED=true` or `SWITCHBOARD_QUERY_CAPTURE_TIER=shape\|redacted\|raw` | Store sanitized query shape events in the DO |
| `SWITCHBOARD_QUERY_CAPTURE_MAX_EVENTS` | Per-request retention cap (default 50) |
| `SMART_ROUTE_SHADOW_LOG=true` | Log `smart_route_shadow` tier/model without changing routing |

Admin: `GET /admin/query-events` (requires `ADMIN_API_KEY`). Captures `incoming` (pre-transform) and `post_transform` stages when enabled.

Weekly catalog refresh: GitHub Actions workflow `sync-free-models.yml` runs `pnpm sync-free-models`, `pnpm snapshot`, and opens a PR when `config/sync-free-models-suggestions.json`, `src/config/free-routes.generated.ts`, or `config/route-manifest.snapshot.json` drift. Configure repo secrets `OPENROUTER_API_KEY_1`, `GROQ_API_KEY_1`, `KILO_API_KEY_1`, `OPENCODE_API_KEY_1`, and `NIM_KEY_1` (add `_2`, … for rotation).

## Post-deploy smoke

```bash
CONTROL_PLANE_URL=https://<your-worker>.workers.dev \
ADMIN_API_KEY=... \
NIM_HEALTH_TOKEN=... \
SWITCHBOARD_API_KEY=... \
pnpm live:smoke
```

Check `/admin/usage` JSON includes `cost_estimate_source: "heuristic"` and `totals.estimatedCostUsd` (heuristic, not invoice-grade).

## Rollback

Redeploy the previous Worker version from Cloudflare dashboard or revert the git tag and run `pnpm deploy` again. Durable Object state persists across rollbacks; no separate migration step unless schema tags changed.
