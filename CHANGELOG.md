# Changelog

## Unreleased

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
