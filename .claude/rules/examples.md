# Scaffolding WDL Workers from `examples/`

`wdl init` is the default scaffold for new WDL Workers. Use `examples/` as
richer starting points only when the user needs a specific feature shape such as
cron, D1, R2, environment overrides, or a combined demo. Do not invent project
structure from scratch.

## Apply this rule when

- The user asks to create a worker, project, app, page, scheduled job, cron, or
  queue consumer that should ship via `wdl deploy`.
- The user mentions wdl, the wdl runtime, `[[platform_bindings]]`, or
  scaffolding a new directory under wdl-cli.

## Available examples

Each lives under `examples/<name>/`. Prefer `wdl init <target> [--ns <ns>]` for
plain workers. Pick and copy the closest example when an example matches the
requested feature set better than the minimal init template.

| Example                | Teaches                                                                                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `hello-jsonc`          | Bare-minimum fetch handler. `wrangler.jsonc` + `vars.GREETING`. Use as the base when the worker has no bindings.                                                                                                                                                               |
| `pages-assets`         | HTML page + CDN-served static assets via `env.ASSETS.url()`. `wrangler.jsonc` with `assets.directory = "./public"`. Use for any SSR/SPA page worker.                                                                                                                           |
| `kv-demo`              | KV namespace as a counter (`env.VISITS`). `wrangler.toml`. Use when the worker needs a small persistent key-value store.                                                                                                                                                       |
| `d1-demo`              | D1 database with a `migrations/` directory. `wrangler.toml`. Use when the worker needs SQL / relational state.                                                                                                                                                                 |
| `cron-demo`            | Scheduled handler triggered by `crons = ["*/1 * * * *"]`. KV-backed last-tick tracking. `wrangler.toml`. Use for cron / batch jobs.                                                                                                                                            |
| `queues-demo`          | Queue producer + consumer in one routeable worker, with consumed message state in KV. `wrangler.toml`. Use when requests should enqueue background work.                                                                                                                       |
| `durable-objects-demo` | Same-worker Durable Object class with SQLite-backed counter state. `wrangler.toml`. Use when one logical object needs serialized state.                                                                                                                                        |
| `workflows-demo`       | Workflow class with start/status/approval routes. `wrangler.toml`. Use when work spans multiple durable steps or needs CLI-visible instance state.                                                                                                                             |
| `env-overrides-demo`   | `[env.preview]` and `[env.production]` blocks showing WDL-specific env override behavior: no worker-name suffix, env-scoped vars that do not inherit top-level vars, and assets override. `wrangler.toml`. Layer on top of any of the above when you need env-specific config. |
| `inspection-demo`      | Multi-binding example combining D1 + KV + R2 + assets. `wrangler.toml`. Use as a reference when the worker needs more than one binding.                                                                                                                                        |

To pick: for a worker that serves a page or fronts an external API, start from
`pages-assets`. For pure compute, cron, or queue work, start from `hello-jsonc`,
`cron-demo`, or `queues-demo`.

## Scaffolding steps

1. **Resolve the project name.** Use the directory the user named (e.g.
   `my-dashboard`). It must match `^[A-Za-z][A-Za-z0-9-]*$`, the same shape
   accepted by `wdl init`. The CLI sanitizes this value only for Wrangler's
   local bundling check; the original name is deployed to WDL.
2. **Copy the example tree** into the new directory, preserving the layout
   (`src/`, `public/`, `migrations/` if present, etc.). Don't add subdirectories
   or top-level files the example doesn't have.
3. **Rewrite `name`** in:
   - `package.json` → `"name": "<project-name>"`
   - `wrangler.jsonc` or `wrangler.toml` → top-level `name` field.
   - **Don't** rewrite anything else automatically. Compatibility date, binding
     ids, vars, etc. stay as the example sets them; the user edits what they
     need.
4. **Write `.gitignore`** at the project root with:

   ```
   node_modules/
   .deploy-dist/
   .wrangler/
   .wrangler.wdl-tmp*.json
   *.log

   # Never commit tenant credentials
   .env
   .env.*
   !.env.example
   ```

   Examples don't ship one because they're committed to wdl-cli's repo — every
   new project does.

5. **Customize `src/`** to do what the user asked. The example's handler is a
   starting point, not a final implementation; replace it.
6. **Print next steps** to the user:
   ```
   cd <project-dir>
   npm install
   wdl deploy . --ns <ns>
   ```
   For `env-overrides-demo`, use `wdl deploy . --env preview --ns <ns>` or
   `wdl deploy . --env production --ns <ns>`.

## Anti-patterns

- ❌ Generating a worker from scratch when an example fits. Scaffolds drift
  faster than the canonical examples; copy first, adapt second.
- ❌ Mixing files from multiple examples without thinking about config
  conflicts. Pick one as the base; pull specific snippets (e.g. a
  `[triggers] crons = [...]` block) from others as needed.
- ❌ Renaming binding ids during scaffold. The user picks ids when they
  provision resources via `wdl d1 create`, `wdl secret put`, etc.
- ❌ Adding `[[platform_bindings]]` speculatively. Add only the bindings the
  worker actually calls.
- ❌ Leaving `"name": "<example-name>"` in `package.json` or wrangler config.
  Two workers with the same name collide on deploy.

## Deploy

```bash
npx wrangler deploy --dry-run --outdir=.deploy-dist       # bundle check
wdl deploy . --env preview --ns <ns>                      # env override preview
wdl deploy . --env production --ns <ns>                   # env override prod
```

`[[platform_bindings]]` only resolves on the wdl control plane — local runtimes
leave them `undefined`. Don't suggest `wrangler dev` for testing
platform-binding-using workers.
