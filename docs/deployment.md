# Deployment guide

Checklist for deploying the **llm-control-plane** Cloudflare Worker. Operator routes live under `/nim/*`; client authentication and team limits come from `CLIENT_KEYS_JSON`.

## Pre-deploy verification

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

Set via `wrangler secret put` (production) or `../switchboard-local/.dev.vars` (local). See [local-secrets.md](local-secrets.md). Do not commit values.

| Secret | Purpose |
|--------|---------|
| `CLIENT_KEYS_JSON` | Per-client auth (`token_sha256`), allowed models, RPM/concurrency/token budgets, optional `teamId` and `oauthExcludedModels`. See `config/client-keys.example.json`. |
| `ADMIN_API_KEY` | Bearer auth for `/admin/*` routes and live smoke admin probes. |
| `NIM_HEALTH_TOKEN` | Bearer auth for `/nim/health` and `/nim/failures` when `ADMIN_API_KEY` is not used. |
| `METADATA_SIGNING_KEY` | Signs receipt metadata headers returned to clients. |
| Provider keys | `NIM_KEY_*`, `ZAI_KEY_*`, `OPENROUTER_API_KEY_1` (+ `_2`, …), `GROQ_API_KEY_1`, `KILO_API_KEY_1`, `OPENCODE_API_KEY_1`, `CHATGPT_AUTH_JSON`, Anthropic OAuth material, `ENCRYPTION_KEY` as required by manifest deployments. Run `pnpm migrate:api-keys` after upgrading from singular `OPENROUTER_API_KEY`-style names. |

## URL configuration

| Variable | Purpose |
|----------|---------|
| `LIVE_BASE_URL` or `CONTROL_PLANE_URL` | Deployed Worker base URL for `pnpm live:smoke`, `pnpm failures`, and operator scripts. |
| `SWITCHBOARD_API_KEY` or `PROXY_API_KEY` | Client proxy auth for smoke tests and editor integrations. |

After deploy, confirm the public URL matches what clients and smoke scripts use.

## Health and failure telemetry

| Route | Auth | Notes |
|-------|------|-------|
| `GET /nim/health` | `Authorization: Bearer <NIM_HEALTH_TOKEN>` or `ADMIN_API_KEY` | Health snapshot |
| `GET /nim/failures` | Same | Recent failure receipts |
| `GET /nim/failures/{receipt_id}` | Same | Single receipt; optional `include_receipt=true` |

CLI: `pnpm failures -- recent` (requires `CONTROL_PLANE_URL` and health token).

## Scheduled crons

Both `wrangler.jsonc` and `wrangler.dev.jsonc` must declare:

```
*/2 * * * *
*/5 * * * *
0 * * * *
```

`pnpm validate` fails if any required cron is missing. On Cloudflare **Free** plan, cron frequency is limited; upgrade or consolidate schedules if deploy rejects trigger configuration.

## Client policy and rate-limit segments

- `CLIENT_KEYS_JSON` defines **teams** with optional `rpmLimit`, `maxConcurrency`, and `tokenBudgetPerMinute`.
- Each **client** may set `teamId` to inherit team limits.
- Headers `X-Switchboard-RateLimit-Segment`, `Helicone-RateLimit-Policy`, or Helicone tenant/user headers resolve through optional **`segmentAliases`** (external id → team id).
- Segments apply only when they match a team id in `CLIENT_KEYS_JSON`.

## Optional observability

| Env | Purpose |
|-----|---------|
| `SWITCHBOARD_QUERY_CAPTURE_ENABLED=true` or `SWITCHBOARD_QUERY_CAPTURE_TIER=shape\|redacted\|raw` | Query shape events in the DO |
| `SWITCHBOARD_QUERY_CAPTURE_MAX_EVENTS` | Per-request retention cap (default 50) |
| `SMART_ROUTE_SHADOW_LOG=true` | Log smart-route tier without changing routing |

Admin: `GET /admin/query-events` (requires `ADMIN_API_KEY`).

Weekly catalog refresh: workflow `.github/workflows/sync-free-models.yml` runs `pnpm sync-free-models`, `pnpm snapshot`, and opens a PR when generated artifacts drift. Configure repo secrets `OPENROUTER_API_KEY_1`, `GROQ_API_KEY_1`, `KILO_API_KEY_1`, `OPENCODE_API_KEY_1`, and `NIM_KEY_1`.

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

Redeploy the previous Worker version from the Cloudflare dashboard, or revert the git tag and run `pnpm deploy` again. Durable Object state persists across rollbacks unless DO schema migrations changed.
