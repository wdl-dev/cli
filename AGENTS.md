# Repository Guidelines

## Project Structure & Module Organization

This repository is the tenant CLI for the WDL platform. The executable is
`bin/wdl.js`; command implementations live in `commands/`, with shared helpers
in `lib/`. Unit tests are in `tests/unit/`. User-facing capability docs live in
`docs/`, while `templates/AGENTS.md` and `.claude/skills/wdl-deploy/SKILL.md`
distill those docs for generated projects and AI agents. Example tenant projects
live under `examples/` and pin `wrangler@^4`; the deploy bundling step expects
v4, so keep new examples and any docs that recommend a wrangler version on v4.
New Wrangler configs should start with `compatibility_date = "2026-05-31"`
unless the WDL runtime moves again.

## Build, Test, and Development Commands

- `npm install`: install dependencies from `package-lock.json`.
- `npm link`: expose the local `wdl` binary for manual testing.
- `npm run lint`: run ESLint over the CLI, docs helpers, and examples.
- `npm run typecheck`: run TypeScript's JavaScript-aware `tsc --noEmit` check.
- `npm test`: run Node's built-in test runner against
  `tests/unit/cli-*.test.js`.
- `npm audit --audit-level=moderate`: match the GitHub Actions dependency gate.
- `npm pack --dry-run`: inspect package contents; `files` intentionally excludes
  tests and `AGENTS.md`.
- `wdl deploy examples/hello-jsonc --ns <namespace>`: smoke-test deployment
  behavior with a sample project, with `CONTROL_URL` and `ADMIN_TOKEN`
  configured — the CLI has no default endpoint.

Use Node.js 22 or newer for local work. The GitHub Actions workflow uses Node
22, runs `npm ci`, `npm audit --audit-level=moderate`, `npm run lint`,
`npm run typecheck`, `npm test`, and `npm pack --dry-run`, then checks workflow
syntax with actionlint.

## Coding Style & Naming Conventions

Use JavaScript ESM with `import`/`export`. Match the existing style: two-space
indentation, double quotes, semicolons, and small named functions. Prefer
dependency injection for testable command behavior, as seen in
`runDeployCommand` and `runSecretCommand`. Use kebab-case CLI flags
(`--control-url`) and uppercase environment variables (`ADMIN_TOKEN`,
`CONTROL_URL`, `WDL_NS`).

Markdown wrapping is bilingual by design, normalized with Prettier
(`--embedded-language-formatting=off`; code blocks are hand-formatted) and kept
by editing habit rather than a linter: English prose hard-wraps at 80 columns
(`--prose-wrap always`), while Chinese prose never hard-wraps inside a sentence
(`--prose-wrap never`, one line per paragraph) because CommonMark renders a soft
break as a space and CJK text would pick up spurious mid-sentence spaces.
Tables, code blocks, and long URLs are exempt; there is no line-length lint,
since table rows would trip it.

## Testing Guidelines

Tests use `node:test` and `node:assert/strict`; no external test framework is
configured. Add focused unit tests under `tests/unit/` using the `cli-*.test.js`
pattern. Prefer mocked `controlFetch`, `env`, and `stdout` dependencies over
network calls. Cover parser edge cases, argument validation, output formatting,
and control-plane URL construction.

## Documentation Sync Policy

`GUIDE.md` and `GUIDE-zh.md` are the full user-facing manual; update them in the
same change whenever CLI behavior changes, and keep the two language versions
aligned. The AI-oriented distillation at `.claude/skills/wdl-deploy/SKILL.md` is
derived from `GUIDE.md` — update it whenever commands, flags, env vars,
supported/unsupported Wrangler fields, URL shapes, or destructive-command
defaults change. The per-feature docs are bilingual pairs — `docs/<name>.md`
(English) and `docs/<name>-zh.md` (Chinese) — and both languages are
authoritative: update the pair in the same change. Agent-facing references
(`templates/AGENTS.md`, the wdl-deploy skill, generated projects) point only at
the English set. Before packaging, run `npm audit --audit-level=moderate`,
`npm test`, and `npm pack --dry-run`.

## Release

Releases are tag-driven, and the release workflow refuses a tag that does not
match `version` in `package.json`. Published npm versions are immutable
(unpublish is limited to 72 hours and a version number can never be reused), so
stage every release through a pre-release candidate and never burn the final
version on a rehearsal:

1. Set `version` in `package.json` to the candidate (e.g. `1.0.0-rc.1`), write
   the CHANGELOG entry, commit, then tag and push:

   ```bash
   git tag v1.0.0-rc.1
   git push origin v1.0.0-rc.1
   ```

   Pre-release versions publish under the `next` dist-tag, so
   `npm i -g @wdl-dev/cli` keeps resolving to the last stable release while
   `@next` installs the candidate.

2. When the candidate checks out, bump `version` to the final release (e.g.
   `1.0.0`), commit, tag `v1.0.0`, and push the tag.

`.github/workflows/release.yml` re-runs audit, lint, typecheck, and tests,
verifies the tag matches `package.json`, then publishes `@wdl-dev/cli` to npmjs
(with provenance) and to GitHub Packages (authenticated with the workflow's own
`GITHUB_TOKEN`). It finishes by creating a GitHub Release for the tag: final
releases take their notes from the matching `CHANGELOG.md` section, pre-releases
fall back to generated notes and are marked Pre-release. Do not run
`npm publish` by hand.

Tag final releases with a signed annotated tag
(`git tag -s v1.2.3 -m "wdl-cli 1.2.3"`), and make sure `CHANGELOG.md` carries
the matching `## 1.2.3` section before pushing — the GitHub Release notes come
from it.

npmjs publishing is tokenless — OIDC trusted publishing, with the package's
trusted publisher on npmjs bound to this repository and `release.yml`. The
publish job carries `id-token: write` and upgrades npm to the version trusted
publishing needs (>= 11.5); there is no `NPM_TOKEN`.

## Commit & Pull Request Guidelines

The Git history is currently short, so no detailed local convention has emerged
yet. Use short, imperative commit subjects such as `Add queue parser validation`
or `Fix secret list output`. Pull requests should describe the user-visible
change, list tests run, link relevant issues, and include CLI output examples
when behavior changes.

## Security & Configuration Tips

Credential resolution layers, highest precedence first: CLI flags, shell/CI env,
the project `./.env` (sectioned by namespace, with a cross-origin guard that
drops a `.env`-supplied endpoint when the effective token is not from the same
`.env`), then the global token store (`~/.config/wdl/credentials`, managed by
`wdl token`). The store is trusted (home directory, same-source token +
endpoint) and not subject to the guard; a project `.env` is not. The namespace
itself follows the same shape — `--ns > shell WDL_NS > project .env WDL_NS >
store default (base WDL_NS)` — so the store's default namespace is the lowest
selector, materialized into `env.WDL_NS` before the per-key gap-fill. Keep that
ordering and the guard intact when touching `loadCliControlEnv` or
`lib/token-store.js`.

Do not commit tenant tokens or generated secrets. Read credentials from the
environment (`ADMIN_TOKEN`, `CONTROL_URL`, `WDL_NS`) and keep example
configuration generic. When adding deploy features, validate unsupported
Wrangler fields loudly to avoid silent misconfiguration. The `overrides` entry
in package.json lifts wrangler's transitive esbuild onto a patched line
(GHSA-gv7w-rqvm-qjhr, GHSA-g7r4-m6w7-qqqr); drop the override once wrangler
ships esbuild >= 0.28.1.

## Helping Users Deploy

If the task is to **use** the `wdl` CLI to deploy a Worker, manage D1 / R2 / KV
/ Queues / secrets, or troubleshoot deploy output (rather than develop the CLI
itself), read `.claude/skills/wdl-deploy/SKILL.md` first. It is the AI-oriented
distillation of `GUIDE.md` covering required env vars, the URL shape, the
standard deploy flow, supported/unsupported Wrangler fields, and common errors.
`GUIDE.md` / `GUIDE-zh.md` remain the full user-facing reference.
