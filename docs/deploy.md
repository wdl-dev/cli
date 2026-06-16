# Deploy — `wdl deploy` reference

## What it is

`wdl deploy <dir>` bundles a Cloudflare Workers-style project with
`wrangler deploy --dry-run`, then pushes the output to the WDL control plane.
**It is not the same as `wrangler deploy`**, which talks directly to Cloudflare.
Do **not** use `wrangler deploy` on this platform — only `wdl deploy`.

Wrangler resolution order is `WDL_WRANGLER_BIN`, the Worker project's local
wrangler, the CLI package's local wrangler, then `PATH`. By default there is no
transient `npx --yes wrangler` fetch; that fallback is allowed only when
`WDL_ALLOW_NPX_WRANGLER=1` is set.

## CLI invocation forms

Pick one in this order:

1. **`command -v wdl` succeeds** — installed globally (`npm i -g @wdl-dev/cli`).
   Use `wdl ...` directly.
2. **Developing inside the wdl-cli repo** (`<repo>/bin/wdl.js` exists) — use
   `node <repo>/bin/wdl.js ...`. This is the development scenario.
3. **Neither** — stop and tell the user; do not invent a path.

In the examples below, treat `wdl` as a placeholder and substitute the form you
resolved.

## Credentials — one-time setup

The CLI needs three values:

| Value         | Purpose                                                                                                                            |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_TOKEN` | Tenant deploy token. **Sensitive** — never paste it into chat or commit history.                                                   |
| `WDL_NS`      | Tenant namespace, e.g. `acme`, `demo-prod`.                                                                                        |
| `CONTROL_URL` | Control-plane URL, provided by your operator (e.g. `https://api.wdl.dev`). The CLI has no built-in default; it must be configured. |

**Recommended path:** `wdl token set --ns <ns> --control-url <url>` reads the
token at a hidden prompt, validates it against `/whoami`, and stores it `0600` in
`~/.config/wdl/credentials` — so it never lands in a project file or shell
history. The first stored namespace becomes the default, so later `wdl deploy`
needs no `--ns`. One store serves every project on the machine; see
[token.md](./token.md).

**Per-repo alternative:** when a project should carry its own control URL /
namespace, copy `.env.example` to `.env` and fill in the `[<ns>]` section (the
committed `.env.example` also documents the shape for teammates). The CLI reads
only `./.env` from the directory you run `wdl` in (there is no upward search), so
run `wdl` from the directory that holds it. The token stays in the gitignored
`.env`, never committed.

**CI / automation:** inject `ADMIN_TOKEN`, `CONTROL_URL`, and `WDL_NS` as
environment variables from your CI secret store — not the interactive token
store, and never a committed `.env`.

Bare control hosts get a scheme automatically; production hosts default to
`https://`, local `.test` / `.local` or `:8080` hosts default to `http://`. To
force a protocol, write `https://...` or `http://...` explicitly.

Precedence: `CLI flag > shell env > .env [<ns>] section > .env base section > wdl
token store`. If none supplies a value, the command fails — there is no built-in
default.

When unsure which value won, run `wdl config explain`; to confirm which control
the token actually reaches, plus the principal, platform version, and URL hints,
run `wdl whoami`; for baseline local and remote diagnostics, run `wdl doctor`.
When the control plane supports `/whoami`, `doctor` verifies the remote token,
principal namespace, platform version, and CLI compatibility.

For runtime secrets (distinct from `ADMIN_TOKEN`), see
[secrets.md](./secrets.md).

## Worker URL shape

```
https://<namespace>.<platform-domain>/<worker-name>/<path>
```

The Worker sees the path **with the `/<worker-name>` prefix stripped**. Tenants
have no custom routing capability unless the operator explicitly enables it; do
not add `route` / `routes` in a first-time setup.

## Core commands

| Goal                       | Command                                                   |
| -------------------------- | --------------------------------------------------------- |
| Deploy a project           | `wdl deploy <dir> [--ns <ns>] [--env <name>] [--verbose]` |
| List workers               | `wdl workers`                                             |
| Live-tail worker logs      | `wdl tail <worker> [--raw]`                               |
| Delete a non-live version  | `wdl delete version <worker> <vN>`                        |
| Delete a worker (preview)  | `wdl delete worker <worker> --dry-run`                    |
| Inspect Workflow instances | `wdl workflows instances <worker> <workflow>`             |

`--ns` is optional whenever `WDL_NS` is set via env or `.env`, or the `wdl token`
store has a default namespace. Every subcommand implements `--help` — run it when
you don't know which flag to use.

## Standard deploy flow

1. **Resolve the CLI invocation form** (above).
2. **Resolve credentials** — prefer `.env` or the `wdl token` store; do not
   inline environment variables.
3. **Wrangler version check.** The bundling step requires `wrangler@^4`. If the
   project pins v3, stop and tell the user — do not silently upgrade.
4. **Install worker dependencies** (`npm install` in the worker directory) if
   `node_modules` is missing.
5. **Pre-create persistent bindings.** Read the wrangler config:
   - `[[d1_databases]]` → for each `database_name`, check with `wdl d1 list`
     first; create missing ones with `wdl d1 create <name>`. See
     [d1.md](./d1.md).
   - `[[r2_buckets]]` and `[[kv_namespaces]]` are lazy — no pre-creation needed;
     the binding works on first use. See [r2.md](./r2.md) and [kv.md](./kv.md).
   - `[[queues.*]]` — see [queues.md](./queues.md); when queue ownership is
     unclear, confirm with the operator.
6. **Apply D1 migrations** if `migrations_dir` is set — see [d1.md](./d1.md).
7. **Deploy:** `wdl deploy .`. The CLI prints the upload, the promote, and the
   runtime URL — show that URL to the user.

The manifest JSON that deploy uploads to control is capped at 32 MiB. Assets are
embedded in that JSON request at deploy time; a large static file set can hit
the control request cap first. Put bulk or frequently changing files in R2, not
in assets.

## Environment overrides

When the wrangler config has `[env.<name>]` sections, `--env <name>` (or
`CLOUDFLARE_ENV`) is **required** — the CLI does not pick a default for you. Be
explicit:

```bash
wdl deploy . --env preview
wdl deploy . --env production
```

The deployed worker name always comes from the top-level `name`, with no
environment suffix. Wrangler / Cloudflare Workers `--env` may lead you to expect
names like `my-worker-preview`; WDL does not append that suffix. See
[env-overrides.md](./env-overrides.md) for the config shape.

## Supported / unsupported wrangler configuration

**Supported:** `name`, `main`, `compatibility_date`/`flags`, `[vars]`,
`[[kv_namespaces]]`, `[[d1_databases]]`, `[[durable_objects.bindings]]`,
`[[workflows]]`, `[[r2_buckets]]`, `[assets] directory`, `[triggers] crons`,
`[[triggers.schedules]]` (with timezone, a platform extension),
`[[queues.producers]]` / `[[queues.consumers]]`, `[[services]]`,
`[[platform_bindings]]`, `[env.<name>]`.

**Unsupported (deploy fails):** Analytics Engine. Durable Objects supports
same-worker classes only; `script_name` and rename/delete migrations are not
implemented yet. WDL Workflows supports only workflow classes defined in the
current Worker — not full Cloudflare Workflows parity; `script_name`,
cross-worker workflows, cross-worker callbacks, service-binding callbacks, and
the Cloudflare source-AST visualizer are not supported. `route` / `routes` are
supported only when the operator enables them. `assets.run_worker_first` is
silently ignored.

Cron triggers and queue consumers are runtime dispatch features; declare them
only on routeable tenant Workers. Workers selected through
`[[platform_bindings]]` are cold-loaded platform capabilities, not
public/runtime dispatch targets, and cannot declare cron triggers or queue
consumers.

## Destructive commands

`wdl delete worker`, `wdl delete version`, `wdl d1 delete`, and
`wdl secret delete` prompt for confirmation by default. If `--dry-run` exists,
run it first (or do a read-only check), then add `--yes` only after confirming
with the user. Do **not** add `--yes` on your own.

Deleting a worker does **not** delete R2 data — see [r2.md](./r2.md).

## Common errors

| Symptom                                                          | Cause / fix                                                                                                          |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `wdl: command not found`                                         | The CLI is not on PATH. Inside the wdl-cli repo use `node <repo>/bin/wdl.js`; otherwise run `npm i -g @wdl-dev/cli`. |
| `Missing admin token`                                            | No token resolved. Run `wdl token set --ns <ns> --control-url <url>` (recommended), or set `ADMIN_TOKEN` / pass `--token` / use the `[<ns>]` section of `.env`.                         |
| `401 unknown_token: unauthorized`                                | The token is invalid for this control plane / namespace. Re-check `ADMIN_TOKEN`.                                     |
| `[vars] must be an object`                                       | Use a `[vars]` table/object; arrays are invalid.                                                                     |
| `[vars] <NAME>: only string/number/boolean values are supported` | Remove nested values; move sensitive strings to a secret.                                                            |
| `wrangler build failed`                                          | Run `npx wrangler deploy --dry-run` inside the project and fix it there.                                             |
| Deploy succeeds but promote fails                                | Custom host or service-binding target validation issue; check the binding targets.                                   |
| Worker URL returns 404                                           | The URL is missing the `/<worker-name>` segment.                                                                     |
| `wdl tail` has no history                                        | Tail is live-only; open `wdl tail <worker>` before triggering the request.                                           |
| Namespace secret did not take effect                             | NS-level secrets do not force-bump workers; redeploy once or use a worker-level secret.                              |
| Service binding still hits the old target                        | Bindings are pinned at caller deploy time; redeploy the caller.                                                      |

## Anti-patterns

- ❌ Running `wrangler deploy` on this platform. It talks to Cloudflare, not
  WDL. Use `wdl deploy`.
- ❌ Committing a `.env` file containing `ADMIN_TOKEN` to git.
- ❌ Adding Durable Objects / Workflows config "just in case" — they change the
  runtime entrypoint and deploy validation; add them only when the code actually
  uses them.
- ❌ Pinning `wrangler` to `^3`. The bundling step requires v4.

## End-to-end examples

Every example under `../examples/<name>` is a deployable project.
`../examples/hello-jsonc` is the smallest.
