# KV — small key/value store

## What it is

Namespace-level key/value storage, accessed in the worker through
`env.<NAMESPACE>` with `get` / `getWithMetadata` / `put` / `list` / `delete`.
Batch `get` / `getWithMetadata` for text/json values is supported, as are
expirations like `put(..., { expirationTtl })` / `put(..., { expiration })`.
Single-key `get` supports the text, json, arrayBuffer, and stream result shapes;
batch reads support text/json values only. The main differences from Cloudflare
KV: writes are visible immediately, and `list()` does not guarantee
lexicographic order.

## When to use

- Counters, flags, small per-user state, cache entries.
- Anywhere a single key + value fits comfortably in a few KB.

For relational data use D1 — see [d1.md](./d1.md). For large blobs use R2 — see
[r2.md](./r2.md).

## Wrangler configuration

```toml
[[kv_namespaces]]
binding = "VISITS"
id = "visits"
```

Or in `wrangler.jsonc`:

```jsonc
{
  "kv_namespaces": [
    { "binding": "VISITS", "id": "visits" }
  ]
}
```

`binding` is the name exposed at runtime (`env.VISITS`). `id` is a
**platform-local namespace id** — a short string, **not** a Cloudflare UUID. The
CLI puts this binding into the uploaded manifest as-is.

KV namespaces are **lazy** — there is no pre-creation step. The binding works on
first use.

## Reading and writing in the Worker

```js
export default {
  async fetch(request, env, ctx) {
    // GET — returns null when missing
    const raw = await env.VISITS.get("count");
    const count = raw === null ? 0 : Number(raw);

    // PUT
    await env.VISITS.put("count", String(count + 1));
    await env.VISITS.put("flash", "ok", { expirationTtl: 60 });

    // automatic type conversion
    const obj = await env.VISITS.get("user:42", { type: "json" });
    const buf = await env.VISITS.get("user:42:avatar", { type: "arrayBuffer" });
    const stream = await env.VISITS.get("user:42:avatar", { type: "stream" });
    const many = await env.VISITS.get(["user:42", "user:43"], { type: "json" });

    // LIST — paginated
    const page = await env.VISITS.list({ prefix: "user:", limit: 100 });
    const pageWithMeta = await env.VISITS.list({ prefix: "user:", metadata: true });

    // DELETE
    await env.VISITS.delete("count");

    return Response.json({ count: count + 1 });
  },
};
```

### Differences from Cloudflare KV

KV writes on this platform are visible immediately; a worker reading its own
write right after should see the new value. Do not design for delayed visibility
based on Cloudflare KV's global eventual-consistency semantics.

`list()` supports `prefix`, `limit`, and `cursor` pagination, plus
`list({ metadata: true })` to return per-key metadata without reading full
values. Return order is not guaranteed to be lexicographic; the cursor is an
opaque WDL cursor and must be passed back verbatim. `limit` is a target page
size capped at 1000; the response does not include a total count. When you need
stable ordering, sort the returned keys on the application side.

KV values are capped at 25 MiB before proxying, and keys (and list prefixes) are
capped at 512 bytes, matching Cloudflare KV's limit — a longer key fails with
`KV key exceeds 512 byte limit`.

When you need to keep a small amount of extra information alongside a value,
`put(..., { metadata })`, `getWithMetadata()`, and `list({ metadata: true })`
are also supported; plain counters, flags, and caches do not need them. When a
key with `expirationTtl` or `expiration` expires, the value and metadata
disappear together; putting the key again without an expiration clears the
previous expiration.

`get(..., { cacheTtl })` is accepted as a Cloudflare KV API shape, but there is
currently no Cloudflare edge read cache and no global eventual-consistency
window; `cacheTtl` does not change WDL KV read behavior.

## Anti-patterns

- ❌ Storing relational data in KV. list+filter does not scale; D1 exists for
  exactly this.
- ❌ Putting large blobs in KV (near or above 25 MiB). Use R2 — see
  [r2.md](./r2.md).
- ❌ Depending on `list()` return order. Sort yourself when you need stable
  order.
- ❌ Pre-creating the namespace before deploy. KV is lazy — add the
  `[[kv_namespaces]]` entry and deploy.

## End-to-end examples

`../examples/kv-demo` — minimal counter. `../examples/cron-demo` — KV tracking
the last cron tick. `../examples/queues-demo` — KV storing queue consumption
results. `../examples/inspection-demo` — KV combined with D1 / R2 / assets.

## Related

- [d1.md](./d1.md) — relational data.
- [r2.md](./r2.md) — large blobs.
