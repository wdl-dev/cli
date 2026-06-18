# Changelog

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
