# Guide

This guide is for Users / Tenants deploying applications to the platform. You do
not need to understand the platform internals. Write Cloudflare Workers-style
code and deploy it with the platform-provided `wdl` CLI.

## Setup

### What Your Operator Provides

Your operator will provide:

- Namespace: your tenant namespace, for example `acme`.
- Tenant token: a deploy token scoped to your namespace.
- Control URL: the deployment endpoint your operator gives you. The CLI has no
  built-in default; commands fail with a configuration error until it is set.
  (The WDL Team's hosted preview will use `https://api.wdl.dev` once it is
  live.)
- Platform domain: the runtime domain Workers serve from, e.g. `wdl.sh`.

The default Worker URL shape is:

```text
https://<namespace>.<platform-domain>/<worker-name>/<path>
```

### Install the CLI

Prerequisites:

- Wrangler v4 (`wrangler@^4`) in the Worker project; v3 is no longer supported
  by the CLI's bundling step.
- Node.js 22 or newer, matching the CLI runtime and Wrangler v4 baseline.
- `npm install` inside the Worker project before deploying if the Worker has
  dependencies.

Install from npm:

```bash
npm i -g @wdl-dev/cli
```

Or run from a checkout of this repository:

```bash
git clone https://github.com/wdl-dev/cli.git
cd cli
npm install
npm link
```

If you do not want to link the CLI globally, call the entrypoint directly:

```bash
node /path/to/cli/bin/wdl.js deploy ./my-worker
```

### Configure Defaults

Recommended shell / CI environment:

```bash
export WDL_NS=acme
export ADMIN_TOKEN="<tenant-token>"
export CONTROL_URL="https://<your-control-plane>"
```

`ADMIN_TOKEN` contains your tenant token in this guide. It is the environment
variable read by `wdl deploy`, `wdl tail`, `wdl secret`, `wdl workers`,
`wdl delete`, and other CLI commands; it does not mean you have operator
privileges.

You can also put WDL platform defaults in a `.env` file. The CLI reads `./.env`
from the directory you run `wdl` in (there is no upward search, so run `wdl`
from the directory that holds the file):

```ini
WDL_NS=acme
ADMIN_TOKEN=<tenant-token>
CONTROL_URL=https://<your-control-plane>
```

If you work with more than one namespace, keep shared values in the base section
and put namespace-specific tokens in sections:

```ini
CONTROL_URL=https://<your-control-plane>
WDL_NS=acme

[acme]
ADMIN_TOKEN=<acme-token>

[acme-staging]
ADMIN_TOKEN=<acme-staging-token>
```

The CLI loads only WDL platform variables from `.env`: `ADMIN_TOKEN`,
`CONTROL_URL`, `CONTROL_CONNECT_HOST`, and `WDL_NS`. Precedence is
`CLI flag > shell/CI env > [resolved-ns] section > base .env > wdl token store`,
and if none supplies a value the command fails — there is no built-in default.
Namespace resolution is `--ns`, then `WDL_NS` from your shell or base `.env`,
then the token store's default namespace. Section
names may be normal tenant namespaces, such as `[acme]`, or opaque
operator-reserved sections shaped like `[__name__]`. Tenant Wrangler config
still uses normal tenant namespace grammar unless your operator explicitly gave
you such a namespace token. Do not put `__name__`-shaped names in
`[[services]].ns`, `allowed_callers`, or command examples without that operator
instruction. Bare production control hosts such as `api.wdl.dev` default to
`https://`; bare local-dev hosts such as `localhost:8080` or `*.test:8080`
default to `http://`. Any bare `:8080` control URL is treated as local HTTP.
Include an explicit scheme when you need to force a different protocol. If no
namespace resolves, section values are skipped and the command will fail
normally if it needs a namespace or token. Pass `--ns` when you want to override
the default for one command.

The recommended setup keeps these credentials in a managed store rather than a
shell export or a project `.env`: `wdl token set --ns <ns> --control-url <url>`
reads the token with
hidden input, validates it against `/whoami`, and stores it under the namespace
in `~/.config/wdl/credentials` (so it never lands in shell history or a project
file). The store is the lowest-precedence layer — flags, shell env, and a
project `.env` still win — and `wdl token list` / `wdl token rm` manage it. The
first stored namespace becomes the default (a base `WDL_NS`, like a project
`.env`'s), so commands run without `--ns`; `wdl token use <ns>` switches it. See
[token.md](./docs/token.md).

Use `wdl config explain` to inspect the final namespace, control URL, masked
token, and where each value came from. Use `wdl whoami` to call control-plane
`/whoami` and display the authenticated principal, token id, platform version,
minimum supported CLI version, and URL hints. Use `wdl doctor` for local
readiness checks covering Node.js, wdl-cli, Wrangler, config presence, resolved
credentials, and `/whoami` reachability. `doctor` can detect token validity,
principal namespace, platform version, and CLI compatibility when the control
plane exposes `/whoami`; deeper capability checks still require additional
control endpoints.

## Scaffolding a New Worker

`wdl init` is the default scaffold for new WDL Worker projects:

```bash
wdl init my-worker --ns acme
cd my-worker
npm install
```

It writes:

- `package.json` — `npm run deploy` with `--ns` baked in when you pass it
  (otherwise just `wdl deploy .`, with the namespace resolved at deploy time),
  plus an `npm run dry-run` local bundle check; pins `wrangler@^4` and
  `@wdl-dev/cli` as devDependencies.
- `wrangler.jsonc` — top-level `name` is the worker name (defaults to the
  directory name; override with `--worker <name>`).
- `src/index.js`, `.gitignore`, and `AGENTS.md`/`CLAUDE.md` so AI agents can
  find the per-feature docs under `node_modules/@wdl-dev/cli/docs/`.

Use `wdl init . --ns acme` to scaffold into the current (empty) directory. The
directory name must start with a letter and contain only letters, digits, and
hyphens.

## Scaffolding from an example

When a worker needs a specific feature shape (cron, D1, R2, queues, env
overrides), AI agents (Claude Code) scaffold by copying `examples/<name>/`
directly. The rules under `.claude/rules/` document the contract:

- `.claude/rules/examples.md` lists each example with one line on what it
  teaches and the steps for scaffolding (copy, rewrite `name`, generate
  `.gitignore`).

It loads automatically when the user has wdl-cli open in Claude Code.

## Deploy Your First Worker

Use the standard Cloudflare Workers module-worker shape:

```js
export default {
  async fetch(request, env, ctx) {
    return new Response(`hello from ${env.APP_NAME}`);
  },
};
```

Minimal `wrangler.toml`:

```toml
name = "hello"
main = "src/index.js"
compatibility_date = "2026-05-31"

[vars]
APP_NAME = "hello"
```

For new projects, use `compatibility_date = "2026-05-31"` unless your operator
has given you a different target.

You can keep using `wrangler dev` for local development. To deploy to this
platform, use `wdl deploy` instead. The deploy command runs
`wrangler deploy --dry-run` (Wrangler v4) to bundle the project, preferring
`WDL_WRANGLER_BIN`, the Worker project's local wrangler, the CLI package's local
wrangler, then `PATH`. TypeScript, module resolution, esbuild bundling, and
related build behavior still follow Wrangler.

After configuring the CLI defaults:

```bash
cd /path/to/my-worker
npm install
wdl deploy .
```

You can also pass everything explicitly:

```bash
wdl deploy . \
  --ns acme \
  --control-url https://<your-control-plane> \
  --token "<tenant-token>"
```

On success, the CLI uploads the new version, promotes it to live, and prints the
public runtime URL:

```text
https://<namespace>.<platform-domain>/<worker-name>/<path>
```

Example:

```bash
curl https://acme.wdl.sh/hello/
curl https://acme.wdl.sh/hello/api/users
```

The Worker receives the path with the `/<worker-name>` prefix stripped. In the
second request above, the Worker sees `/api/users`.

## Live Worker Logs

After deployment, use `wdl tail` to watch live runtime activity for Workers in
your namespace:

```bash
wdl tail hello
```

Common forms:

```bash
wdl tail hello api                 # multiple explicit workers in one terminal
wdl tail hello --raw               # raw JSON lines
wdl tail hello --since 1700000000000-0
wdl tail hello --max-reconnects 0  # unlimited automatic reconnects
```

`wdl tail` shows request start/finish events, fetch-path `console.log` /
`console.info` / `console.warn` / `console.error`, uncaught fetch handler
exceptions, and scheduled / queue delivery start/finish events. It is live-only:
first connect does not replay history. A single-worker session can resume across
short network reconnects, while multi-worker sessions may miss events during
reconnect. For critical debugging, open a dedicated `wdl tail <worker>` session
and trigger the request after the tail is connected.

The tail stream is best-effort live debugging, not audit history. Under high
traffic or a slow terminal connection, some middle events can be skipped.
Oversized console or exception events are dropped whole and reported as small
warning events instead of being truncated. Use the normal log platform your
operator provides for incident reconstruction and full payloads.

## URLs and Routes

| Purpose                | URL                                                    | Use                                                                     |
| ---------------------- | ------------------------------------------------------ | ----------------------------------------------------------------------- |
| Deploy / control plane | operator-provided, e.g. `https://api.wdl.dev`          | Set as `CONTROL_URL` or pass with `--control-url`; used by the CLI only |
| Default Worker traffic | `https://<namespace>.<platform-domain>/<worker-name>/` | Public URL for browser, API, and curl traffic                           |

Do not send end-user Worker traffic to the control URL. The control URL is only
for deployment and management commands.

Custom domains and Wrangler `routes` are not generally available for tenant
self-service yet. Use the default Worker URL unless your operator explicitly
enables a custom host for your namespace:

```text
https://<namespace>.<platform-domain>/<worker-name>/
```

If your operator has explicitly enabled custom routing for your namespace, they
will provide the allowed host and route pattern. Do not add `route` / `routes`
to normal tenant examples or first-time deployments. If custom-host promote
fails because the host is already in use, contact your operator; multiple
Workers in the same namespace can still split paths when that shape is enabled
for you.

## Supported Wrangler Configuration

| Configuration                                                                                                                                                                                                                                                                                                                                    | Support                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `name` / `main` / `compatibility_date` / `compatibility_flags`                                                                                                                                                                                                                                                                                   | Supported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `[vars]`                                                                                                                                                                                                                                                                                                                                         | Supported; must be an object. Values must be string / number / boolean; arrays and nested values are rejected. Accepted values are exposed through Worker `env`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `[[kv_namespaces]]`                                                                                                                                                                                                                                                                                                                              | Supported for common KV APIs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `[[d1_databases]]`                                                                                                                                                                                                                                                                                                                               | Supported for bindings; create/manage databases with `wdl d1`, then reference them by `database_id` (preferred when present) or `database_name` (namespace-unique alias)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `[assets] directory = "..."`                                                                                                                                                                                                                                                                                                                     | Supported; static files are deployed to platform assets, and the Worker gets `env.ASSETS.url(path)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `route` / `routes`                                                                                                                                                                                                                                                                                                                               | Not generally available for tenant self-service; use only when your operator explicitly enables a custom host for your namespace                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `[triggers] crons`                                                                                                                                                                                                                                                                                                                               | Supported; Cloudflare-compatible form, executed in UTC                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `[[triggers.schedules]]`                                                                                                                                                                                                                                                                                                                         | Platform extension; each cron can specify its own `timezone`; not part of standard Cloudflare configuration                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `[[queues.producers]]` / `[[queues.consumers]]`                                                                                                                                                                                                                                                                                                  | Supported for producing and consuming queues; `delivery_delay` and `retry_delay` are honored, while `max_concurrency` is rejected                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `[[services]]`                                                                                                                                                                                                                                                                                                                                   | Supported for Worker-to-Worker calls; same namespace works directly, cross-namespace calls require target-side authorization                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `[[platform_bindings]]`                                                                                                                                                                                                                                                                                                                          | Supported for platform-provided first-party capabilities                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `[env.<name>]`                                                                                                                                                                                                                                                                                                                                   | Supported; select with `--env <name>` or `CLOUDFLARE_ENV`; see environment override notes below                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `[[r2_buckets]]`                                                                                                                                                                                                                                                                                                                                 | Supported for common R2 object APIs, including conditional requests, range GETs, and `list({ include })`; objects are stored in platform-local R2 and isolated by namespace + `bucket_name`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Durable Objects                                                                                                                                                                                                                                                                                                                                  | Supported for local classes listed in `[[migrations]].new_classes` or `[[migrations]].new_sqlite_classes`; both map to SQLite-backed DO storage in WDL. `script_name` and renamed/deleted migrations are not supported yet. `stub.fetch()`, JSON-structured `stub.method(...args)` DO RPC, synchronous `ctx.storage.sql`, the alarm shim, ordinary WebSocket upgrade, and the native WebSocket hibernation API surface are available; platform-level session/cursor recovery remains application-owned                                                                                                                                                                                                                                 |
| `[[workflows]]`                                                                                                                                                                                                                                                                                                                                  | Supported for workflow classes defined in the current Worker. `WorkflowEntrypoint`, `env.<BINDING>.create()`, `createBatch()`, `get()`, `status()`, `pause()`/`resume()`/`restart()`/`terminate()`, `sendEvent()`, `step.do()`/`sleep()`/`sleepUntil()`/`waitForEvent()`, retries, `NonRetryableError`, same-worker DO progress callbacks, and runtime-observed parallel/DAG steps are available. This is WDL Workflows support, not full Cloudflare Workflows parity. Instance payloads, per-turn step fan-out, and parallel step ordering are bounded; started steps must be awaited. `script_name`, cross-worker workflows, cross-worker callbacks, service-binding callbacks, and Cloudflare source-AST visualizer are unsupported |
| Analytics Engine                                                                                                                                                                                                                                                                                                                                 | Not currently supported; deploy fails if configured                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Other Wrangler binding sections (`ai`, `ai_search`, `ai_search_namespaces`, `browser`, `containers`, `data_blobs`, `dispatch_namespaces`, `hyperdrive`, `images`, `logfwdr`, `mtls_certificates`, `pipelines`, `secrets_store_secrets`, `send_email`, `tail_consumers`, `text_blobs`, `unsafe`, `vectorize`, `version_metadata`, `wasm_modules`) | Not supported; deploy fails loudly instead of silently dropping the binding. The CLI error is the authoritative list                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Cron triggers and queue consumers are dispatch features. Declare them only on
routeable Workers in tenant namespaces unless your operator gives you an
explicit reserved namespace. Workers selected through `[[platform_bindings]]`
are cold-loaded platform capabilities, not public/runtime dispatch targets, and
cannot declare cron triggers or queue consumers.

R2 custom metadata keys are normalized to lowercase on read, following HTTP
header semantics. R2 object head exposes HTTP metadata and custom metadata, so
it is treated like object body read for authorization and is not available to
observer roles. R2 conditional requests, range GETs, and
`list({ include: [...] })` metadata hydration are supported. `list({ include })`
performs extra HEAD requests under a concurrency cap, so use it only when list
results need metadata.

R2 data is not deleted when a Worker is deleted. Use `wdl r2 buckets list` and
`wdl r2 objects list <bucket>` to inspect namespace R2 data,
`wdl r2 objects head <bucket> <key>` / `wdl r2 objects get <bucket> <key>` to
inspect one object, and `wdl r2 objects delete <bucket> <key> --yes` to
explicitly remove one object. `wdl r2 buckets list` is derived from existing
object prefixes, so a declared bucket appears only after its first PUT. Object
delete is a single idempotent S3 DELETE, is not retried, and does not report
whether the object previously existed. Missing-object `HEAD` follows HTTP
semantics and returns an empty 404; `wdl r2 objects head` reports the status
rather than a JSON error body.

### Environment overrides

If the Wrangler config contains `[env.<name>]` sections, you must select one
explicitly with `--env <name>` or `CLOUDFLARE_ENV`; the CLI does not silently
choose a default environment. Unlike Cloudflare Workers / Wrangler, WDL does not
append the environment name to the worker / script name:
`wdl deploy . --env preview` still updates the top-level `name`. `vars` and most
bindings remain env-scoped and non-inheritable: selecting an env does not carry
top-level `[vars]`, KV, D1, R2, queues, services, or workflows into that env.
For staging and production side by side, use separate namespaces unless your
operator tells you otherwise.

### KV

Configuration:

```toml
[[kv_namespaces]]
binding = "VISITS"
id = "visits"
```

Code:

```js
const count = Number((await env.VISITS.get("count")) || "0") + 1;
await env.VISITS.put("count", String(count));

const profile = await env.VISITS.get("user:42", { type: "json" });
const avatar = await env.VISITS.get("user:42:avatar", { type: "arrayBuffer" });
const avatarStream = await env.VISITS.get("user:42:avatar", { type: "stream" });

return Response.json({ count });
```

Common KV operations are supported: single-key `get` for text/json/arrayBuffer/
stream values, batch `get` for text/json values, `getWithMetadata`, batch
`getWithMetadata` for text/json values, `put`, `delete`, `list`, and
`put(..., { expirationTtl | expiration })`. Batch reads deliberately reject
arrayBuffer/stream shapes before proxying.

`list({ metadata: true })` returns per-key metadata without reading full values.
Returned keys are not sorted, `limit` is a target page size capped at 1000, and
the opaque WDL cursor must be passed back verbatim. KV values are capped at 25
MiB before proxying; key byte-size is not currently capped to Cloudflare's
512-byte limit.

WDL KV writes are visible immediately. Expiring a key removes both value and
metadata; putting the key again without an expiration clears the previous
expiration. `cacheTtl` is accepted as a Cloudflare KV API shape, but WDL has no
edge read cache or global eventual-consistency window, so it does not change
read behavior.

### R2

Declare R2 bindings with Cloudflare's `[[r2_buckets]]` shape:

```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "uploads"
```

Workers use the common R2 object API:

```js
const url = new URL(request.url);
const key = url.searchParams.get("key") || "hello.txt";

if (request.method === "POST") {
  await env.BUCKET.put(key, request.body, {
    httpMetadata: { contentType: request.headers.get("content-type") || "application/octet-stream" },
  });
  return Response.json({ uploaded: key });
}

if (url.pathname === "/list") {
  const page = await env.BUCKET.list({ prefix: url.searchParams.get("prefix") || "" });
  return Response.json({ objects: page.objects.map((obj) => obj.key) });
}

const obj = await env.BUCKET.get(key);
if (!obj) return new Response("not found", { status: 404 });
return new Response(obj.body, {
  headers: { "content-type": obj.httpMetadata.contentType || "application/octet-stream" },
});
```

WDL does not create real per-namespace S3 buckets. `bucket_name` is a virtual
bucket name stored in bundle metadata at deploy time; runtime maps objects into
the platform R2 S3 bucket under `r2/<namespace>/<bucket_name>/<key>`. Workers in
the same namespace intentionally share a virtual bucket when `bucket_name`
matches; different namespaces remain isolated.

Supported runtime paths include `head`, `get`, `put`, `delete`, and `list`.
Conditional reads, range GETs, and `list({ include })` metadata hydration are
also supported for Workers that need them; metadata hydration issues extra HEAD
requests under a concurrency cap. `put(stream, ...)` currently buffers before
sending a single S3 PUT and has a 25 MiB maximum. Multipart upload, SSE-C, and
checksum selection are not supported.

Use `wdl r2` commands to inspect or explicitly delete namespace R2 data:

```bash
wdl r2 buckets list
wdl r2 objects list uploads --prefix images/
wdl r2 objects head uploads images/logo.png
wdl r2 objects get uploads images/logo.png --out logo.png
wdl r2 objects delete uploads images/logo.png --yes
```

See `examples/inspection-demo` for a combined R2 + D1 + KV + Assets example.

### D1

Create the database before deploying a Worker that binds it:

```bash
wdl d1 create main
```

Then declare the binding and deploy the Worker:

Configuration:

```toml
[[d1_databases]]
binding = "DB"
database_name = "main"
migrations_dir = "migrations"
```

Code:

```js
const { results } = await env.DB.prepare("select 1 as ok").all();
return Response.json(results[0]);
```

Deploy:

```bash
wdl deploy .
```

`database_name` is unique within your namespace. `wdl deploy` accepts
Cloudflare's D1 binding shape, but database lifecycle and migrations are managed
by this platform's `wdl d1` commands, not by `wrangler d1`.
`wdl d1 migrations status/apply` reads `migrations_dir` from the matching
`[[d1_databases]]` entry unless `--dir` is passed explicitly, preferring
`database_id` matches over `database_name`. Both `migrations_dir` and explicit
`--dir` must stay inside the project root. If your Wrangler config declares D1
bindings but none match the database ref you passed, the CLI errors and asks you
to use a configured `database_name`/`database_id` or pass `--dir`; it does not
silently fall back to `./migrations`. `preview_database_id` and
`migrations_table` are not used by WDL.

Migrations are forward-only. WDL uses the migration filename as the migration
id, so already-applied migration files should not be renamed or edited; a rename
is treated as a new migration. There is no automatic down/rollback workflow, so
write migrations in an expand/contract style when a Worker version rollback may
happen.

Useful commands:

```bash
wdl d1 list
wdl d1 execute main --sql "select 1"
wdl d1 migrations list main
wdl d1 migrations status main
wdl d1 migrations apply main
wdl d1 delete main
```

`wdl d1 delete` asks for confirmation by default. In automation, pass `--yes`
only after a separate safety check.

Runtime D1 requests are bounded before execution: the binary query body is
limited to 8 MiB, decoded requests can contain at most 1000 SQL statements and 8
MiB of aggregate SQL plus params, and aggregate result bodies are capped by the
platform default of 16 MiB. Multi-statement `exec()` runs in one SQLite
transaction; if a later statement fails, earlier statements from that `exec()`
call are rolled back.

See `examples/d1-demo` for a minimal visitor counter using D1 plus a
forward-only migration.

### Durable Objects

Declare Durable Object bindings in Wrangler config. The class must live in the
same Worker and be listed in `[[migrations]].new_classes` or
`[[migrations]].new_sqlite_classes`:

```toml
[[durable_objects.bindings]]
name = "ROOMS"
class_name = "Room"

[[migrations]]
tag = "v1"
new_classes = ["Room"]
```

```js
import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async fetch(request) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS hits (name TEXT PRIMARY KEY, value INTEGER NOT NULL)"
    );
    return Response.json({ objectId: String(this.ctx.id) });
  }
}

export default {
  async fetch(request, env) {
    const id = env.ROOMS.idFromName("main");
    return env.ROOMS.get(id).fetch(request);
  },
};
```

Supported DO surface includes `stub.fetch()`, JSON-structured
`stub.method(...args)` RPC, native `ctx.storage` and synchronous
`ctx.storage.sql`, alarms, ordinary WebSocket upgrade, and the native WebSocket
hibernation API surface. Cross-script bindings, renamed/deleted migrations, and
platform-level WebSocket session/cursor recovery are not currently available.

See `examples/durable-objects-demo` for a minimal same-worker Durable Object
counter using SQLite-backed storage.

### Workflows

Declare Workflows bindings for classes defined in the current Worker:

```toml
[[workflows]]
name = "orders"
binding = "ORDERS"
class_name = "OrderWorkflow"
```

Use `wdl workflows` to inspect definitions and manage instances:

```bash
wdl workflows list
wdl workflows instances api orders
wdl workflows status api orders order-123 --include-steps
wdl workflows pause api orders order-123
wdl workflows resume api orders order-123
wdl workflows restart api orders order-123 --yes
wdl workflows terminate api orders order-123 --yes
```

This is WDL Workflows support, not full Cloudflare Workflows parity.
`script_name`, cross-worker workflows, cross-worker callbacks, service-binding
callbacks, and Cloudflare source-AST visualizer are not supported. Same-worker
DO progress callbacks and runtime-observed parallel/DAG `step.do` execution are
available.

Important runtime limits and programming rules:

- Per-instance aggregate payload is capped at 16 MiB. Step/event writes over the
  cap fail the request; an over-cap runtime terminal result transitions the
  instance to failed in the same transaction.
- A permanently failed `step.do` makes the run terminal even if user code
  catches the thrown error.
- One step may record at most 1000 dependency edges. One dispatch turn may have
  at most 1000 in-flight workflow steps and start at most 1000 fresh backend
  steps.
- User code must await every started `step.do`. Returning while started steps
  are still unsettled fails the run as `workflow_invalid_step`.
- Parallel `step.do` siblings must be created in one synchronous fan-out batch.
  After awaiting one sibling, await the whole batch before starting the next
  durable step batch so replay computes the same dependency frontier.
- `step.sleep()`, `step.sleepUntil()`, and `step.waitForEvent()` suspend the
  whole run and must not overlap another in-flight step. Do not `Promise.race()`
  a group of durable steps and then immediately sleep/wait while another started
  step is still running.

See `examples/workflows-demo` for a minimal workflow with start/status routes
and an approval event.

### Secrets

Do not put secrets in `[vars]`. Use the secret command:

```bash
printf '%s' "$STRIPE_KEY" | wdl secret put --worker hello STRIPE_KEY
wdl secret list --worker hello
wdl secret delete --worker hello STRIPE_KEY
```

Pass `--json` to `wdl secret list`, `put`, or `delete` when automation needs the
raw control response instead of the human summary.

You can also set a namespace-level shared secret:

```bash
printf '%s' "$DATABASE_URL" | wdl secret put --scope ns DATABASE_URL
```

Precedence for duplicate names: worker secret > namespace secret > `[vars]`.
`wdl secret delete` asks for confirmation by default. In automation, pass
`--yes` only after you have already validated the target namespace, scope, and
key.

Effect timing:

- Worker-level secret changes on an active Worker create and promote a new
  version, so new traffic cold-loads the updated secret. Already-loaded
  historical versions can keep old values until runtime eviction or recycle.
- Worker-level secrets can be set before the first deploy; the first deploy will
  pick them up.
- Namespace-level secret changes are shared by every Worker in the namespace,
  but they do not bump all Workers. They take effect on the next natural
  cold-load, such as a new deploy, runtime recycle, or isolate eviction.
- Secret keys must use environment-variable grammar, for example `STRIPE_KEY`;
  values are limited to 64 KiB.

### Queues

Producer:

```toml
[[queues.producers]]
binding = "JOBS"
queue = "jobs"
```

```js
await env.JOBS.send({ type: "sync", id: "123" });
await env.JOBS.send({ type: "later" }, { delaySeconds: 60 });
await env.JOBS.sendBatch([
  { body: { id: "a" } },
  { body: "plain text" },
]);
```

Consumer:

```toml
[[queues.consumers]]
queue = "jobs"
max_batch_size = 10
max_batch_timeout = 5
max_retries = 3
retry_delay = 10
dead_letter_queue = "jobs-dlq"
```

```js
export default {
  async queue(batch, env, ctx) {
    for (const msg of batch.messages) {
      try {
        await handleJob(msg.body);
        msg.ack();
      } catch {
        msg.retry({ delaySeconds: 30 });
      }
    }
  },
};
```

Producer limits: each message body is limited to 128,000 bytes, `sendBatch()`
accepts up to 100 messages, and total batch body size is limited to 256,000
bytes.

Queue backlog metrics are shape-only for now: `send()` / `sendBatch()` include
CF-shaped metadata and `queue.metrics()` exists, but `backlogCount` and
`backlogBytes` currently return `0` rather than live queue depth.

Queue consumers are runtime dispatch targets. Declare them on routeable tenant
Workers, not on platform binding target Workers.

Queue behavior tenants can rely on:

| Feature            | Behavior                                                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Body types         | `json` is the default. Use `{ contentType: "text" }` for strings and `{ contentType: "bytes" }` for `Uint8Array` payloads. `v8` structured-clone payloads are not supported.                             |
| Send delay         | `[[queues.producers]].delivery_delay` is the default send delay in seconds. `send(body, { delaySeconds })` and per-message `sendBatch()` delays override it; `delaySeconds: 0` means immediate delivery. |
| Retry delay        | `[[queues.consumers]].retry_delay` is the default retry delay in seconds. `msg.retry({ delaySeconds })` / `batch.retryAll({ delaySeconds })` override it; `delaySeconds: 0` means immediate retry.       |
| Attempts           | The handler sees `msg.attempts` starting at `1`. With `max_retries = N`, a message can be delivered up to `N + 1` times before dead-letter handling.                                                     |
| Dead letter queue  | `dead_letter_queue` is honored. If omitted, failed messages use the queue's default DLQ.                                                                                                                 |
| Batch timeout      | `max_batch_timeout` is parsed and saved for Cloudflare config compatibility, but dispatch is currently capped by `max_batch_size`; do not depend on timeout-based batch flushing.                        |
| Unsupported config | `max_concurrency` is rejected during deploy instead of being silently ignored.                                                                                                                           |

See `examples/queues-demo` for a single Worker that produces queue messages,
consumes them, and stores delivery state in KV.

### Cron

Cloudflare-compatible form, executed in UTC:

```toml
[triggers]
crons = ["*/5 * * * *"]
```

If you need timezone-specific schedules, use the platform extension:

```toml
[[triggers.schedules]]
cron = "0 9 * * 1-5"
timezone = "Asia/Shanghai"

[[triggers.schedules]]
cron = "0 18 * * *"
timezone = "America/Los_Angeles"
```

`[[triggers.schedules]]` is not standard Cloudflare configuration. If the same
project also deploys to Cloudflare, use `[triggers] crons` and do not rely on
this extension.

Cron triggers are runtime dispatch targets. Declare them on routeable tenant
Workers, not on platform binding target Workers.

Code:

```js
export default {
  async scheduled(event, env, ctx) {
    await doWork();
  },
};
```

### Assets

```toml
[assets]
directory = "./public"
```

```js
const logoUrl = await env.ASSETS.url("logo.png");
return Response.redirect(logoUrl);
```

This supports the `assets.directory` model where the Worker returns asset URLs
and browsers fetch static assets directly. Cloudflare Workers Assets
`run_worker_first` interception is not implemented; configuring it has no
effect. If static files must go through Worker authentication or rewriting, keep
those files inside the Worker bundle and return them from the Worker.

The deploy manifest sent to control is capped at 32 MiB. Assets are embedded in
that JSON request during deploy (base64, ~4/3 inflation), so a large asset set
can hit the control request cap before runtime limits. The CLI additionally
pre-checks each asset file against a 25 MiB per-file cap and 100 MiB total cap
before bundling. Use R2 for bulk or frequently changing files.

By default the CLI skips `.git/`, `node_modules/`, `.DS_Store`, `.wrangler/`,
`.deploy-dist/`, `.wrangler.wdl-tmp*.json`, and `.env`/`.env.*` in the assets
tree; deploy prints a note listing what was skipped. To exclude more files (or
deliberately re-include one of the defaults with a `!pattern` line), add a
`.assetsignore` file with gitignore-style patterns to the assets directory — the
same mechanism Cloudflare Workers Assets uses. The `.assetsignore` file itself
is also skipped by default.

### Service Bindings

Worker-to-Worker calls in the same namespace:

```toml
[[services]]
binding = "AUTH"
service = "auth-worker"
```

```js
const res = await env.AUTH.fetch(request);
```

Named entrypoint:

```toml
[[services]]
binding = "BILLING"
service = "billing-worker"
entrypoint = "Billing"
```

Cross-namespace calls require the target Worker to authorize your namespace in
its own configuration:

```toml
allowed_callers = ["acme"]
```

Service bindings are resolved at deploy time and pinned to the target's live
version at that moment. Later target upgrades do not automatically affect
already-deployed callers; redeploy the caller to bind to the target's newer
version. If the target changes `allowed_callers`, `[[exports]]`, or
`required_caller_secrets`, already-deployed callers keep their old resolved
binding until they redeploy.

`export default function(request, env, ctx)` is treated as fetch-handler
shorthand and is exposed through `.fetch(...)`; it is not a callable default RPC
method. Put RPC methods on a named `WorkerEntrypoint` or on default object/class
methods.

### Platform Bindings

If the platform provides a first-party shared capability, bind the
platform-provided symbol:

```toml
[[platform_bindings]]
binding = "PAYMENT"
platform = "STRIPE"
```

```js
const result = await env.PAYMENT.charge({ amount: 100 });
```

`binding` and `platform` must use uppercase snake case, such as `PAYMENT` or
`JSJ_BRIDGE`. If the platform capability requires caller secrets, the CLI prints
which secrets are missing during deploy.

## Appendix: Advanced Runtime HTTP APIs

Beyond bindings, loaded Workers inherit standard workerd runtime APIs. You can
skip this section for a basic HTTP API Worker. The items below are verified
end-to-end on this platform and safe to rely on when you need them.

### WebSocket

Return a 101 response with a `WebSocketPair` from `fetch`. The upgrade and
subsequent frames flow through all platform tiers without extra configuration:

```js
export default {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.addEventListener("message", (evt) => server.send("echo:" + evt.data));
    return new Response(null, { status: 101, webSocket: client });
  },
};
```

### Streaming responses (SSE, chunked)

A `Response` whose body is a `ReadableStream` is streamed through the platform
without buffering — suitable for `text/event-stream`, progressive downloads, or
any long-lived response.

### Raw TCP via `cloudflare:sockets`

`import { connect } from "cloudflare:sockets"` is available; tenant namespaces
can dial public TCP endpoints. Internal platform addresses are blocked at the
workerd network boundary.

```js
import { connect } from "cloudflare:sockets";

export default {
  async fetch() {
    const sock = connect("example.com:80");
    // write / read via sock.writable / sock.readable …
  },
};
```

### Client disconnect

`request.signal` is **not** a reliable disconnect signal once a streaming
response has started — workerd considers the response committed and does not
abort the inbound Request. Use the body stream's `cancel` callback (or catch
`controller.enqueue` throwing when the downstream reader is gone). If you need a
side effect to survive teardown (logging, counters), register `ctx.waitUntil`
up-front on a promise that `cancel` resolves; scheduling `waitUntil` from inside
`cancel` races IoContext teardown.

```js
const { promise: outcome, resolve: resolveOutcome } = Promise.withResolvers();
ctx.waitUntil((async () => { console.log("client:", await outcome); })());

const stream = new ReadableStream({
  async start(controller) {
    // … enqueue chunks …
    resolveOutcome("ended-normally");
  },
  cancel() { resolveOutcome("cancel"); },
});
return new Response(stream);
```

## Naming Constraints

Common naming rules:

- namespace: 1-63 lowercase letters, digits, and hyphens; must start and end
  with a lowercase letter or digit, for example `acme-prod`. Namespaces shaped
  like `__foo__` are platform-reserved; do not use them in tenant configuration.
- worker name: letters, digits, underscores, and hyphens; must start with a
  letter or digit.
- KV id / queue name: lowercase letters, digits, and hyphens.
- binding name: a valid JavaScript identifier, for example `DB`, `MY_QUEUE`, or
  `authService`.
- platform binding: uppercase letters, digits, and underscores, for example
  `PAYMENT`.

## Common Operations

List Workers in the namespace:

```bash
wdl workers
```

Delete a non-live version:

```bash
wdl delete version hello v1
```

Preview deleting a whole Worker:

```bash
wdl delete worker hello --dry-run
```

Delete after confirming:

```bash
wdl delete worker hello
```

`wdl delete worker` asks for confirmation by default. Use `--dry-run` first to
preview the affected active version, retained versions, routes, worker secrets,
queue consumers, and asset cleanup. In automation, pass `--yes` only after a
separate safety check.

Delete a D1 database after confirming:

```bash
wdl d1 delete main
```

Live-tail a Worker:

```bash
wdl tail hello
```

## Troubleshooting

| Symptom                                                                | Likely cause                                                                                                        | What to check                                                                                                           |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------- |
| `Missing admin token`                                                  | No tenant token was provided                                                                                        | Run `wdl token set --ns <ns> --control-url <url>` (recommended), set `ADMIN_TOKEN`, or pass `--token`                                                                                     |
| `wrangler build failed`                                                | Wrangler could not bundle the Worker project                                                                        | Run `npx wrangler deploy --dry-run` inside the Worker project and fix local build/config errors                         |
| Deploy succeeds but promote fails                                      | Route, custom host, or binding validation failed at promotion time                                                  | Check that custom hosts are enabled for your namespace and service-binding targets exist                                |
| Worker URL returns 404                                                 | URL shape or worker name is wrong                                                                                   | Use `https://<namespace>.<platform-domain>/<worker-name>/`; include the worker name path segment                        |
| Worker URL returns `502 runtime_error`                                 | The Worker `fetch()` handler threw before producing a response                                                      | Use `wdl tail <worker>` and request logs; exception details are intentionally not copied into the client response body  |
| A namespace-level secret did not change immediately                    | Namespace secrets do not bump every Worker version                                                                  | Redeploy the Worker or wait for a natural cold-load; use a worker-level secret for immediate rollout                    |
| A service binding still calls the old target behavior                  | Bindings are pinned at caller deploy time                                                                           | Redeploy the caller Worker                                                                                              |
| `wdl tail` has no history                                              | Tail is live-only; first connect starts at the current stream tail                                                  | Start `wdl tail <worker>` before triggering the request; use single-worker `--since <stream-id>` only for manual resume |
| Multi-worker `wdl tail` can miss logs after reconnect                  | One connection cannot preserve independent resume positions for multiple workers                                    | Use a dedicated `wdl tail <worker>` session for critical debugging                                                      |
| Scheduled / queue handler `console.*` output is absent from `wdl tail` | Tail shows fetch / scheduled / queue start/finish; scheduled / queue handler console does not enter the tail stream | Use `wdl tail` for trigger/outcome and the normal log platform for handler console details                              |

## Compatibility Summary

Think of this platform as a runtime where you write Cloudflare Workers-style
code and deploy with the platform CLI: worker module syntax, `fetch`,
`scheduled`, and `queue` handlers follow the Cloudflare Workers mental model,
and Wrangler projects deploy directly (`wrangler.toml`, `wrangler.jsonc`, and
`wrangler.json` are supported).

The three right-hand columns of the matrix separate three different kinds of
difference. **Stronger / added** covers advantages that fall out of the
architecture (a single region means strong consistency where Cloudflare is
eventually consistent) and capabilities WDL adds beyond Cloudflare.
**Different** covers model differences that are neither stronger nor weaker —
just things to know. **Not implemented** means the surface genuinely does not
exist here.

| Surface                                                                       | Status        | Stronger / added on WDL                                                                                                      | Different from Cloudflare                                                                                                                                    | Not implemented                                                                                               |
| ----------------------------------------------------------------------------- | ------------- | ---------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Module Workers (`fetch` / `scheduled` / `queue`)                              | Supported     | —                                                                                                                            | An uncaught exception returns a platform `502 runtime_error`; exception detail goes to `wdl tail` and logs, not the response body                            | —                                                                                                             |
| WebSocket upgrade                                                             | Supported     | —                                                                                                                            | —                                                                                                                                                            | Automatic session recovery across platform restarts; clients should reconnect                                 |
| Streaming responses, outbound TCP (`cloudflare:sockets`)                      | Supported     | —                                                                                                                            | Tenant workers dial public endpoints only; platform-internal addresses are blocked                                                                           | —                                                                                                             |
| `compatibility_date` / `compatibility_flags`                                  | Partial       | —                                                                                                                            | The platform runs one workerd configuration; historical Cloudflare behavior changes are not emulated per worker                                              | —                                                                                                             |
| KV                                                                            | Supported     | Writes are immediately visible — strong consistency where Cloudflare's edge replication is eventually consistent             | `cacheTtl` is accepted but is not a freshness contract                                                                                                       | —                                                                                                             |
| R2                                                                            | Supported     | —                                                                                                                            | Single-region object store                                                                                                                                   | Multipart upload, `preview_bucket_name`, `jurisdiction`                                                       |
| Static assets                                                                 | Partial       | `env.ASSETS.url(path)` hands out tokenized CDN URLs — a WDL addition                                                         | —                                                                                                                                                            | Cloudflare Pages-style asset pipeline, fetch-style assets binding                                             |
| D1                                                                            | Partial       | Single primary database — read-your-writes by default, no replication lag or bookmark semantics to reason about              | Request/result sizes are capped. Lifecycle and migrations are managed with `wdl d1`; `[[d1_databases]]` is the binding declaration only                      | Read replication, Time Travel / bookmarks                                                                     |
| Durable Objects                                                               | Partial       | —                                                                                                                            | Same-worker classes; `new_classes` and `new_sqlite_classes` are equivalent on WDL                                                                            | `script_name` (cross-script bindings), rename/delete migrations, WebSocket session/cursor recovery            |
| Queues                                                                        | Partial       | —                                                                                                                            | Batching is size-driven; `max_batch_timeout` is stored for config compatibility but is not an aggregation window                                             | `max_concurrency` (rejected loudly), `contentType: "v8"`                                                      |
| Cron triggers                                                                 | Supported     | —                                                                                                                            | Cloudflare-compatible expressions, executed in UTC; best-effort minute slots — missed slots are skipped, never replayed, and failures are not retried        | —                                                                                                             |
| Workflows                                                                     | Partial       | Parallel / DAG steps are observed at runtime, including `Promise.all` siblings                                               | WDL-specific payload semantics; bounded payloads and per-turn step fan-out; strict await ordering; a permanently failed `step.do` is terminal even if caught | Full Cloudflare Workflows parity, `script_name` / cross-worker workflows and callbacks, source-AST visualizer |
| Service bindings                                                              | Supported     | —                                                                                                                            | —                                                                                                                                                            | —                                                                                                             |
| Platform bindings                                                             | Supported     | A WDL addition with no Cloudflare counterpart: operator-curated capabilities injected into `env` via `[[platform_bindings]]` | —                                                                                                                                                            | —                                                                                                             |
| Vars and secrets                                                              | Supported     | —                                                                                                                            | Secrets are platform-managed via `wdl secret`, not Cloudflare account secrets                                                                                | —                                                                                                             |
| Cache API (`caches.default`)                                                  | Not supported | —                                                                                                                            | —                                                                                                                                                            | Not exposed; do not depend on it                                                                              |
| Workers AI, Vectorize, Analytics Engine, Browser Rendering, Hyperdrive, Email | Not supported | —                                                                                                                            | —                                                                                                                                                            | No binding exists; deploy rejects these config sections loudly                                                |

Resources are platform-local, not Cloudflare account resources:
`kv_namespaces.id`, queue names, and platform binding names refer to this
platform.
