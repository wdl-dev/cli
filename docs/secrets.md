# Secrets — `wdl secret` reference

## What it is

Runtime secrets are key-value pairs the worker reads at request time; they are
not packed into the bundle. Set them with `wdl secret put`; the worker reads
them through `env.<KEY>`.

Do not put secrets in `[vars]` — `[vars]` values are part of the bundle and
visible to anyone with read access.

## When to use

- API keys, tokens, signing keys — anything that must not appear in a git diff
  or build output.

Put non-sensitive configuration (greeting strings, feature flags, public URLs)
in `[vars]` in `wrangler.json` / `wrangler.jsonc` / `wrangler.toml`.

## Set

```bash
# Worker-level (most common). Promotes a new version; new traffic cold-loads the updated value.
printf '%s' "$VAL" | wdl secret put --worker <worker-name> KEY

# Namespace-level (shared). Takes effect at the next natural cold-load — it does
# **not** bump every worker. Use sparingly, only when the value really should be
# shared by every worker in the namespace.
printf '%s' "$VAL" | wdl secret put --scope ns KEY
```

Use `printf '%s'` (not `echo`) to avoid a trailing newline at the end of the
secret value.

## List and delete

```bash
wdl secret list --worker <worker-name>
wdl secret list --scope ns

wdl secret delete --worker <worker-name> KEY
wdl secret delete --scope ns KEY
```

When automation needs the raw control response, `list` / `put` / `delete` all
accept `--json`. `wdl secret delete` prompts for confirmation by default. Run
`wdl secret list` first to make sure you have the right key; do **not** add
`--yes` on your own.

## Runtime precedence

```
worker-level secret  >  namespace-level secret  >  [vars]
```

For a duplicate key, the worker-level secret overrides the namespace-level one.
A same-named `[vars]` entry is shadowed by both kinds of secret.

Changing a worker-level secret creates and promotes a new version, but
already-loaded historical versions can keep holding the old value until runtime
eviction or recycle. When strict revocation matters, also consider disabling the
old credential.

Worker-level secret mutations are atomic: if the active version changes during
the update, control returns `secret_mutation_contention` and the CLI asks you to
retry instead of leaving a stored-but-not-promoted partial update. Namespace
secret mutations can similarly return `namespace_secret_mutation_contention`
when retained worker metadata keeps changing.

If a secret mutation returns `secret_encryption_unconfigured`,
`secret_decrypt_failed`, `invalid_envelope`, `unsupported_envelope`,
`unknown_kid`, or `secret_not_encrypted`, the mutation was not written. These
are operator-side secret-envelope configuration or stored-data repair problems;
retry after the operator reports the envelope issue repaired.

## Constraints

- Keys must follow environment-variable grammar: `[A-Z_][A-Z0-9_]*` — e.g.
  `STRIPE_KEY`, `API_TOKEN`, `SIGNING_SECRET`.
- Values are limited to 64 KiB.
- Secrets count toward the workerLoader env budget together with `[vars]` and
  binding metadata. If a mutation returns `worker_env_too_large`, reduce the
  env payload or redeploy/delete the retained version named in the error.

## Reading in the Worker

```js
export default {
  async fetch(request, env) {
    const stripeKey = env.STRIPE_KEY;       // worker-level or ns-level
    // ...
  },
};
```

## Anti-patterns

- ❌ `[vars] = { STRIPE_KEY = "sk_live_..." }`. `[vars]` goes into the bundle.
  Use `wdl secret put`.
- ❌ Hardcoding third-party API tokens in `.env` or Wrangler config. Push them
  with `wdl secret put`.
- ❌ Adding `--yes` to `wdl secret delete` without running `wdl secret list`
  first and confirming with the user.
- ❌ Using `echo "$VAL" |` instead of `printf '%s' "$VAL" |`. `echo` appends a
  newline, which gets written into the secret value.
- ❌ Expecting a namespace-level secret to take effect on every worker
  immediately. It does not — it takes effect at the next cold-load. For
  "effective now", use a worker-level secret.

## Related

- [deploy.md](./deploy.md) — `ADMIN_TOKEN` (the deploy credential, not a runtime
  secret).
