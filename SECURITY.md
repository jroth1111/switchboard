# Security policy

## Supported versions

Security fixes are applied on the default branch (`main`). Deploy your own Worker from that branch; there is no centrally hosted SaaS instance maintained by this repository.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security-sensitive reports.

Email the repository owner via GitHub ([jroth1111](https://github.com/jroth1111)) with:

- A description of the issue and impact
- Steps to reproduce
- Any suggested fix or mitigation

We aim to acknowledge reports within a few business days.

## Secrets and client data

- Never commit `.dev.vars`, `.secrets/`, or real `CLIENT_KEYS_JSON` (see [docs/local-secrets.md](docs/local-secrets.md)).
- Production credentials belong in Wrangler secrets or your private `switchboard-local` directory only.
