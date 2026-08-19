# Deploy — `wdl deploy` reference

## What it is

`wdl deploy <dir>` bundles a Cloudflare Workers-style project with
`wrangler deploy --dry-run`, then pushes the output to the WDL control plane.
**It is not the same as `wrangler deploy`**, which talks directly to Cloudflare.
Do **not** use `wrangler deploy` on this platform — only `wdl deploy`.

Wrangler resolution order is `WDL_WRANGLER_BIN`, the Worker project's local
wrangler, the CLI package's local wrangler, then `PATH`. By default there is no
transient `npx --yes wrangler@^4` fetch; that fallback is allowed only when
`WDL_ALLOW_NPX_WRANGLER=1` is set.

WDL hides Wrangler's banner (which skips the normal banner update check) and
disables anonymous telemetry for this dry-run subprocess. Wrangler may still
consult the configured npm registry when reporting an unknown configuration
field. Project build hooks retain their normal network access.

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

| Value         | Purpose                                                                                                                                                        |
| ------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ADMIN_TOKEN` | Tenant deploy token. **Sensitive** — never paste it into chat or commit history.                                                                               |
| `WDL_NS`      | Tenant namespace, e.g. `acme`, `demo-prod`.                                                                                                                    |
| `CONTROL_URL` | Control-plane URL — from your operator, or your own self-hosted platform (e.g. `https://api.wdl.dev`). The CLI has no built-in default; it must be configured. |

**Recommended path:** `wdl token set --ns <ns> --control-url <url>` reads the
token at a hidden prompt, validates it against `/whoami`, and stores it `0600`
in `~/.config/wdl/credentials` — so it never lands in a project file or shell
history. The first stored namespace becomes the default, so later `wdl deploy`
needs no `--ns`. One store serves every project on the machine; see
[token.md](./token.md).

**Per-repo alternative:** when a project should carry its own control URL /
namespace, copy `.env.example` to `.env` and fill in the `[<ns>]` section (the
committed `.env.example` also documents the shape for teammates). The CLI reads
only `./.env` from the directory you run `wdl` in (there is no upward search),
so run `wdl` from the directory that holds it. The token stays in the gitignored
`.env`, never committed.

**CI / automation:** inject `ADMIN_TOKEN`, `CONTROL_URL`, and `WDL_NS` as
environment variables from your CI secret store — not the interactive token
store, and never a committed `.env`.

Bare control hosts get a scheme automatically; production hosts default to
`https://`, while loopback and `.test` hosts default to `http://`. The existing
bare `:8080` exception also defaults to HTTP on any host, including `.local`.
Outside that exception, `.local` defaults to HTTPS because mDNS is not loopback;
every HTTP `.local` target emits the plaintext-token warning. To force a
protocol, write `https://...` or `http://...` explicitly. A control URL may
include a path prefix, but query strings and fragments are rejected.

Precedence:
`CLI flag > shell env > .env [<ns>] section > .env base section > wdl token store`.
If none supplies a value, the command fails — there is no built-in default.

**Untrusted projects:** `wdl deploy` runs the project's local Wrangler dry-run
and build hooks as your OS user, so that code can read the on-disk token store
(the credential scrub only keeps WDL variables out of the Wrangler child's
environment, not out of the file). Only deploy projects you trust. For an
untrusted or third-party project, pass an ephemeral `--token` / `--control-url`
plus `--no-token-store` (or `WDL_TOKEN_STORE=off`) so the CLI ignores the store
— and don't keep a global store at all, since the flag opts out of _reading_ the
file, not its presence on disk. See [token.md](./token.md).

When unsure which value won, run `wdl config explain`; to confirm which control
the token actually reaches, plus the principal, platform version, and URL hints,
run `wdl whoami`; for baseline local and remote diagnostics, run `wdl doctor`.
When the control plane supports `/whoami`, `doctor` verifies the remote token,
principal namespace, platform version, and CLI compatibility. Use
`wdl doctor --strict` in CI when a failed check should make the job fail. The
namespace URL may be `(unavailable)` when the operator has not configured a
public platform domain; that does not mean authentication failed.

For runtime secrets (distinct from `ADMIN_TOKEN`), see
[secrets.md](./secrets.md).

## Worker URL shape

```
https://<namespace>.<platform-domain>/<worker-name>/<path>
```

The Worker sees the path **with the `/<worker-name>` prefix stripped**. Tenants
have no custom routing capability unless the operator explicitly enables it; do
not add `route` / `routes` in a first-time setup.

When an operator has enabled custom routing, a Worker with at least one route
pattern may set `workers_dev = false`. Its custom routes remain active, but the
platform-domain URL above returns 404. The deploy summary prints each active
route-pattern URL hint, preserving the trailing `*` on prefix patterns, and
prints the platform-domain URL only while it is enabled. WDL does not infer this
opt-out merely because `route` / `routes` is present.

Cloudflare uses `workers_dev` for a Worker's `*.workers.dev` route; versioned
preview URLs are controlled separately by `preview_urls`, which defaults to the
`workers_dev` setting. WDL maps the flag to the ordinary platform-domain serving
path above, so review it when porting a `wrangler.toml`. WDL does not support
`preview_urls`; the CLI rejects that field.

For local-development control hosts, the deploy summary reuses `CONTROL_URL`'s
scheme and public port for every printed Worker URL. `CONTROL_CONNECT_HOST`
changes only the control socket target and never a printed Worker origin.

## Core commands

| Goal                       | Command                                                   |
| -------------------------- | --------------------------------------------------------- |
| Deploy a project           | `wdl deploy <dir> [--ns <ns>] [--env <name>] [--verbose]` |
| List workers               | `wdl workers`                                             |
| Live-tail worker logs      | `wdl tail <worker> [--raw]`                               |
| Delete a non-live version  | `wdl delete version <worker> <vN>`                        |
| Delete a worker (preview)  | `wdl delete worker <worker> --dry-run`                    |
| Inspect Workflow instances | `wdl workflows instances <worker> <workflow>`             |

`--ns` is optional whenever `WDL_NS` is set via env or `.env`, or the
`wdl token` store has a default namespace. Every subcommand implements `--help`
— run it when you don't know which flag to use.

## Standard deploy flow

1. **Resolve the CLI invocation form** (above).
2. **Resolve credentials** — for a trusted project, prefer `.env` or the
   `wdl token` store; do not inline environment variables. For an untrusted or
   third-party project, use an ephemeral `--token` / `--control-url` with
   `--no-token-store` instead (see Credentials above — deploy runs project code
   as you).
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
   - `[ai]` — configure provider metadata and its credential with `wdl ai`
     before testing inference. See [ai.md](./ai.md).
6. **Apply D1 migrations** if `migrations_dir` is set — see [d1.md](./d1.md).
7. **Deploy:** `wdl deploy .`. The CLI prints the upload, the promote, and the
   runtime URL — show that URL to the user.

A deploy is two requests: upload, then promote. The upload must name the version
it retained, and a promotion counts as done only when control answers with the
version it activated. Anything else — a timeout, a transport failure, a 3xx or
5xx from whatever answered, an unreadable body, or an acknowledgement for
another version — leaves the outcome unknown, and the CLI reports it as unknown:
control may already have promoted the version. Only a 4xx says control rejected
the promotion, in which case the version was not activated and traffic is
unchanged. The CLI reports what happened and stops; it never attempts recovery.
Check the active version with `wdl workers` before deploying again, since
another deploy uploads another version.

The manifest JSON that deploy uploads to control is capped at 32 MiB. Assets are
embedded in that JSON request at deploy time; a large static file set can hit
the control request cap first. Put bulk or frequently changing files in R2, not
in assets.

The control plane enforces a headroomed 1 MiB workerd `workerLoader` environment
budget (1,040,384 bytes usable). Large `[vars]`, secrets, binding metadata, or
retained versions can fail with `worker_env_too_large`; reduce the env payload,
or redeploy/delete the retained version named in the error when one is shown.

## Session policy

`[wdl] session_policy` decides what a promotion does to the worker's established
sessions. It accepts `preserve` (default) or `restart` and inherits into
`[env.<name>]` like `workers_dev`; an env's own `[wdl]` replaces the top-level
table whole. Under `preserve`, open WebSockets keep draining on the version they
connected to while that backend stays healthy, and loaded Durable Object facets
stay on the version that built them. To opt out of that:

```toml
[wdl]
session_policy = "restart"
```

Under `restart`, promoting closes the worker's open WebSockets with code `1012`
and retires stale Durable Object facets on their next dispatch, keeping SQLite
state ([facet detail](./durable-objects.md#session-policy-and-facets)); clients
reconnect and repeat their application handshake. Every promotion counts,
including the one a worker-level secret change performs; namespace secrets do
not promote, so they do not restart sessions.

A `restart` deploy is verified twice. If the deploy response does not echo the
policy, the control plane predates it: the version stays retained and is never
promoted. If the promotion itself does not confirm the policy, the version is
already live and its sessions may not have restarted, so the CLI fails rather
than let that pass silently.

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

When multiple Wrangler config files exist, the CLI follows Wrangler's priority:
`wrangler.json`, then `wrangler.jsonc`, then `wrangler.toml`. Both JSON
filenames use Wrangler's JSONC syntax, including comments and trailing commas.

New projects should keep the `2026-06-17` compatibility date unless a feature
requires a newer one. Explicit dates before `2026-04-01`, invalid or future
dates, and dates newer than the bundled workerd supports are rejected by
control. Upstream experimental enable flags, `legacy_error_serialization`, and
`allow_irrevocable_stub_storage` are unsupported.

**Supported:** `name`, `main`, `compatibility_date` / `compatibility_flags`,
`[vars]`, `[[kv_namespaces]]`, `[[d1_databases]]`,
`[[durable_objects.bindings]]`, `[[workflows]]`, `[[r2_buckets]]`, `[ai]`,
`[assets] directory`, `[triggers] crons`, `[[triggers.schedules]]` (with
timezone, a platform extension), `[[queues.producers]]` /
`[[queues.consumers]]`, `[[services]]`, `[[platform_bindings]]`, `[[exports]]`,
`route` / `routes`, `workers_dev`, `[wdl] session_policy`, `[env.<name>]`.

WDL consumes `[[exports]]`, `[[platform_bindings]]`, `[[triggers.schedules]]`,
`[[services]].ns`, and `[wdl]` itself and removes those WDL extensions from the
temporary config passed to the Wrangler bundler. `[ai]` is standard Wrangler
configuration and stays in that temporary config for Wrangler validation. When a
selected named environment omits its own `ai`, the CLI warns that the top-level
binding is not inherited; WDL independently accepts only its `binding` field and
maps that declaration into the WDL manifest. Other fields retain their existing
Wrangler passthrough behavior. Wrangler's object-shaped declarative `exports`
configuration is not supported by WDL. `[wdl] session_policy` has its own
section above.

WDL also rejects Cloudflare Artifacts `triggers.events` subscriptions and R2
`local_dev.experimental_s3_credentials`: neither field has a WDL deploy-manifest
or runtime mapping.

### Service bindings and delegated capabilities

Tenant JSRPC can serialize `Blob` values and pass service or Durable Object
class stubs as opaque capability arguments. A receiver may call the delegated
target but cannot rewrite the host-authored caller properties carried by the
stub. Keep delegated stubs in memory; irrevocable persistence is unsupported.

**Unsupported (deploy fails):** Analytics Engine. Durable Objects supports
same-worker classes only; `script_name` and rename/delete migrations are not
implemented yet. WDL Workflows supports only workflow classes defined in the
current Worker — not full Cloudflare Workflows parity; `script_name`,
cross-worker workflows, cross-worker callbacks, service-binding callbacks, and
the Cloudflare source-AST visualizer are not supported. `route` / `routes` are
supported only when the operator enables them. Python Workers modules,
unsupported workerd compatibility flags, and WDL-reserved injected module names
are rejected during deploy: the CLI fails fast on local `.py` modules, and the
control plane is canonical for workerd compatibility and bundle-shape policy.
Top-level or selected-environment Wrangler runtime/deploy config fields and
sections that WDL would otherwise ignore are also rejected by the CLI, including
legacy `[site]` Workers Sites, `pages_build_output_dir`, `observability`,
`limits`, `placement`, and other unsupported binding/config fields or sections
named in the error. `assets.run_worker_first` is silently ignored.

Cron triggers and queue consumers are runtime dispatch features; declare them
only on routeable tenant Workers. Workers selected through
`[[platform_bindings]]` are cold-loaded platform capabilities, not
public/runtime dispatch targets, and cannot declare cron triggers or queue
consumers.

## Destructive commands

`wdl delete worker`, `wdl delete version`, `wdl d1 delete`, `wdl secret delete`,
and `wdl ai providers delete` prompt for confirmation by default. If `--dry-run`
exists, run it first; otherwise do a read-only check. Before deleting an AI
provider, run `wdl config explain` to confirm the resolved namespace, inspect
the target with `wdl ai providers get <provider> --ns <namespace>`, and use the
same explicit `--ns` for deletion. Provider deletion removes both its metadata
and credential. Add `--yes` only after confirming with the user; do **not** add
it on your own.

`wdl delete version` has no dry-run endpoint: inspect the retained version
first. The CLI rejects `--dry-run` rather than silently performing the delete.

`wdl workers` reports `workflow-defs=yes` or `workflow-defs=no`; `unknown` means
an older control omitted the field, not that no definitions exist. Worker delete
dry-runs report secret and workflow-definition presence even when a blocker
makes `wouldDelete=no`.

Deleting a worker does **not** delete R2 data — see [r2.md](./r2.md).

## Common errors

| Symptom                                                                     | Cause / fix                                                                                                                                                     |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wdl: command not found`                                                    | The CLI is not on PATH. Inside the wdl-cli repo use `node <repo>/bin/wdl.js`; otherwise run `npm i -g @wdl-dev/cli`.                                            |
| `Missing admin token`                                                       | No token resolved. Run `wdl token set --ns <ns> --control-url <url>` (recommended), or set `ADMIN_TOKEN` / pass `--token` / use the `[<ns>]` section of `.env`. |
| `401 unknown_token: unauthorized`                                           | The token is invalid for this control plane / namespace. Re-check `ADMIN_TOKEN`.                                                                                |
| `[vars] must be an object`                                                  | Use a `[vars]` table/object; arrays are invalid.                                                                                                                |
| `[vars] <NAME>: only string/number/boolean values are supported`            | Remove nested values; move sensitive strings to a secret.                                                                                                       |
| `binding name collision: <NAME>`                                            | `[vars]`, explicit bindings, or the implicit `ASSETS` binding reused a runtime env name. Rename one of them.                                                    |
| `experimental_compat_flag_unsupported`                                      | Remove the experimental workerd compatibility flag.                                                                                                             |
| `compatibility_flag_unsupported`                                            | Remove the unsupported compatibility flag named by control.                                                                                                     |
| `python_workers_unsupported`                                                | Python Workers are not supported by WDL; remove Python Worker modules. The CLI also fails fast on local `.py` modules.                                          |
| `worker_env_too_large`                                                      | Reduce `[vars]`, secrets, or binding metadata; redeploy/delete any retained version named in the error.                                                         |
| `worker_code_too_large`                                                     | Reduce generated Worker code size or split the worker.                                                                                                          |
| `worker_code_invalid`                                                       | Fix the Worker bundle shape reported by the control plane, including WDL-reserved injected module names.                                                        |
| `wrangler build failed`                                                     | Run `npx wrangler deploy --dry-run` inside the project and fix it there.                                                                                        |
| `the promotion outcome is unknown`                                          | A timeout, transport failure, 3xx/5xx or unconfirmed 2xx answered the promote. Check the active version with `wdl workers` before deploying again.              |
| `control rejected the promotion`                                            | Control refused this version — often a custom host or service-binding target that failed validation. Fix what it reported, then deploy again.                   |
| `control did not confirm session_policy = restart`                          | The control plane predates `[wdl] session_policy`; the version was uploaded and retained but not promoted. Upgrade control, then deploy again.                  |
| `control promoted the worker without confirming its restart session policy` | The version is live but its sessions may not have restarted. Reconnect clients that must run it, or deploy again once control confirms the policy.              |
| Worker URL returns 404                                                      | The URL is missing the `/<worker-name>` segment.                                                                                                                |
| `wdl tail` has no history                                                   | Tail is live-only; open `wdl tail <worker>` before triggering the request.                                                                                      |
| `tail SSE event exceeded 4194304 bytes`                                     | One assembled SSE event exceeded the CLI's 4 MiB UTF-8 data cap, so the current tail session terminated. Reduce/fix the upstream event before reconnecting.     |
| `tail session_idle` / `tail session_expired`                                | Control reclaimed the live-tail stream; the CLI reconnects automatically unless the reconnect cap is reached.                                                   |
| Namespace secret did not take effect                                        | NS-level secrets do not force-bump workers; redeploy once or use a worker-level secret.                                                                         |
| Service binding still hits the old target                                   | Bindings are pinned at caller deploy time; redeploy the caller.                                                                                                 |

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
