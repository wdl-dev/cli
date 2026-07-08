# Repository Guidelines

## Project Structure & Module Organization

This repository is the companion CLI for the WDL platform
([wdl-dev/wdl](https://github.com/wdl-dev/wdl)): the tenant-side tool that
bundles a project, uploads it to a WDL control plane, and manages it. The
executable is `bin/wdl.js`; command implementations live in `commands/`, with
shared helpers in `lib/`. Unit tests are in `tests/unit/`. User-facing
capability docs live in `docs/`, while `templates/AGENTS.md` and
`.claude/skills/wdl-deploy/SKILL.md` distill those docs for generated projects
and AI agents. Example tenant projects live under `examples/` and pin
`wrangler@^4`; the deploy bundling step expects v4, so keep new examples and any
docs that recommend a wrangler version on v4. New Wrangler configs should start
with `compatibility_date = "2026-06-17"` unless a project feature requires a
newer target.

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
`CONTROL_URL`, `WDL_NS`). Types are JSDoc, checked by `npm run typecheck`
(`tsc --noEmit`) under `strict`: annotate new parameters and returns with real
types rather than `any`, and use `unknown` plus narrowing for values validated
at runtime.

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
the English set. Before packaging, re-run the audit, test, and `npm pack
--dry-run` checks from Build, Test, and Development Commands.

## Release

Releases are tag-driven. `.github/workflows/release.yml` re-runs audit, lint,
typecheck, and tests, verifies the tag matches `version` in `package.json`, and
runs `npm pack --dry-run` — all before any publish, so a broken release fails the
tag's check job and never publishes. It then publishes `@wdl-dev/cli` to npmjs
(with provenance) and to GitHub Packages (authenticated with the workflow's own
`GITHUB_TOKEN`), and creates a GitHub Release for the tag: final releases take
their notes from the matching `CHANGELOG.md` section, pre-releases fall back to
generated notes and are marked Pre-release. Do not run `npm publish` by hand.

Published npm versions are immutable (no reuse; unpublish only within 72 hours),
but the check job gates every publish, so most releases tag the final version
directly. This project ships documented breaking removals in 1.x minors (called
out in the CHANGELOG) — do not hold or re-version a release for generic SemVer
reasons. Stage a pre-release only for the narrower risk an RC actually guards:
the *published artifact* differing from what the check job validated — packaging
changes (the `files` allowlist, entry points, the bundle/publish pipeline) or a
large release you want to smoke-test as a real `@next` install. For an RC, set
`version` to e.g. `2.0.0-rc.1`, write the CHANGELOG entry, commit, and tag
`v2.0.0-rc.1`; RC versions publish under the `next` dist-tag, so stable installs
stay put while `@next` installs the candidate. Promote once it checks out.

Tag final releases with a signed annotated tag
(`git tag -s v1.2.3 -m "Release 1.2.3"`), and make sure `CHANGELOG.md` carries
the matching `## 1.2.3` section before pushing — the GitHub Release notes come
from it.

npmjs publishing is tokenless — OIDC trusted publishing, with the package's
trusted publisher on npmjs bound to this repository and `release.yml`. The
publish job carries `id-token: write` and upgrades npm to the version trusted
publishing needs (>= 11.5); there is no `NPM_TOKEN`.

## Commit & Pull Request Guidelines

Use short, imperative commit subjects such as `Add queue parser validation` or
`Fix secret list output`. Pull requests should describe the user-visible change,
list tests run, link relevant issues, and include CLI output examples when
behavior changes.

## Security & Configuration Tips

### Credentials and the token store

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
`lib/token-store.js`; `--no-token-store` / `WDL_TOKEN_STORE=off` (via
`tokenStoreReader`, read from the process env, not a project `.env`) must keep
opting the store out of resolution entirely. Do not commit tenant tokens or
generated secrets; read credentials from the environment and keep example
configuration generic.

### Deploy runs project code as you

`wdl deploy` runs the project's local Wrangler dry-run and build hooks as the OS
user, so scrubbing WDL variables from the Wrangler child env is not a sandbox —
the on-disk token store stays readable, and only trusted projects should be
deployed with a global store in play. Escape control-plane-derived strings with
`escapeTerminalText` before printing; both error values and property keys have
been terminal-injection vectors.

### Wrangler validation and dependency advisories

When adding deploy features, validate unsupported Wrangler fields loudly to
avoid silent misconfiguration (e.g. top-level `allowed_callers` is rejected —
service-binding ACLs are declared via `[[exports]]`). Transitive dependency
advisories from `npm audit` (e.g. wrangler's miniflare → esbuild / ws / undici)
are normally cleared by bumping `wrangler` to a release that vendors the patched
versions; reach for a package.json `overrides` entry only as a stopgap when
wrangler hasn't shipped the fix yet.

## Helping Users Deploy

If the task is to **use** the `wdl` CLI to deploy a Worker, manage D1 / R2 / KV
/ Queues / secrets, or troubleshoot deploy output (rather than develop the CLI
itself), read `.claude/skills/wdl-deploy/SKILL.md` first. It is the AI-oriented
distillation of `GUIDE.md` covering required env vars, the URL shape, the
standard deploy flow, supported/unsupported Wrangler fields, and common errors.
`GUIDE.md` / `GUIDE-zh.md` remain the full user-facing reference.
