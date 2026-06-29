# Contributing

Thanks for helping improve the WDL CLI. This file is the contributor entrypoint;
`AGENTS.md` carries the full conventions and policies.

## Development setup

Requires Node.js 22 or newer.

```bash
git clone https://github.com/wdl-dev/cli.git
cd cli
npm install
npm link            # makes `wdl` resolve to your working tree
```

No control plane is needed for development: the entire test suite runs against
mocked dependencies, and most behavior (parsing, validation, formatting, `.env`
resolution) is exercisable offline. To try commands end to end, point
`--control-url` at any WDL control plane you operate.

## Architecture

The CLI is plain ESM JavaScript — no build step; `tsc --noEmit` typechecks the
JSDoc types under `strict`, so new code needs real JSDoc annotations on
parameters and returns (no implicit `any`).

| Path                                    | Role                                                                                                                                                                                                        |
| --------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bin/wdl.js`                            | Dispatcher. A `REGISTRY` of command modules derives both routing and the `wdl help` table from each command's `meta`; pre-scans argv so the `.env` namespace overlay sees the same `--ns` the command will. |
| `commands/*.js`                         | One file per command: an option schema plus a `run` body.                                                                                                                                                   |
| `lib/command.js`                        | The `defineCommand` framework: flag presets, `--help` short-circuit, dependency injection, and a `context` with `resolveControl` / `nsUrl` / `fetchJson` / `fetchStream`.                                   |
| `lib/common.js`                         | Control-URL/namespace/token resolution, sectioned `.env` loading with the endpoint trust guard, `CliError`, help formatting, terminal-escape choke point.                                                   |
| `lib/control-fetch.js`                  | HTTP client for the control plane: timeouts, body caps, streaming, Host/IPv6 handling.                                                                                                                      |
| `lib/wrangler-pack.js`, `lib/wrangler/` | Wrangler config parsing (TOML/JSONC), deploy manifest assembly, asset collection with `.assetsignore`, local bundling via `wrangler deploy --dry-run`.                                                      |
| `lib/*-format.js`                       | Per-command output formatters.                                                                                                                                                                              |

The life of a command: dispatcher routes argv → `defineCommand` parses flags and
resolves namespace/token/control URL → the run body calls the control plane
through `context.fetchJson` / `controlFetch` → a formatter renders the response
→ `writeResult` escapes terminal control sequences on the way out.

Two invariants to keep: **credentials never flow to an endpoint the user did not
explicitly choose** (no default control URL; `.env` endpoint trust guard), and
**anything the control plane or a worker can influence is escaped before
reaching the terminal**.

## Where to start

- Bug reports with a failing reproduction are the most valuable input.
- Wrangler config surface: new wrangler v4 fields appear regularly; parsers in
  `lib/wrangler-pack.js` either map or loudly reject them — silent drops are
  bugs.
- Windows behavior (wrangler resolution, paths) has dedicated handling and
  always needs more eyes.
- Docs: `docs/<feature>.md` pages and the bilingual GUIDE must match actual CLI
  behavior; mismatches are bugs worth filing or fixing.

## Checks

All of these run in CI on every pull request and must pass:

```bash
npm run lint
npm run typecheck
npm test
npm audit --audit-level=moderate
npm pack --dry-run
```

## Tests

Tests use `node:test` and `node:assert/strict` — no external test framework. Add
focused unit tests under `tests/unit/` following the `cli-*.test.js` pattern,
and keep them with their topic group inside the file. Mock `controlFetch`,
`env`, and `stdout` dependencies instead of touching the network. Demo hosts
follow a convention: `ctl.test` for the mock control plane, `ctl.<role>.example`
for control-URL literals, `*.workers.example` for runtime-side hosts.

## Documentation

`GUIDE.md` and `GUIDE-zh.md` are the user manual, and each `docs/<name>.md` has
a Chinese twin `docs/<name>-zh.md` — both languages are authoritative; update
the pair in the same change whenever CLI behavior changes.
`.claude/skills/wdl-deploy/SKILL.md` is derived from `GUIDE.md`; keep it in sync
when commands, flags, env vars, URL shapes, or destructive-command defaults
change.

## Commits and pull requests

Use short, imperative commit subjects (`Add queue parser validation`). Pull
requests should describe the user-visible change, list the tests run, and
include CLI output examples when output changes.

## Releases

Releases are tag-driven and cut by maintainers; see the Release section of
`AGENTS.md`. Never run `npm publish` by hand.

## Security issues

Do not open public issues for vulnerabilities — see
[SECURITY.md](./SECURITY.md).
