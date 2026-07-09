# WDL CLI

[![npm](https://img.shields.io/npm/v/@wdl-dev/cli)](https://www.npmjs.com/package/@wdl-dev/cli)
[![CI](https://github.com/wdl-dev/cli/actions/workflows/ci.yml/badge.svg)](https://github.com/wdl-dev/cli/actions/workflows/ci.yml)
[![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/wdl-dev/cli/blob/main/LICENSE)

English | [中文](https://github.com/wdl-dev/cli/blob/main/README-zh.md)

`wdl` is the companion CLI for a
[**WDL platform**](https://github.com/wdl-dev/wdl) — a self-hostable runtime and
control plane that runs Cloudflare Workers-style code outside Cloudflare. It
bundles your project with Wrangler v4, uploads it to your operator's control
plane, and manages everything around it — D1, R2, KV, Queues, Durable Objects,
Workflows, secrets, and live logs — inside your own namespace.

## How it relates to Cloudflare Workers

- You write standard module workers (`export default { fetch }`) with a normal
  `wrangler.json` / `wrangler.jsonc` / `wrangler.toml`, pinned to `wrangler@^4`.
- `wdl deploy` runs `wrangler deploy --dry-run` **for local bundling only** —
  nothing is ever sent to Cloudflare. Do not use `wrangler deploy` against a WDL
  platform; releases go through `wdl deploy`.
- Workers serve from a path-prefixed URL on the platform domain:

  ```text
  https://<namespace>.<platform-domain>/<worker-name>/<path>
  ```

  The worker sees the path with the `/<worker-name>` prefix stripped.

- Differences come in three kinds — **stronger** (the single-region architecture
  gives strongly consistent KV and read-your-writes D1, and WDL adds
  capabilities like platform bindings), **different**, and **not implemented** —
  mapped surface by surface in the
  [compatibility matrix](https://github.com/wdl-dev/cli/blob/main/GUIDE.md#compatibility-summary).

## The hosted platform (preview)

WDL is open infrastructure first: operators run their own platform
([wdl-dev/wdl](https://github.com/wdl-dev/wdl), open source) and tenants deploy
to it with this CLI. The WDL Team also runs an experimental hosted platform —
the control plane at `api.wdl.dev`, workers serving from `*.wdl.sh` — where
wdl.dev itself already runs as workers, so platform iteration happens in the
open. It is still a preview and not open for general signups; if you want to be
a seed user, email <hi@wdl.dev>.

## Features

- **Deploy** — local Wrangler v4 bundling, manifest validation, versioned
  uploads with promote; environment overrides via `[env.<name>]`.
- **Resources** — D1 (SQL, migrations), R2 objects, KV, Queue
  producers/consumers, Durable Objects, Workflows, static assets on a CDN.
- **Secrets** — worker-level and namespace-level runtime secrets, set from stdin
  so values stay out of shell history.
- **Observability** — `wdl tail` streams live console output and exceptions;
  `wdl workers` lists deployed state.
- **Diagnostics** — `wdl doctor`, `wdl config explain`, and `wdl whoami` explain
  what the CLI resolved and what the control plane sees.
- **Guard rails** — confirmation prompts on destructive commands, terminal
  escape hardening on all control-plane data, and a trust guard that refuses to
  send your token to a `.env`-supplied endpoint it shouldn't.

## Install

Requires Node.js ≥ 22.

```bash
npm i -g @wdl-dev/cli
```

## Quick start

Your platform operator provides three values: a namespace, a tenant token, and
the control URL. The CLI has **no built-in endpoint** — commands fail with a
configuration error until a control URL is configured.

```bash
# Store the token once: hidden prompt, validated against /whoami, written 0600.
# The first stored namespace becomes the default, so later commands need no --ns.
wdl token set --ns acme --control-url "https://<your-control-plane>"

wdl init hello
cd hello
npm install
npm run deploy          # bundles locally, uploads, promotes

wdl tail hello          # live logs while you try the URL
```

The worker is now at `https://<namespace>.<platform-domain>/hello/`.

Prefer not to store the token? Credentials can also come from shell env
(`WDL_NS` / `ADMIN_TOKEN` / `CONTROL_URL`) or a project `.env` with per-namespace
sections (copy [`.env.example`](https://github.com/wdl-dev/cli/blob/main/.env.example))
— see [docs/deploy.md](https://github.com/wdl-dev/cli/blob/main/docs/deploy.md)
for the full precedence (flags beat shell env, which beats `.env`, which beats
the `wdl token` store).

## Commands

```bash
wdl init <target> [--ns <ns>] [--worker <name>]
wdl deploy <project-dir> [--ns <namespace>] [--env <name>] [--verbose]
wdl tail <worker> [<worker>...] [--ns <namespace>] [--raw]
wdl workers [--ns <namespace>]
wdl secret <put|list|delete> (--worker <name> | --scope ns) [KEY] [--json]
wdl token set --ns <ns> [--control-url <url>] [--label <text>] [--default]
wdl token list [--json] / wdl token use <ns> / wdl token rm --ns <ns>
wdl d1 <create|list|delete|execute|migrations> ...
wdl r2 buckets list / wdl r2 objects <list|head|get|delete> ...
wdl workflows <list|instances|status|pause|resume|restart|terminate> ...
wdl delete worker <name> [--dry-run] / wdl delete version <name> <version>
wdl config explain / wdl doctor / wdl whoami [--json]
wdl --version / wdl <command> --help / wdl help <command>
```

Destructive commands prompt for confirmation; pass `--yes` only in automation
that has already verified the target.

## Documentation

| Where                                                                                                                               | What                                                                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| [GUIDE.md](https://github.com/wdl-dev/cli/blob/main/GUIDE.md) / [GUIDE-zh.md](https://github.com/wdl-dev/cli/blob/main/GUIDE-zh.md) | The full tenant manual: setup, deploy, every binding, debugging                                                                          |
| [docs/](https://github.com/wdl-dev/cli/blob/main/docs/README.md)                                                                    | Per-feature references (KV, D1, R2, queues, cron, DO, workflows, assets, env overrides, secrets) — bilingual, each page has a `-zh` twin |
| [examples/](https://github.com/wdl-dev/cli/tree/main/examples)                                                                      | Minimal deployable projects, one per feature                                                                                             |

| Need                             | Example                                                                                          |
| -------------------------------- | ------------------------------------------------------------------------------------------------ |
| Minimal JSONC config             | [`hello-jsonc`](https://github.com/wdl-dev/cli/tree/main/examples/hello-jsonc)                   |
| KV binding                       | [`kv-demo`](https://github.com/wdl-dev/cli/tree/main/examples/kv-demo)                           |
| D1 + migrations                  | [`d1-demo`](https://github.com/wdl-dev/cli/tree/main/examples/d1-demo)                           |
| Cron trigger + KV                | [`cron-demo`](https://github.com/wdl-dev/cli/tree/main/examples/cron-demo)                       |
| Queue producer + consumer        | [`queues-demo`](https://github.com/wdl-dev/cli/tree/main/examples/queues-demo)                   |
| Durable Object counter           | [`durable-objects-demo`](https://github.com/wdl-dev/cli/tree/main/examples/durable-objects-demo) |
| Workflow start / status / events | [`workflows-demo`](https://github.com/wdl-dev/cli/tree/main/examples/workflows-demo)             |
| Static assets                    | [`pages-assets`](https://github.com/wdl-dev/cli/tree/main/examples/pages-assets)                 |
| Env overrides & worker naming    | [`env-overrides-demo`](https://github.com/wdl-dev/cli/tree/main/examples/env-overrides-demo)     |
| R2 + D1 + KV + assets combined   | [`inspection-demo`](https://github.com/wdl-dev/cli/tree/main/examples/inspection-demo)           |

## Using AI agents

The packaged docs are written to be agent-readable: `wdl init` drops an
`AGENTS.md` into every new project pointing at
`node_modules/@wdl-dev/cli/docs/`, so coding agents can look up bindings and
deploy rules without leaving the repo.

<details>
<summary>Prompt template for building and deploying a worker with an AI agent</summary>

```
I want to create and deploy a WDL Worker app.

Feature: [describe it here, e.g. "a hello page with a visit counter stored in KV"]
Namespace: [fill in if known, e.g. acme; otherwise ask me first]
Worker/project directory name: [fill in if known, e.g. hello-counter; otherwise ask me first]

Start executing right away — don't just hand me a plan. Follow these rules throughout:

- Never print, repeat, commit, or write any token into code.
- When credentials such as `ADMIN_TOKEN` are needed, have me enter them in my local terminal via hidden input or a local config file; never ask me to send a token in plain text.
- Real releases on this platform go through `wdl deploy`. Do not publish with `wrangler deploy`, which targets Cloudflare.

Steps:

1. Check Node.js >= 22 and npm. If `wdl` is missing, run `npm i -g @wdl-dev/cli`, then confirm `command -v wdl` works.
2. Confirm a namespace and control credentials resolve — run `wdl doctor`. They can come from shell/CI env (`WDL_NS`, `ADMIN_TOKEN`, `CONTROL_URL`), a project `.env`, or the `wdl token` store; my operator provides the control URL and token (the CLI has no built-in endpoint). If nothing resolves, the cleanest setup is for me to run `wdl token set --ns <ns> --control-url <url>` and enter the token at the hidden prompt — it is validated, stored `0600`, and becomes the default namespace, so later `wdl deploy` needs no `--ns`. Prefer this over writing the token into a shell rc file.
3. Confirm the project directory name starts with a letter and contains only letters, digits, and hyphens. Run:
   `wdl init <name> && cd <name> && npm install`
   (add `--ns <ns>` to `wdl init` to bake the namespace into the deploy script; otherwise it resolves from the `wdl token` default or `--ns` at deploy time.)
4. Immediately open and read `AGENTS.md` in the new directory, then open the relevant docs and examples under `node_modules/@wdl-dev/cli/docs/` for my feature. Note: a freshly generated `AGENTS.md` is not loaded automatically mid-session — read it explicitly.
5. Edit `wrangler.json` / `wrangler.jsonc` / `wrangler.toml` and `src/` for the feature. Push third-party API secrets with `wdl secret put --worker <worker-name> <KEY>`; never put tokens in source, Wrangler config, or `.env`.
6. Run `npm run dry-run` first and fix local bundle issues, then deploy with `npm run deploy`.
7. After a successful deploy, give me the Worker URL (shape `https://<namespace>.<platform-domain>/<worker-name>/`), the files you changed, and how I should verify.
```

</details>

## Contributing

Contributions are welcome — bug reports with reproductions, wrangler v4
config-surface coverage, Windows behavior, docs fixes, and tests all help.

The codebase is small and dependency-light: plain ESM JavaScript with no build
step, a dispatcher in `bin/wdl.js`, one file per command in `commands/`, and the
command framework, control-plane client, and Wrangler config parsing in `lib/`.
The whole test suite runs offline against mocked dependencies — you do not need
a control plane to develop.

```bash
git clone https://github.com/wdl-dev/cli.git
cd cli
npm install
npm link            # resolve `wdl` to the working tree
npm test
```

Start with
[CONTRIBUTING.md](https://github.com/wdl-dev/cli/blob/main/CONTRIBUTING.md)
(architecture overview, project invariants, where to start);
[AGENTS.md](https://github.com/wdl-dev/cli/blob/main/AGENTS.md) carries the full
conventions. Report vulnerabilities via
[SECURITY.md](https://github.com/wdl-dev/cli/blob/main/SECURITY.md), not public
issues.

## License

Copyright 2026 The WDL Authors. Licensed under
[Apache-2.0](https://github.com/wdl-dev/cli/blob/main/LICENSE).
