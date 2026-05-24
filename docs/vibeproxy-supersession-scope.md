# VibeProxy Supersession Scope

Switchboard supersedes VibeProxy for the hosted control-plane runtime.

In scope:

- Cloudflare Worker request routing
- Durable Object admission, health, usage, and dispatch state
- Managed provider deployments and route groups
- Subscription-backed routes
- NVIDIA NIM routes
- Smart worker aliases such as `worker`, `glm-5.1`, and `proxy-worker-smart-router`
- Fallback, hedging, and pressure-aware admission
- Operator health diagnostics for hosted routes

Out of scope:

- Ollama-Pro or other local-provider parity
- Local daemon/process supervision
- LaunchAgent or machine-startup behavior
- Direct local GPU runtime management

The out-of-scope items are intentionally excluded rather than missing parity.
Switchboard's supersession bar is that the hosted control plane should expose
clearer routing, health, fallback, and pressure behavior than VibeProxy for the
providers it actually manages.
