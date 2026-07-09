# Environment overrides — `[env.<name>]` configuration

## What it is

Wrangler config can define environment-level overrides (`vars`, `assets`,
bindings, etc.) — for example `[env.preview]` and `[env.production]`. In WDL,
`--env <name>` only selects which set of config overrides takes effect; the
deployed worker name still comes from the top-level `name`.

## When to use

- The worker's config differs between preview and production (different greeting
  strings, asset directories, KV ids, cron cadence, etc.).
- The user wants the same code deployed to two environments without switching
  branches or doing string substitution.

If preview and production config are completely identical, do not use
`[env.<name>]`; just deploy the same config twice.

## Wrangler configuration

```toml
name = "my-worker"
main = "src/index.js"
compatibility_date = "2026-06-17"

[vars]
SHARED = "top-level"
BASE_ONLY = "always-this"

[assets]
directory = "./top-public"

[env.preview]
[env.preview.vars]
ENV_NAME = "preview"
SHARED = "preview-override"

[env.production]
[env.production.vars]
ENV_NAME = "production"
SHARED = "production-override"

[env.production.assets]
directory = "./prod-public"
```

Or in `wrangler.jsonc` — same shape, JSON syntax:

```jsonc
{
  "name": "my-worker",
  "main": "src/index.js",
  "compatibility_date": "2026-06-17",
  "vars": { "SHARED": "top-level", "BASE_ONLY": "always-this" },
  "assets": { "directory": "./top-public" },
  "env": {
    "preview": {
      "vars": { "ENV_NAME": "preview", "SHARED": "preview-override" }
    },
    "production": {
      "vars": { "ENV_NAME": "production", "SHARED": "production-override" },
      "assets": { "directory": "./prod-public" }
    }
  }
}
```

## Environment resolution

As soon as any `[env.<name>]` section exists, the deploy CLI **requires**
`--env <name>` (or the `CLOUDFLARE_ENV` environment variable). It does not pick
a default for you. Be explicit:

```bash
wdl deploy . --env preview
wdl deploy . --env production
```

Resolution order: `--env` value > `CLOUDFLARE_ENV` environment variable > error.

## Differences between WDL and Cloudflare Workers

With Cloudflare Workers / Wrangler, `--env preview` usually publishes a worker /
script name with an environment suffix. WDL does not:
`wdl deploy . --env preview` and `wdl deploy . --env production` both update the
same worker named by the top-level `name`. To deploy two independent workers,
use two different top-level `name` values, two directories, or two namespaces.

`vars` and most bindings still follow Wrangler's non-inheritable mental model:
once `[env.<name>]` is selected, top-level `[vars]`, KV, D1, R2, queues,
services, workflows, etc. do not inherit into that env automatically. When a
runtime env var or binding is needed, redeclare it inside the matching
`[env.<name>]`.

With the example above:

- `BASE_ONLY` is written only in the top-level `[vars]`, so it does not appear
  in the Worker `env` when deploying with `--env preview` or `--env production`.
- `SHARED` is redeclared in both the preview and production vars, so it is
  `"preview-override"` / `"production-override"` respectively.
- `ENV_NAME` is written only in the env vars, so it exists only when deploying
  explicitly with `--env preview` or `--env production`.

These vars go into the Worker's `env` object; they are not environment variables
of your current shell. Sensitive values still go through `wdl secret put` — do
not write them into `[vars]`.

## Worker name

The deployed worker name is **always the top-level `name`** — `my-worker` in the
example above. There is **no** automatic split into `my-worker-preview` /
`my-worker-production`. The same worker gets updated; promote switches which
version is live.

If you want a fully independent worker identity per environment, use two configs
(two `name` values, two `wrangler.toml` files or two directories) instead of
`[env.<name>]`.

## Bindings per environment

`[env.<name>]` can override many kinds of config, but the inheritance rules
differ:

- Non-inheritable: `[env.<name>].vars`, `[[env.<name>.kv_namespaces]]`,
  `[[env.<name>.d1_databases]]`, `[[env.<name>.r2_buckets]]`,
  `[[env.<name>.queues.*]]`, `[[env.<name>.services]]`,
  `[[env.<name>.workflows]]`, etc. Once an env is selected, top-level config of
  the same kind does not fall back in.
- Inheritable: `main`, `compatibility_date` / `compatibility_flags`, `route` /
  `routes`, `[[migrations]]`, `[assets]`, `[triggers]`, etc. When the env does
  not set them, the top-level value keeps applying; when the env sets them, it
  overrides the top-level value.

So shared `vars` or bindings cannot live only at the top level in the
expectation that every env inherits them; each env must declare the runtime vars
and bindings it uses. Shared DO migrations, assets / cron, and the like can stay
at the top level, overridden only in the env that differs.

## Anti-patterns

- ❌ Adding `[env.<name>]` but forgetting `--env` at deploy time. The CLI
  errors; nothing deploys.
- ❌ Passing `--env <name>` when the wrangler config has no matching
  `[env.<name>]` block. The deploy aborts with
  `environment "<name>" requested but no [env] config exists`. When you need
  environment overrides, the config block and the `--env <name>` in your deploy
  scripts must stay in sync.
- ❌ Naming environments `[env.dev]` and expecting them to deploy to different
  worker names. The worker name always comes from the top-level `name`.
- ❌ Writing shared runtime vars only in the top-level `[vars]` and expecting
  preview / production to inherit them automatically. `vars` are env-scoped;
  redeclare them per env as needed.
- ❌ Putting secrets in `[env.<name>.vars]`. Use `wdl secret put` — see
  [secrets.md](./secrets.md).
- ❌ Duplicating most inheritable config under both `[env.preview]` and
  `[env.production]`. Shared `main`, `compatibility_date`, assets, triggers,
  etc. can stay at the top level; override only what differs.

## End-to-end example

`../examples/env-overrides-demo` — demonstrates that WDL adds no env suffix to
the worker name, that `[env.<name>.vars]` does not inherit the top-level
`[vars]`, and how production overrides the top-level assets directory.

## Related

- [deploy.md](./deploy.md) — the `--env` flag and resolution precedence.
- [assets.md](./assets.md) — different asset directories per environment.
- [secrets.md](./secrets.md) — secrets are **not** environment-isolated via
  `[env.<name>]`; they bind to the deployed worker.
