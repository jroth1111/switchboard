# Competitive audit: switchboard supersession (2026-05-25)

Audit artifacts live under `/tmp/switchboard-peer-audit/` (clones, per-repo reports, feature matrix). This document is the CF-filtered borrow backlog for **hosted** switchboard only.

## Executive summary

| Verdict | Peers |
|---------|-------|
| **Switchboard already wins** (hosted scope) | `glidea/claude-worker-proxy`, `wandercarrot/Nvidia-nim-proxy`, `notedit/openai-proxy-workers`, `August25thDD/gemini-openai-proxy-worker`, `lazymac2x/*` workers, `axandce/envoy-llm-control-plane` (different runtime) |
| **Parity / trade-offs** | `Portkey-AI/gateway` (guardrails + 1600 models; heavier), `BerriAI/litellm` (admin/DB; we port `litellm_logic` instead), `Helicone/helicone` (full observability platform) |
| **Gaps to close for supersession** | `automazeio/vibeproxy`, `rvbiljouw/vibeconduit`, `musistudio/claude-code-router` (client ergonomics), `0xrdan/claude-router` (complexity routing for smart-route), `tomaasz/litellm-free-models-proxy` (manifest discovery) |

**Bundle headroom (2026-05-25):** raw **300 KiB** / gzip **75.9 KiB** vs limits 512 / 128 KiB — ~212 KiB raw budget for P0–P1 borrows if kept modular.

---

## Switchboard baseline

See `/tmp/switchboard-peer-audit/baseline/switchboard-baseline.json`.

**HTTP surface:** `/v1/chat/completions`, `/v1/responses`, `/v1/models`, `/admin/*`, `/nim/*`, `/ping`.

**Strengths:** manifest routing, DO admission/health, NIM stack, subscription providers, canary, receipts, client policy, encrypted OAuth DO.

**Known partials:** hedging default-off globally (enabled in some profiles), cost attribution partial vs Helicone/llmscope.

**Out of scope:** local daemons, Ollama-Pro, GPU/LaunchAgent ([docs/vibeproxy-supersession-scope.md](vibeproxy-supersession-scope.md)).

---

## Clone and recon status

- **18/18** repos cloned — log: `/tmp/switchboard-peer-audit/manifests/clone.log`
- Per-repo JSON/MD: `/tmp/switchboard-peer-audit/reports/`
- Feature matrix: `/tmp/switchboard-peer-audit/matrix/feature-matrix.csv`
- LiteLLM diff: `/tmp/switchboard-peer-audit/reports/litellm-diff.md`

---

## Per-peer supersession verdict

| Peer | Runtime | Stars | Hosted verdict | Notes |
|------|---------|------:|----------------|-------|
| `automazeio/vibeproxy` | macOS Swift + local proxy | 2819 | **Gap** | Model alias map, OAuth exclusions, provider catalog — clients expect these ergonomics |
| `rvbiljouw/vibeconduit` | Linux Go daemon | 11 | **Gap (API parity)** | Multi-account round-robin; hosted switchboard has OAuth DO but not VibeConduit’s multi-file account UX |
| `glidea/claude-worker-proxy` | CF Worker | 268 | **Win** | Format bridge only; switchboard is strict superset for managed routes |
| `musistudio/claude-code-router` | Node local router | 34358 | **Gap (ergonomics)** | Provider registry UI/API, custom router scripts — not needed on Worker but clients use CCR config |
| `0xrdan/claude-router` | Claude Code plugin | 39 | **Gap (smart-route)** | Rule-based Haiku/Sonnet/Opus tiering by coding-task complexity |
| `BerriAI/litellm` | Python proxy + DB | 48135 | **Parity / win on NIM** | Upstream lacks public `litellm_logic`; switchboard already ports that stack |
| `Portkey-AI/gateway` | CF Worker gateway | 11844 | **Parity** | `fallback` / `loadbalance` / `scientist` modes; inline guardrails — switchboard wins on admission + NIM |
| `Helicone/helicone` | Worker + platform | 5722 | **Parity** | Cache headers, rate-limit policies, trace IDs — adapt into receipts/logs |
| `tomaasz/litellm-free-models-proxy` | Docker LiteLLM | 25 | **Gap (ops)** | 8h model sync script for free/NIM endpoints → offline manifest generator |
| `Sufmax/ai-gateway` | CF Worker + D1 | 0 | **Parity** | D1 provider config; switchboard uses manifest + DO usage rollup |
| `lazymac2x/llm-router-worker` | CF Worker | 0 | **Win** | MCP + REST; switchboard does not target MCP hosted |
| `lazymac2x/ai-gateway-worker` | CF Worker | 0 | **Win** | Thin gateway |
| `joshtwilliams4-web/ai-gateway-worker` | CF Worker | 0 | **Gap** | Team API keys + per-team limits in Worker |
| `August25thDD/gemini-openai-proxy-worker` | CF Worker | 0 | **Win** | Regional bridge; switchboard has ChatGPT/Anthropic/NIM routes |
| `notedit/openai-proxy-workers` | CF Workers | 0 | **Win** | Minimal pass-through |
| `wandercarrot/Nvidia-nim-proxy` | Small proxy | 0 | **Win** | OpenAI-compat NIM only; no NIM repair |
| `lucianareynaud/llmscope` | Python package | 1 | **Gap (ops)** | Cost attribution reports / OTel choke-point patterns |
| `axandce/envoy-llm-control-plane` | Envoy ext_authz | 0 | **n/a hosted** | Policy at edge; **Adapt** webhook validation ideas only |

---

## Feature matrix (summary)

Full CSV: `/tmp/switchboard-peer-audit/matrix/feature-matrix.csv`

| Capability | SB | Best peer coverage | SB vs peers |
|------------|----|--------------------|-------------|
| Chat + stream | yes | litellm, portkey, helicone | Leading |
| `/v1/responses` | yes | litellm, portkey | Leading for ChatGPT subscription |
| Anthropic + OAuth | yes | vibeproxy, CCR, litellm | Leading (OAuth DO) |
| Smart / alias routing | yes | CCR, claude-router | **Closed (#18):** complexity tier rules for `smart-route-worker` |
| Fallback chains | yes | portkey, litellm | **Closed (#18):** typed + profile-aware fallbacks |
| Hedging | yes | litellm, helicone | **Closed:** enabled on `nim-openai-chat` profile |
| Rate limits + admission | yes | portkey, helicone | Leading (DO) |
| Circuit + cooldown | yes | litellm | Leading |
| NIM repair | yes | litellm (logic external) | **Win** |
| Canary / admin | yes | litellm, helicone | Leading |
| Guardrails | no | portkey, helicone | **Gap** (adapt external) |
| MCP | no | CCR, lazymac2x | Out of hosted scope unless requested |
| Multi-tenant teams | yes | litellm, portkey, helicone | **Closed (#18):** `CLIENT_KEYS_JSON` teams (RPM, concurrency, token budget) |
| Local-only | n/a | vibeproxy, vibeconduit | Correctly excluded |

---

## Borrow backlog (CF-filtered)

Each item: **Port** = TS in Worker/DO | **Adapt** = pattern only | **Reject** = incompatible

### P0 — Supersession (VibeProxy / CCR client drop-in)

| ID | Source | Target | Win | CF cost | Tag |
|----|--------|--------|-----|---------|-----|
| P0-1 | `vibeproxy` `ModelAliasMapper.swift` | `src/config/manifest.ts` aliases | GHCP/editor aliases (`ghcp-op-46` → opus) without client changes | ~2 KB | **Port** |
| P0-2 | `vibeproxy` `oauth-excluded-models` / `ProviderCatalog` | `src/http/client-policy.ts` + manifest | Per-client/provider model visibility matching VibeProxy | DO read on plan | **Adapt** |
| P0-3 | `vibeconduit` multi-account IPC | `OAuthAccountDO` + manifest `keyRef` | Round-robin across subscription accounts per route group | +1 DO RPC/attempt | **Port** |
| P0-4 | `CCR` provider transform errors | `src/providers/*-failure.ts` | OpenAI-shaped errors Claude Code expects | ~5 KB | **Port** |
| P0-5 | `vibeproxy` thinking suffix / model rewrite | planner transforms | Extended thinking via model suffix conventions | manifest only | **Adapt** |

### P1 — Reliability

| ID | Source | Target | Win | CF cost | Tag |
|----|--------|--------|-----|---------|-----|
| P1-1 | `0xrdan/claude-router` rule classifier | `smart-route-worker` planner | Cheaper default tier for simple coding prompts | ~8–15 KB rules | **Port** |
| P1-2 | `Portkey` `mode: fallback` | `attempt-loop` + manifest | Ordered target list with `context_window` / `content_policy` triggers | logic only | **Adapt** |
| P1-3 | `litellm` fallback types | `src/config/schema.ts` | Typed fallback profiles from `FailureClass` | schema | **Port** |
| P1-4 | manifest `hedge.enabled` | `nim-openai-chat` profile default | Faster tail latency on suspect routes | 2× provider cost when on | **Port** |
| P1-5 | `Helicone` `Helicone-RateLimit-Policy` | `src/security/rate-limit.ts` | Segment-aware limits (user/tenant headers) | parse header | **Adapt** |

### P2 — Operator

| ID | Source | Target | Win | CF cost | Tag |
|----|--------|--------|-----|---------|-----|
| P2-1 | `Helicone` request metadata headers | `src/observability/receipt.ts` | Session/trace/cost tags on receipts | fields only | **Adapt** |
| P2-2 | `llmscope` attribution | admin `/admin/usage` export | CSV/JSON cost rollup per client/model | cron DO | **Adapt** |
| P2-3 | `Sufmax/ai-gateway` D1 schema | compare DO usage tables | Per-provider billing columns if missing | SQL migration | **Adapt** |
| P2-4 | `tomaasz/litellm-free-models-proxy` `sync_models.py` | `scripts/sync-free-models.ts` | Offline manifest refresh for NIM/free routes | 0 Worker KB | **Adapt** |
| P2-5 | `Helicone` cache control | edge/cache API or DO | Repeat prompt savings | **Reject** inline KV cache — use CF Cache Rules external |

### P3 — Nice-to-have (bundle-gated)

| ID | Source | Target | Tag |
|----|--------|--------|-----|
| P3-1 | `Portkey` guardrails | external WAF / AI Gateway | **Reject** inline |
| P3-2 | `joshtwilliams4-web/ai-gateway-worker` team keys | `CLIENT_KEYS_JSON` schema v2 | **Port** if <20 KB |
| P3-3 | `CCR` / `lazymac2x` MCP | separate Worker | **Reject** core bundle |
| P3-4 | `litellm` admin UI | external dashboard reading admin API | **Reject** |

---

## What not to borrow

- **VibeProxy menu bar / cloudflared tunnel / LaunchAgent** — local-only ([vibeproxy-supersession-scope](vibeproxy-supersession-scope.md)).
- **Full LiteLLM Python proxy** — wrong runtime; keep TypeScript ports.
- **Helicone Postgres + dashboard** — operate via switchboard admin JSON + receipts.
- **Portkey 1600-provider registry** — switchboard manifest is curated managed routes, not open proxy.
- **Envoy control plane** — different deployment model.

---

## Implementation roadmap (post-review)

| Phase | Items | Gate |
|-------|-------|------|
| P0 PR | P0-1 … P0-5 | `pnpm test`, `pnpm validate`, live smoke for subscription routes |
| P1 PR | P1-1 … P1-5 | + hedge integration tests |
| P2 PR | P2-1 … P2-4 | + admin export tests |
| P3 PR | optional | `pnpm bundle-size` must pass |

---

## Review gate

**No implementation PRs** until you confirm priority order (P0-first recommended). Artifacts for review:

1. This document
2. `/tmp/switchboard-peer-audit/matrix/feature-matrix.csv`
3. `/tmp/switchboard-peer-audit/reports/*.md` (18 peers)
4. `/tmp/switchboard-peer-audit/reports/litellm-diff.md`

Reply with which P0 items to implement first (or “all P0”) to open the first supersession PR.
