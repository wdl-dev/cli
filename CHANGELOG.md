# Changelog

## Unreleased

### Changed

- `wdl init`, examples, and docs now default new Wrangler configs to
  `compatibility_date = "2026-06-17"` for the documented feature baseline.
- `wdl deploy` now follows Wrangler config priority
  (`wrangler.json`, `wrangler.jsonc`, `wrangler.toml`) and parses both JSON
  filenames with Wrangler's JSONC syntax; the control plane remains canonical
  for runtime/workerd bundle errors, while the CLI still rejects cheap local
  cases like Python Worker modules and ambiguous runtime env name collisions
  between `[vars]`, explicit bindings, and the implicit `ASSETS` binding.
  Deploy also fails fast on unmapped Wrangler runtime/deploy keys such as
  `[site]`, `workers_dev`, `pages_build_output_dir`, `observability`, `limits`,
  and `placement` instead of silently dropping them.
- `wdl deploy` resolves Wrangler from `WDL_WRANGLER_BIN`, the Worker project's
  local install, the CLI package's bundled dependency, then `PATH`; `npx` stays
  opt-in via `WDL_ALLOW_NPX_WRANGLER=1`.
- Control requests now include a `wdl-cli/<version>` User-Agent and buffer JSON
  control responses up to 16 MiB by default.
- `CONTROL_CONNECT_HOST` now accepts `host:port`, bracketed or bare IPv6, and
  `http://` / `https://` override URLs, while rejecting blank hosts, non-http
  schemes, and invalid ports before opening a control connection. URL schemes
  choose the default TCP port; request transport still follows `CONTROL_URL`.
- `wdl tail` now recognizes control-initiated `session_idle` /
  `session_expired` stream recycling and reconnects without presenting it as an
  unknown warning.
- `wdl doctor --strict` now exits non-zero when any local or remote readiness
  check fails, while the default `wdl doctor` remains report-only.
- `wdl r2` preserves empty object-key path segments while still rejecting `.`
  and `..` segments, validates list `--limit` locally, and requires `--out`
  when `objects get` would otherwise write raw bytes to an interactive terminal.
- `wdl workflows status --step-limit` now requires `--include-steps`, matching
  the control request it affects.
- Top-level help for successful requests now prints to stdout, and
  `wdl help <command>` prints that command's help.
- When multiple Wrangler config files exist, deploy and D1 migrations now warn
  which file is selected by Wrangler priority and which lower-priority files are
  ignored; `wdl doctor` reports the same detail.

### Fixed

- Control connection failures, invalid 2xx JSON responses, unreadable
  project `.env` files, unreadable `wdl d1 execute --file` inputs, and
  unexpected positional arguments now fail with CLI errors instead of raw Node
  errors or silently ignored input.
- `wdl d1 migrations apply` now rejects symlinked `.sql` migration files instead
  of silently dropping them.
- `wdl deploy` now renders deploy warnings attached to failed upload responses,
  including missing caller-secret hints, before reporting the control error.
- Invalid `.assetsignore` patterns now report the offending pattern instead of
  a bare `RegExp` error.
- Project `.env` files with non-WDL dotenv extensions no longer break every WDL
  command; the four WDL-consumed keys remain strictly parsed.
- `wdl secret put/delete` no longer reports obsolete deferred-promote warnings;
  current worker-secret mutations either promote atomically or return a retryable
  control error.
- Secret mutation failures now add command-specific guidance for env-budget,
  contention, and secret-envelope errors, including that the failed mutation was
  not written.
- `wdl token list` now escapes credential labels and endpoints before rendering
  the human table output.

### Security

- `wdl token` credential writes now use a temp-file plus rename so an existing
  credentials symlink is replaced rather than followed.
- `wdl token set/use/rm` now serialize credential-store read-modify-write
  mutations with a recoverable lock, and credential-store temporary filenames
  are unguessable.
- Credential-store read and write failures now escape filesystem details before
  rendering CLI errors.
- `wdl tail` now caps SSE line buffering to avoid unbounded memory growth on a
  malformed stream.
- `wdl deploy` now registers process-exit and SIGINT/SIGTERM cleanup for its
  temporary Wrangler config file.

### Tests

- Live CLI integration now exercises assets, Durable Objects, queues, cron
  registration, and `wdl deploy --env` in addition to the existing command
  surface.

## 1.3.1

### Fixed

- Assets docs now show `await env.ASSETS.url(...)`, matching the runtime API and
  the example workers.

## 1.3.0

### Changed

- `wdl d1 execute` now requires exactly one SQL source (`--sql` or `--file`)
  and rejects empty SQL locally before contacting control. Even `--sql ""`
  conflicts with `--file`.
- `wdl deploy` now rejects more malformed Wrangler config locally instead of
  silently dropping invalid input: non-array `kv_namespaces`, malformed KV
  entries, present-but-non-table `[assets]`, and several validated fields that
  previously reached the manifest with loose types. Wrangler local-dev KV
  fields `preview_id` and `remote` remain allowed but are ignored by deploy.

## 1.2.2

### Security

- `wdl token set` and any other credential write now refuse a group- or
  world-writable store directory: a 0600 file there can still be deleted,
  replaced, or symlink-swapped by another user, so the write fails with a
  `chmod 700` hint instead. POSIX only.
- `wdl r2 object head --json` parses custom metadata without prototype
  pollution — an `x-amz-meta-__proto__` header stays an own key, and an empty
  `x-amz-meta-` header is dropped.

### Changed

- Docs and the npm description point at the now-public platform repo
  ([wdl-dev/wdl](https://github.com/wdl-dev/wdl)), frame the CLI as its
  companion, and add a self-host note.

## 1.2.1

### Changed

- `wdl d1 execute --mode exec` rejects `--params` locally before the control
  plane round-trip (any value, including `[]` and an empty string); an invalid
  non-exec `--params` now fails the JSON-array check instead of being silently
  dropped.
- A local deploy prints a direct `http://<ns>.<domain>:8080/<worker>/` URL
  instead of a `curl -H 'Host: ...'` hint, and a control plane reached via a
  `.test` / `.local` host is recognized as local (previously only
  localhost / 127.0.0.1).
- KV docs (GUIDE and `docs/kv.md`) describe the 512-byte key / list-prefix cap
  the platform now enforces; they previously said it was not checked. Documented
  that `wdl d1 execute --mode exec` takes no `--params`.

## 1.2.0

### Added

- `--no-token-store` (and `WDL_TOKEN_STORE=off`) resolves credentials from flags
  / env / `.env` only, never reading the global token store — for deploying
  less-trusted projects, or for deterministic credential resolution in CI.
- `wdl doctor` reports the global token store: how many namespaces it holds and
  that project build code can read it during a deploy.

### Changed

- Documentation now recommends the local token store (`wdl token set`) as the
  default way to supply a control URL and admin token, ahead of a per-shell
  export or a project `.env`.
- `CONTROL_CONNECT_HOST` is documented (GUIDE, the `wdl-deploy` skill) as a
  local-dev / debug-only override for the TCP connection target — the HTTP Host
  header and TLS SNI still track `CONTROL_URL`, and it must not be set
  persistently in a CI or production shell.

### Removed

- **Breaking:** top-level `allowed_callers` in `wrangler.toml` / `.jsonc` is no
  longer accepted. Cross-namespace service-binding access is declared on the
  **target** Worker via `[[exports]]` (`entrypoint = "default"` for the default
  handler, or the class name for a named entrypoint, with `allowed_callers`).
  `wdl deploy` now fails fast before bundling with the migration path, matching
  the control plane, which rejects a deploy carrying a worker-level
  `allowedCallers`. `[[exports]]`-based ACLs are unchanged.

### Security

- Control-plane error context keys are now escaped before printing, as the
  values already were. A malicious or compromised control plane could put
  terminal control bytes (ESC / OSC / C1) in a JSON error property name and have
  them written unescaped to stderr (OSC 52 clipboard writes, display spoofing).
- Control-plane responses now abort the connection when the body exceeds the
  10 MiB cap, instead of rejecting the result while continuing to read the
  stream — the cap bounds resource use, not just the returned value.
- The trusted-publishing release job pins the npm CLI to an exact reviewed
  version instead of installing `npm@latest`, so a compromised npm release can't
  run in the job that holds the npm OIDC token and publish a tampered,
  provenance-signed artifact.
- Documented that `wdl deploy` runs project-local build code as your OS user,
  which can read the on-disk token store (the environment scrub closes only the
  env path, not the file). Deploy only projects you trust; `--no-token-store`
  resolves credentials without reading the store. See `docs/token.md`.
- Bump the bundled `wrangler` to `^4.102.0`, which vendors a patched undici
  (7.28.0) and clears a high-severity advisory (TLS validation bypass / shared
  cache disclosure) reachable only through the miniflare dev server, which the
  CLI never runs.

## 1.1.0

### Added

- `wdl token set/list/use/rm` manages a local credential store at
  `~/.config/wdl/credentials` (`$XDG_CONFIG_HOME`/`%APPDATA%` honored), so
  commands resolve a control URL and token without a per-shell `ADMIN_TOKEN`
  export or a token in every project's `.env`. `set` reads the token from stdin
  (hidden on a TTY) and validates it against `/whoami` before storing it under
  the namespace; `rm` deletes the local copy without revoking it. The store is
  the same `dotenv`/INI dialect as a project `.env`, written `0600`, and is the
  lowest-precedence credential layer:
  `flag > shell env > project .env > token store`. It is trusted (home
  directory, same-source token + endpoint) and is not subject to the
  cross-origin `.env` guard, while a project `.env` endpoint is still dropped
  when the token comes from the store. `wdl config explain` shows
  `token store [<ns>].…` as a value's source.
- The store carries a default namespace (a base `WDL_NS`, the analogue of a
  project `.env`'s base `WDL_NS`): the first stored namespace becomes the
  default, `wdl token set --default` and `wdl token use <ns>` change it, and
  `wdl token list` marks it with `*`. With a default set, commands resolve a
  namespace without `--ns`; the selection chain is
  `--ns > shell WDL_NS > project .env WDL_NS > store default`, and
  `wdl config explain` shows `token store default` as the namespace source.

### Changed

- `wdl init`'s `--ns` is now optional. With `--ns`, the scaffolded `npm run
  deploy` keeps `wdl deploy . --ns <ns>`; without it the script is
  `wdl deploy .` and the namespace is resolved at deploy time (`--ns` / `WDL_NS`
  / project `.env` / a `wdl token` default). `init` also no longer autoloads
  control credentials, so a corrupt token store cannot block scaffolding.

### Removed

- **BREAKING:** the `--admin` flag and the `ADMIN_URL` environment variable —
  legacy compatibility aliases for the control endpoint — are removed. Use
  `--control-url <url>` and the `CONTROL_URL` environment variable instead.
  `--admin` is now an unknown option and `ADMIN_URL` is no longer read from the
  shell or `.env`.

### Fixed

- `wdl secret put` no longer echoes the typed secret on a TTY: input is read in
  raw mode (hidden), and fails closed — it errors rather than echo if the
  terminal cannot hide input.
- `.env` values containing literal backslash escape sequences (e.g. a token
  with a backslash followed by `n`) now round-trip correctly instead of being
  decoded as control characters.

### Security

- Pinned `ws` to `^8.21.0` via npm `overrides` to clear GHSA-96hv-2xvq-fx4p in
  the `wrangler` → `miniflare` → `ws` dependency chain, keeping `wrangler` on
  v4. The DoS is reachable only through miniflare's dev server, which the CLI
  never starts (it only runs `wrangler deploy --dry-run`), but the pin keeps the
  dependency tree clean.

## 1.0.0

Initial open-source release.

- `wdl init` scaffolding for new WDL Worker projects, with bundled examples
  covering assets, KV, D1, R2, cron triggers, queues, Durable Objects,
  Workflows, and environment overrides.
- `wdl deploy` for Wrangler v4 projects: local bundling, manifest validation,
  upload, and promote against the WDL control plane.
- Resource management commands: `wdl d1`, `wdl r2`, `wdl secret`, `wdl workers`,
  `wdl workflows`, `wdl delete`.
- Diagnostics: `wdl config explain`, `wdl doctor`, `wdl whoami`, and live log
  streaming via `wdl tail`.
