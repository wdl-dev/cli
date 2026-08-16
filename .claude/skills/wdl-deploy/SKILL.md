---
name: wdl-deploy
description: Deploy and manage Cloudflare Workers-style projects on the WDL platform via the `wdl` CLI (init, deploy, config explain, whoami, doctor, tail, secret, workers, delete, d1, r2, ai, workflows). Trigger when the user asks to scaffold or deploy a Worker, inspect resolved CLI configuration, identify the active control token/principal, run diagnostics, tail live logs, configure KV / Queues / Durable Objects / Workflows / AI bindings, manage D1 / R2 / AI providers / secrets through `wdl`, or troubleshoot wdl CLI output. Works with `wrangler.json` / `wrangler.jsonc` / `wrangler.toml` projects pinned to wrangler@^4.
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
  shape, supported/unsupported wrangler config, `[wdl] session_policy`, what a
  failed deploy leaves behind, common errors, destructive commands.
- `docs/secrets.md` — `wdl secret` (worker-level vs namespace-level), runtime
  secret precedence, `--json` automation output, anti-patterns.
- `docs/token.md` — `wdl token set/list/use/rm`, the local credential store
  (`~/.config/wdl/credentials`), its default namespace, and where it sits in
  credential resolution.
- `docs/d1.md` — `[[d1_databases]]` config, `wdl d1` commands, migrations.
- `docs/durable-objects.md` — `[[durable_objects.bindings]]`, migration class
  declarations, the DO runtime surface, and what a restart session policy does
  to facets and alarms.
- `docs/r2.md` — `[[r2_buckets]]` config, `wdl r2` commands, R2 cleanup after
  worker deletion.
- `docs/queues.md` — `[[queues.producers]]` / `[[queues.consumers]]` config,
  queue handlers, message size and retry limits.
- `docs/workflows.md` — `[[workflows]]` config, the WDL Workflows surface,
  `wdl workflows` instance management.
- `docs/ai.md` — `[ai]` config, namespace provider/credential management,
  Responses/tools/SSE, OpenAI SDK use, and WebSocket inference.
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

New Wrangler configs should use `compatibility_date = "2026-06-17"` unless a
project feature requires a newer target or the operator gives a different
target. Control rejects explicit dates before `2026-04-01`, invalid or future
dates, dates newer than the bundled workerd supports, upstream experimental
enable flags, `legacy_error_serialization`, and
`allow_irrevocable_stub_storage`. WDL follows Wrangler config priority
(`wrangler.json`, then `wrangler.jsonc`, then `wrangler.toml`). Both JSON
filenames use Wrangler's JSONC syntax, including comments and trailing commas.
The control plane is canonical for unsupported runtime shapes such as
unsupported workerd compatibility flags and WDL-reserved injected module names.
The CLI still fails fast for cheap local cases such as Python Workers modules,
unmapped top-level or selected-env Wrangler runtime/deploy keys (`[site]`,
`pages_build_output_dir`, `observability`, `limits`, `placement`, etc.), and
ambiguous runtime `env` name collisions between `[vars]`, explicit bindings, and
the implicit `ASSETS` binding. For an operator-enabled routed Worker, explicit
`workers_dev = false` keeps its pattern routes active while disabling the
default platform-domain URL; it requires at least one `route` / `routes` pattern
and is not inferred. The deploy summary prints every active route-pattern URL
hint, preserving the trailing `*` on prefix patterns, and includes the
platform-domain URL only while it is enabled. Cloudflare's separate
`preview_urls` field is unsupported and rejected by the CLI. WDL consumes
`[[exports]]`, `[[platform_bindings]]`, `[[triggers.schedules]]`,
`[[services]].ns`, and `[wdl]` itself and removes those WDL extensions from
Wrangler's temporary bundle config. `[ai]` is standard Wrangler configuration
and stays in that config for Wrangler validation. If a selected named
environment omits its own `ai`, the CLI warns that the top-level binding is not
inherited; WDL independently maps its `binding` into the WDL manifest. Other
fields retain their existing Wrangler passthrough behavior. Specific nested
fields that WDL cannot represent are rejected rather than silently dropped,
including Cloudflare Artifacts `triggers.events` subscriptions and R2
`local_dev.experimental_s3_credentials`. `[wdl] session_policy` accepts
`preserve` or `restart`. The default `preserve` leaves loaded Durable Object
facets on the version that built them until the host actor restarts or the facet
is deleted, and keeps established WebSockets draining while their backend stays
healthy. `restart` closes the worker's open WebSockets with code `1012` at
promotion and retires stale facets on their next dispatch, preserving SQLite
state. Wrangler's object-shaped declarative `exports` config is unsupported. The
dry-run child hides Wrangler's banner (and its normal update check) and disables
anonymous telemetry. Wrangler may still consult the configured npm registry when
reporting an unknown configuration field; project build hooks retain their
normal network access. For `[[services]]` and `[[exports]]`, read
`docs/deploy.md`: tenant JSRPC may delegate service or Durable Object class
stubs as opaque capabilities, but the receiver cannot rewrite their
host-authored caller properties. Keep delegated stubs in memory; long-term
irrevocable stub storage is unsupported.

Never recommend setting `CONTROL_CONNECT_HOST` outside local development: it
overrides the TCP target the admin token connects to (Host header + TLS SNI
still track `CONTROL_URL`), and a stale value in a CI or production shell could
route the token to an unintended host. A URL-form override uses its scheme only
to choose the default TCP port; transport still follows `CONTROL_URL`. GUIDE
covers the details. Local deploy output also derives the public Worker scheme
and port from `CONTROL_URL`, never `CONTROL_CONNECT_HOST`.

`wdl deploy` runs the project's Wrangler dry-run and build hooks as the user, so
they can read the on-disk token store (`~/.config/wdl/credentials`); only deploy
trusted projects. For a less-trusted or third-party project, recommend
`--no-token-store` (or `WDL_TOKEN_STORE=off`) with an ephemeral `--token` /
`--control-url`, rather than relying on the global store.

`wdl ai`, `wdl secret`, and `wdl token` redact invalid argument details. When a
string option precedes the complete subcommand path and its separate value is
also a command word, put the subcommand first or use `--flag=value`; for
example, use `wdl secret list --worker put` or `wdl secret --worker=put list`
for a worker named `put`.

`wdl ai providers put` replaces the complete provider record and accepts only a
project-contained `{ kind, models }` file; omitted model aliases are removed.
When editing an existing provider, derive the file with
`wdl ai providers get <provider> --json | jq '.provider | {kind, models}'`
instead of feeding response-only fields back to Control.

Treat `wdl ai providers delete` as destructive: it removes both provider
metadata and its credential and has no dry-run. Run `wdl config explain` first
to confirm the resolved namespace, inspect the target with
`wdl ai providers get <provider> --ns <namespace>`, and use the same explicit
`--ns` for deletion. Never add `--yes` without user confirmation.

`templates/AGENTS.md` is the generic agent entrypoint that `wdl init` copies
into every new project. It points at the same `docs/` through
`node_modules/@wdl-dev/cli/docs/<name>.md` paths.
