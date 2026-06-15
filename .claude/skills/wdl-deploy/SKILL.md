---
name: wdl-deploy
description: Deploy and manage Cloudflare Workers-style projects on the WDL platform via the `wdl` CLI (init, deploy, config explain, whoami, doctor, tail, secret, workers, delete, d1, r2, workflows). Trigger when the user asks to scaffold or deploy a Worker, inspect resolved CLI configuration, identify the active control token/principal, run diagnostics, tail live logs, configure KV / Queues / Durable Objects / Workflows bindings, manage D1 / R2 / secrets through `wdl`, or troubleshoot wdl CLI output. Works with `wrangler.toml` / `wrangler.jsonc` projects pinned to wrangler@^4.
---

# WDL CLI deploy skill

The reference docs live under `docs/` in this repository. They also ship with
the published `@wdl-dev/cli` package, so any project that has run `npm install`
can read them at `node_modules/@wdl-dev/cli/docs/<name>.md`. `docs/README.md` is
the topic-doc entrypoint and explains how GUIDE and the per-topic docs divide
the work.

Open the relevant doc before answering:

- `docs/README.md` — main docs entry, GUIDE/docs division, picking the topic doc
  by task.
- `docs/deploy.md` — `wdl deploy` / `wdl tail`, credentials, the Worker URL
  shape, supported/unsupported wrangler config, common errors, destructive
  commands.
- `docs/secrets.md` — `wdl secret` (worker-level vs namespace-level), runtime
  secret precedence, `--json` automation output, anti-patterns.
- `docs/token.md` — `wdl token set/list/use/rm`, the local credential store
  (`~/.config/wdl/credentials`), its default namespace, and where it sits in
  credential resolution.
- `docs/d1.md` — `[[d1_databases]]` config, `wdl d1` commands, migrations.
- `docs/durable-objects.md` — `[[durable_objects.bindings]]`, migration class
  declarations, the DO runtime surface.
- `docs/r2.md` — `[[r2_buckets]]` config, `wdl r2` commands, R2 cleanup after
  worker deletion.
- `docs/queues.md` — `[[queues.producers]]` / `[[queues.consumers]]` config,
  queue handlers, message size and retry limits.
- `docs/workflows.md` — `[[workflows]]` config, the WDL Workflows surface,
  `wdl workflows` instance management.
- `docs/kv.md` — `[[kv_namespaces]]`, immediately visible writes, batch reads,
  `list()` metadata / pagination differences.
- `docs/assets.md` — `[assets]` directory + `env.ASSETS`, size caps, default
  exclusions and `.assetsignore`.
- `docs/cron-triggers.md` — `[triggers]` / `[[triggers.schedules]]`.
- `docs/env-overrides.md` — `[env.<name>]` override config, especially WDL's
  worker naming (no env suffix, unlike Cloudflare Workers / Wrangler) and the
  env-scoped non-inheritable rules for `vars` / bindings.

Each doc has a Chinese twin at `docs/<name>-zh.md`; both languages are
authoritative, and agent-facing references use the English set.

`templates/AGENTS.md` is the generic agent entrypoint that `wdl init` copies
into every new project. It points at the same `docs/` through
`node_modules/@wdl-dev/cli/docs/<name>.md` paths.
