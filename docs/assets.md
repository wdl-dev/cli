# Assets — CDN static files

## What it is

Files under the configured directory (usually `./public`) are uploaded to S3 at
deploy time and served by the CDN. The Worker gets the CDN URL by awaiting
`env.ASSETS.url(path)`.

The config field follows Cloudflare Workers Assets' `assets.directory` shape,
but the runtime currently implements URL generation only — not Workers Assets
request interception or `fetch()` reads.

## When to use

- Static HTML / CSS / JS / images / fonts shipped with the worker.
- An SPA's build output directory (e.g. Vite's `dist/`).
- Any file the worker wants to hand out a CDN URL for.

For dynamic blobs **uploaded at runtime**, use R2 — see [r2.md](./r2.md). Assets
are immutable per deploy; R2 is read-write storage.

## Wrangler configuration

```jsonc
{
  "assets": {
    "directory": "./public"
  }
}
```

Or in `wrangler.toml`:

```toml
[assets]
directory = "./public"
```

The directory path is relative to the wrangler config file. Files under the
directory are uploaded as-is; subdirectories keep their structure in the CDN
URL.

The deploy manifest JSON is capped at 32 MiB. Assets are embedded into that JSON
request as base64 (~4/3 inflation) during deploy, so a large asset set can hit
the control request cap first. The CLI additionally pre-checks before upload: 25
MiB per file, 100 MiB total. Use R2 for bulk, runtime-uploaded, or frequently
changing files — see [r2.md](./r2.md).

By default the CLI does not upload `.git/`, `node_modules/`, `.DS_Store`,
`.wrangler/`, `.deploy-dist/`, `.wrangler.wdl-tmp*.json`, `.env*`, `.dev.vars*`,
or `.wdl-empty.env` from the assets directory; deploy prints a one-line note
listing what was skipped. To exclude more files, add a gitignore-syntax
`.assetsignore` file to the assets directory (`!pattern` negation rules are
supported, so you can deliberately re-include one of the defaults) — the same
mechanism Cloudflare Workers Assets uses. The CLI collects assets after
bundling, so Wrangler's dry-run does not scan the directory as assets. The
`.assetsignore` file itself is also not uploaded by default.

## Worker-side usage

```js
export default {
  async fetch(request, env, ctx) {
    // Get the CDN URL for a file
    const cssUrl = await env.ASSETS.url("/styles.css");
    // → "https://cdn.<...>/styles.css" (or similar — the host is decided by the platform)

    return Response.json({ cssUrl });
  },
};
```

`await env.ASSETS.url(path)` is the common usage — embed the URL into HTML or
JSON responses and let browsers go straight to the CDN.

## URL placeholders in HTML pages

If the HTML page you serve references CSS / JS bundles, build the asset URLs
with `await env.ASSETS.url(...)` when the Worker returns the HTML. See
`../examples/pages-assets` and `../examples/inspection-demo` for working
patterns.

## Do not write `assets.run_worker_first`

The platform silently ignores `run_worker_first`. Do not add it; the worker
always sees the request first.

## Build output

If the assets are built (e.g. an SPA), the build output lands in the configured
directory. **Do not commit build output to git** — add it to `.gitignore` and
run the build before `wdl deploy`. For example:

```
# .gitignore
public/
```

…then generate that directory with the project's own build command, e.g.
`npm run build` for a Vite/React project. The WDL CLI does not guess or run
frontend build commands automatically.

## Anti-patterns

- ❌ Putting files that change at runtime, or large file sets, in assets. Assets
  are immutable per deploy and bounded by the 32 MiB deploy manifest cap. Use R2
  — see [r2.md](./r2.md).
- ❌ Adding `assets.run_worker_first`. It is silently ignored.
- ❌ Renaming `assets.binding` from `ASSETS`, or setting Cloudflare-only
  `html_handling` / `not_found_handling`. The CLI rejects these instead of
  deploying a Worker with different asset behavior.
- ❌ Hardcoding the CDN host in source. Always go through
  `await env.ASSETS.url(...)`.
- ❌ Committing build output to git. Generate it at deploy time.

## End-to-end examples

`../examples/pages-assets` — minimal HTML page + static assets.
`../examples/inspection-demo` — assets combined with D1 + KV + R2.
`../examples/env-overrides-demo` — shows how `[env.<name>.assets]` overrides the
top-level assets directory.

## Related

- [r2.md](./r2.md) — blobs uploaded at runtime.
- [env-overrides.md](./env-overrides.md) — different asset directories per
  environment.
