# Durable Objects — Same-Worker Stateful Objects

## What it is

WDL supports Durable Object classes inside the same Worker. Cross-script
bindings, `script_name`, rename/delete migrations, and platform-level WebSocket
session/cursor recovery are not implemented yet.

## Wrangler configuration

The DO class must be listed in `[[migrations]].new_classes` or
`[[migrations]].new_sqlite_classes`; on WDL both map to SQLite-backed DO
storage.

```toml
[[durable_objects.bindings]]
name = "ROOMS"
class_name = "Room"

[[migrations]]
tag = "v1"
new_classes = ["Room"]
```

## Session policy and facets

By default, promoting a new Worker version leaves already constructed DO facets
on the version that built them until the host actor restarts or the facet is
deleted. Open WebSockets keep draining on that version too, but only while their
backend stays healthy: once a backend is lost, WDL does not reconnect a version
that is no longer active — the WebSocket closes with code `1012`, and the client
must reconnect to reach the active version. Applications that want each
promotion to retire old-version sessions, and old-version facets on their next
dispatch, can opt in:

```toml
[wdl]
session_policy = "restart"
```

`session_policy` accepts `preserve` or `restart`; the default is `preserve`. It
applies when a new version is promoted, not while a bundle is only uploaded. The
policy is not Durable-Object-specific: it governs the worker's established
sessions, so a pure WebSocket worker without Durable Objects may also set it.

With `restart`, WDL aborts old-version facets on their next dispatch without
deleting SQLite state. Active HTTP/RPC calls may fail, and existing WebSockets
close with code `1012` at promotion instead of waiting for backend loss; clients
must reconnect and repeat their application handshake. The next invocation
constructs the active class version against the same persisted storage. This
matches Cloudflare's default behavior, where deploying new code restarts every
Durable Object. Alarms scheduled by a superseded version fire on the active
version instead; `preserve` keeps them on the version that scheduled them.

Promotion commits the policy atomically with the route change; a later
`preserve` promotion supersedes restart work that has not been observed yet, but
cannot undo a close or a facet abort that already happened. What a failed deploy
leaves behind, and how to recover from it, is in
[deploy.md](./deploy.md#common-errors).

## Worker code

```js
import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
  async fetch(request) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS hits (name TEXT PRIMARY KEY, value INTEGER NOT NULL)"
    );
    return Response.json({ id: String(this.ctx.id) });
  }
}

export default {
  async fetch(request, env) {
    const id = env.ROOMS.idFromName("main");
    return env.ROOMS.get(id).fetch(request);
  },
};
```

## Supported surface

Currently supported: `stub.fetch()`, JSON-structured `stub.method(...args)` RPC,
native `ctx.storage`, synchronous `ctx.storage.sql`, alarms, ordinary WebSocket
upgrade, and the native WebSocket hibernation API surface.

DO fetch request bodies are capped at 1 MiB. RPC method names must use
JavaScript identifier grammar and are capped at 256 ASCII bytes. RPC arguments
are capped at 1 MiB and must be structural JSON: finite numbers, strings,
booleans, null, dense arrays, and plain objects. Serialization does not call
`toJSON()`; sparse arrays, circular structures, non-plain objects, and other
non-JSON values are rejected before dispatch.

Object names and ids must be well-formed Unicode; lone UTF-16 surrogates are
rejected. DO class names use ASCII JavaScript class-name grammar and are capped
at 468 bytes.

For `ctx.storage.sql`, avoid application table names beginning with `_cf_`;
workerd reserves that prefix case-insensitively. `ctx.storage.deleteAll()` also
leaves platform-owned `_cf_*` tables alone.

## End-to-end example

`../examples/durable-objects-demo` — a same-worker `Room` Durable Object showing
an in-memory counter and a SQLite-backed storage counter.
