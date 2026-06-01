# Documentation

| Guide | Audience | Description |
|-------|----------|-------------|
| [local-secrets.md](local-secrets.md) | Operators | Keep API keys and client policy out of git |
| [deployment.md](deployment.md) | Operators | Deploy `llm-control-plane` to Cloudflare |

Configuration references in the repository:

- [config/client-keys.example.json](../config/client-keys.example.json) — client admission policy
- [src/config/manifest.ts](../src/config/manifest.ts) — routing and execution policies
- [src/config/schema.ts](../src/config/schema.ts) — configuration types
