# AGENTS.md

This is a WDL Worker — a Cloudflare Workers-style project deployed to a WDL
control plane through the `wdl` CLI (usually `wdl deploy .` or
`npm run deploy`). It does **not** deploy to Cloudflare; `wrangler deploy` will
not work here — releases go through `wdl deploy`.

`wdl init` copies this file into the root of every generated Worker project to
tell agents how to use the docs and examples that ship with the `@wdl-dev/cli`
package.

- Per-feature reference docs live in `node_modules/@wdl-dev/cli/docs/`.
- End-to-end examples live in `node_modules/@wdl-dev/cli/examples/`.
- **If either directory is missing, run `npm install` first.**
- Read `docs/README.md` first to understand how GUIDE, docs, and examples divide
  the work; open the matching topic doc before implementing a capability. In the
  tables below, `<file>.md` lives under `docs/` and `<example>` under
  `examples/`.

## Which doc to read when

| The user wants…                                       | Read                 |
| ----------------------------------------------------- | -------------------- |
| CDN static files (HTML / JS / CSS)                    | `assets.md`          |
| Small key-value storage                               | `kv.md`              |
| SQL / relational storage                              | `d1.md`              |
| Durable Objects                                       | `durable-objects.md` |
| Object storage                                        | `r2.md`              |
| Async queues / a queue handler                        | `queues.md`          |
| Workflows                                             | `workflows.md`       |
| Scheduled / cron jobs                                 | `cron-triggers.md`   |
| WDL environment override rules (preview / production) | `env-overrides.md`   |
| Runtime secrets                                       | `secrets.md`         |
| Storing control-plane tokens locally                  | `token.md`           |
| Deploy / dry-run / list and delete workers            | `deploy.md`          |

Open the relevant doc before editing `wrangler.jsonc` / `wrangler.toml` or
`src/`. When combining features (say "cron + KV + assets"), read each matching
doc and merge their wrangler config snippets.

## Runnable end-to-end examples

When a snippet is not enough and you need a complete working file tree:

| Need                              | Example                |
| --------------------------------- | ---------------------- |
| Minimal JSONC config              | `hello-jsonc`          |
| KV binding                        | `kv-demo`              |
| D1 + migrations                   | `d1-demo`              |
| Cron trigger + KV                 | `cron-demo`            |
| Queue producer + consumer + KV    | `queues-demo`          |
| Durable Object counter            | `durable-objects-demo` |
| Workflow start / status / events  | `workflows-demo`       |
| Static assets                     | `pages-assets`         |
| WDL env overrides & worker naming | `env-overrides-demo`   |
| R2 + D1 + KV + assets combined    | `inspection-demo`      |

## Project-level anti-patterns

- ❌ Hardcoding third-party API tokens or keys into code, `.env`, or
  `wrangler.jsonc`. Push them with `wdl secret put --worker <name> <KEY>` — the
  secret value is read from stdin (type it interactively, or pipe / redirect it
  in, e.g. `echo -n "$VALUE" | wdl secret put --worker <name> <KEY>`); it is
  deliberately not a command-line argument so it stays out of shell history.
- ❌ Testing platform bindings with `wrangler dev` — `[[platform_bindings]]`
  never resolves in any local runtime; the binding is `undefined` locally and
  calling its properties or methods throws a `TypeError`. Deploy to WDL and
  verify with `wdl tail <worker>` instead (tail usage is in `deploy.md`).
- ❌ Adding `[[platform_bindings]]` entries "just in case". Every entry changes
  deploy-time validation; add only the bindings the worker actually calls.
- ❌ Renaming an applied D1 migration file. Migrations are identified by
  filename; a rename means it runs again.

## How to deploy

```bash
npm install                                            # once
npx wrangler deploy --dry-run --outdir=.deploy-dist    # bundle check
npm run deploy                                          # deploy to WDL
```

`wdl init` bakes `--ns <ns>` into the `deploy` script in `package.json` when you
pass it; without `--ns` the script is `wdl deploy .` and the namespace is
resolved at deploy time (`--ns`, `WDL_NS`, a project `.env`, or a `wdl token`
default). When you need environment overrides, add `[env.<name>]` config per
`env-overrides.md` and pass `--env <name>` explicitly in the script.

To override `vars` / `assets` / bindings / `triggers` per environment, put them
in the matching `env.<name>` block. WDL differs from Cloudflare Workers /
Wrangler in two key ways:

- `--env` does not append an environment suffix to the worker name. A worker
  named `my-worker` deployed with `--env production` is still `my-worker` on
  WDL, where standard Cloudflare Workers / Wrangler would typically produce
  `my-worker-production`.
- `vars`, KV, D1, R2, Durable Objects, queues, services, workflows, and the like
  are env-scoped / non-inheritable — top-level config of the same kind does not
  flow into the selected env; redeclare it inside the `env.<name>` block.

Full rules are in `env-overrides.md`.

If the script passes `--env <name>` but the config has no matching `env.<name>`
block, the deploy fails with
`environment "<name>" requested but no [env] config exists`; either add the
block back or drop `--env` from the script.

Credentials, `wdl` flags, and the full deploy reference are in `deploy.md`.

Three diagnostic commands, by situation:

| When                                                                                                            | Command              | What it does                                                                                                                                                                                  |
| --------------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unsure which namespace, control URL, or token the current command will use                                      | `wdl config explain` | Shows the effective config and where each value came from, confirming the command context.                                                                                                    |
| Want to confirm which control plane the current token actually reaches, the principal, and the platform version | `wdl whoami`         | Queries the current identity and target control-plane info.                                                                                                                                   |
| Local and remote environment triage (start here)                                                                | `wdl doctor`         | Checks Node.js / wdl-cli / Wrangler / config presence / credential resolution; when control supports `/whoami`, also validates the token, principal, platform version, and CLI compatibility. |
