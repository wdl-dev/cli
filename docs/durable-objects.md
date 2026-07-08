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

For `ctx.storage.sql`, avoid application table names beginning with `_cf_`;
workerd reserves that prefix case-insensitively. `ctx.storage.deleteAll()` also
leaves platform-owned `_cf_*` tables alone.

## End-to-end example

`../examples/durable-objects-demo` — a same-worker `Room` Durable Object showing
an in-memory counter and a SQLite-backed storage counter.
