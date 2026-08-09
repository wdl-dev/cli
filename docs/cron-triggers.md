# Cron triggers — scheduled handlers

## What it is

Runs the `scheduled(event, env, ctx)` handler on a cron schedule. The platform
invokes the handler at the configured cadence; no external scheduler is needed.

## When to use

- Periodic sync, polling, cleanup, batch jobs.
- Anything you would run with cron on a server.

To trigger in response to requests, use the `fetch` handler. To react to queue
messages, see [queues.md](./queues.md).

## Wrangler configuration

```toml
[triggers]
crons = ["*/5 * * * *", "0 0 * * *"]
```

Or in `wrangler.jsonc`:

```jsonc
{
  "triggers": {
    "crons": ["*/5 * * * *", "0 0 * * *"]
  }
}
```

The cron format is the standard 5-field `min hour dom mon dow`. **UTC by
default.**

When you need per-schedule timezone control, use `[[triggers.schedules]]` (a
platform extension):

```toml
[[triggers.schedules]]
cron = "0 9 * * MON-FRI"
timezone = "Asia/Shanghai"
```

Both `[triggers]` and `[[triggers.schedules]]` are supported; pick one.

Wrangler 4.118+ also recognizes `triggers.events` for Cloudflare Artifacts
Workflow subscriptions. WDL does not implement that control/runtime contract, so
deploy rejects the field instead of silently dropping its subscriptions.

Cron triggers are a runtime dispatch capability. Unless your operator has
explicitly given you a reserved namespace, declare them only on routeable
Workers in tenant namespaces. Workers selected through `[[platform_bindings]]`
are cold-loaded platform capabilities, not public/runtime dispatch targets, and
cannot declare cron triggers.

## Handler signature

```js
export default {
  async scheduled(event, env, ctx) {
    // event.cron — the cron string that matched
    // event.scheduledTime — epoch milliseconds
    // ctx.waitUntil(...) — keep a promise running after the handler returns
    console.log("[cron]", event.cron, "fired at", new Date(event.scheduledTime).toISOString());

    // Do the work
    await env.STATE.put("last_tick", String(Date.now()));
  },

  async fetch(request, env, ctx) {
    // Optional — a worker can have both fetch and scheduled
    return new Response("hello");
  },
};
```

`event.cron` is exactly the string from the wrangler config. Use it to dispatch
when one worker handles multiple crons.

## Combining with other features

The cron handler is just a worker — `env` is shared with `fetch`. Common
combinations:

- **cron + KV**: track last-fire state. See `../examples/cron-demo`.
- **cron + D1**: periodic bulk INSERTs / cleanup. See [d1.md](./d1.md).
- **cron + R2**: scheduled archiving or cleanup of stored objects. See
  [r2.md](./r2.md).

## Anti-patterns

- ❌ Returning from `scheduled` while async work is still in flight. The runtime
  cancels unfinished promises. Use `ctx.waitUntil(promise)` to extend execution.
- ❌ Pairing a `fetch` handler with the cron and expecting it to "wake" it. The
  two run independently; there is no shared in-memory state.
- ❌ Hardcoding schedule times in `src/`. Change `wrangler.toml` /
  `wrangler.jsonc` so the deploy registers the triggers correctly.
- ❌ Assuming cron fires exactly on minute boundaries. There is jitter; do not
  depend on sub-minute timing.
- ❌ Relying on missed runs being replayed. Cron is Cloudflare-style
  best-effort: minute-aligned slots fire at most once each, slots missed during
  downtime are skipped (never replayed), consecutive runs may overlap if a
  handler outlasts its slot, and a handler failure is recorded as the outcome —
  the scheduler does not retry it. `event.scheduledTime` is the slot timestamp,
  not the dispatch time.

## Local development

`wrangler dev` does not fire scheduled automatically — deploy to WDL and test by
watching the logs. For unit-style testing you can trigger manually through
`wrangler dev`'s `__scheduled` endpoint, but the real schedule cadence can only
be observed on the platform runtime.

## End-to-end example

`../examples/cron-demo` — a `*/1 * * * *` trigger that updates the last-fire
time in KV every minute.

## Related

- [kv.md](./kv.md) — tracking state across fires.
- [d1.md](./d1.md) — periodic SQL writes.
- [env-overrides.md](./env-overrides.md) — preview and production can have
  different cron cadences.
