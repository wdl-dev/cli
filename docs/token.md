# Tokens — `wdl token` reference

English | [中文](./token-zh.md)

## What it is

`wdl token` manages a local credential store at `~/.config/wdl/credentials`
(`$XDG_CONFIG_HOME/wdl/credentials`, or `%APPDATA%\wdl\credentials` on Windows)
so commands resolve a control URL and token without a per-shell `ADMIN_TOKEN`
export or a token in every project's `.env`.

There is no "login". A WDL token is issued by your operator; `wdl token set`
just stores it (after checking it against `/whoami` and confirming its principal
is the namespace you are storing it under), and `wdl token rm` deletes the local
copy — it does not revoke the token.

The store is the same `dotenv`/INI dialect a project `.env` uses, keyed by
namespace, with each entry self-contained. A base `WDL_NS` line (before any
section) names the default namespace — the one used when you do not pass `--ns`
— exactly as a base `WDL_NS` works in a project `.env`:

```ini
WDL_NS="acme"

[acme]
CONTROL_URL="https://api.example"
ADMIN_TOKEN="<token>"
LABEL="production"
```

It is command-owned: `wdl token` rewrites it canonically (default first, then
sorted, quoted sections), so hand-edit a project `.env` for project-specific
values instead. The file is written with `0600` permissions.

## Commands

```bash
# Store a token. The token is read from stdin (hidden on a TTY), validated
# against /whoami, checked to belong to --ns, then stored. The control URL comes
# from --control-url or CONTROL_URL — never from the store itself. The first
# stored namespace becomes the default; --default makes any set the default.
wdl token set --ns acme --control-url https://api.example
wdl token set --ns acme --control-url https://api.example --label production
wdl token set --ns demo --control-url https://api.example --default
printf '%s' "$TOKEN" | wdl token set --ns acme --control-url https://api.example

# List stored namespaces with masked tokens; the default is marked with *
# (--json for scripting; each row carries a "default" boolean, still masked).
wdl token list

# Choose which stored namespace is the default (used when --ns is omitted).
wdl token use acme

# Remove the local copy for a namespace (does not revoke on the control plane).
wdl token rm --ns acme
```

## Where it sits in resolution

The store is the lowest-precedence credential layer:

```
CLI flag > shell/CI env > project ./.env > global token store > unset (error)
```

A value from a higher layer always wins; the store only fills gaps. Resolution
is per namespace: a namespace selects the entry, which supplies both the control
URL and the token. `wdl config explain` shows `token store [<ns>].…` as the
source when a value came from the store.

Which namespace is selected follows its own chain, with the store's default at
the bottom — the same shape, one layer lower than a project `.env`'s base
`WDL_NS`:

```
--ns > shell/CI WDL_NS > project ./.env WDL_NS > store default (base WDL_NS)
```

So with a stored default you can run `wdl deploy`, `wdl doctor`, etc. without
`--ns`; pass `--ns` (or `wdl token use <ns>`) to pick a different one. When the
namespace comes from the store default, `wdl config explain` shows the source as
`token store default`.

The `wdl token` subcommands are the exception to that chain: `set`, `use`, and
`rm` mutate the store, so they take the namespace from an explicit `--ns` (or
`use`'s positional) only — never the ambient `WDL_NS` — so a stray shell value
can't write, switch, or delete the wrong entry.

The store is trusted (it lives in your home directory and you wrote it via
`wdl token`, so its token and endpoint are same-source). A project `.env` is
not: a `.env` that supplies a control endpoint without also supplying the token
is still dropped, so an untrusted project directory can never redirect your
stored token to a host it chose.

## Anti-patterns

- ❌ Treating `wdl token rm` as revocation. It deletes the local copy only; the
  token still works until your operator revokes it.
- ❌ Hand-editing `~/.config/wdl/credentials`. It is rewritten on the next
  `wdl token` write and your edits (including comments) are lost. Use a project
  `.env` for hand-managed overrides.
- ❌ Passing the token as a command-line argument. `set` reads it from stdin so
  it stays out of shell history; type it at the prompt or pipe it in.
- ❌ Expecting the store to override a token already set in your shell or a
  project `.env`. It is the lowest layer and only fills gaps.

## Related

- [deploy.md](./deploy.md) — `ADMIN_TOKEN` / `CONTROL_URL` precedence and the
  `.env` layout the store sits beneath.
- [secrets.md](./secrets.md) — `wdl secret`, for a worker's runtime secrets (a
  different thing from the deploy token managed here).
