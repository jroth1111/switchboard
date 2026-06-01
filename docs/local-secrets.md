# Local secrets (not in git)

Operator credentials, client key hashes, and OAuth material must **not** live in the public switchboard repository.

## Default layout

```
CascadeProjects/
  switchboard/          # public git clone
  switchboard-local/    # private — never push to the public repo
    .dev.vars
    .secrets/
      chatgpt-auth.json   # optional
```

Create the private directory:

```bash
mkdir -p ../switchboard-local/.secrets
cp .dev.vars.example ../switchboard-local/.dev.vars
chmod 0600 ../switchboard-local/.dev.vars
```

Override location with `SWITCHBOARD_LOCAL_DIR` (absolute or relative to the repo root).

## What loads automatically

These scripts merge env from `switchboard-local` first, then legacy repo-root `.dev.vars` / `.secrets` if present:

- `pnpm validate` (manifest + ChatGPT auth checks)
- `pnpm live:smoke`
- `pnpm migrate:api-keys`
- `pnpm check:secret-permissions`

## Wrangler dev

`wrangler dev` reads `.dev.vars` from the **repository root**. Use a symlink (gitignored):

```bash
ln -sf ../switchboard-local/.dev.vars .dev.vars
```

## CI and tests

CI uses only `config/fixtures/*.ci.json` (synthetic tokens). Unit tests use temporary directories; they do not read your private files.

The repo `.gitignore` blocks real secret paths (`.dev.vars`, `.secrets/`, `config/client-keys.json`, `**/chatgpt-auth.json`, etc.) while keeping `*.example` and `config/fixtures/*.ci.json` tracked.

## Migrate from repo-root secrets

If you still have `.dev.vars` or `.secrets/` inside the clone:

```bash
mv .dev.vars ../switchboard-local/.dev.vars 2>/dev/null || true
mv .secrets ../switchboard-local/.secrets 2>/dev/null || true
pnpm check:secret-permissions
```
