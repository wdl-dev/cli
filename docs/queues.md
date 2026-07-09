# Queues — Async Messages

## What it is

Queues split slow work out of the request into background processing — syncing
external systems, generating reports, sending notifications, or batch cleanup. A
Worker sends messages through a producer binding and consumes them with a
`queue()` handler.

## Wrangler configuration

```toml
[[queues.producers]]
binding = "JOBS"
queue = "jobs"

[[queues.consumers]]
queue = "jobs"
max_batch_size = 10
max_batch_timeout = 5
max_retries = 3
retry_delay = 10
```

If the consumer writes its results to KV, D1, or R2, declare those bindings
alongside.

## Worker code

```js
export default {
  async fetch(request, env) {
    await env.JOBS.send({
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
    });
    return Response.json({ queued: true });
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      await handleJob(message.body, env);
      message.ack();
    }
  },
};
```

On failure, call `message.retry({ delaySeconds: 30 })`, or let the handler throw
and leave it to the platform's `max_retries` and `dead_letter_queue` handling.

## Behavior and limits

- The WDL runtime currently enforces a 128,000-byte cap on each message body.
- `sendBatch()` accepts at most 100 messages; the WDL runtime currently enforces
  a 256,000-byte cap on total batch body size.
- The default body type is JSON; use `{ contentType: "text" }` for strings and
  `{ contentType: "bytes" }` for binary.
- `delivery_delay` and `send(..., { delaySeconds })` delay delivery.
- `retry_delay` and `message.retry({ delaySeconds })` delay retries; an
  explicit `delaySeconds` overrides the consumer's `retry_delay`, including `0`
  for an immediate retry.
- `message.attempts` starts at 1, so `max_retries = N` means the handler
  observes at most N + 1 attempts before the message moves to the dead-letter
  queue.
- The dead-letter queue is a bounded diagnostic channel (about 10k entries by
  default, approximately trimmed) — drain it promptly rather than treating it
  as a durable archive.
- The CLI forwards `max_batch_timeout` values that pass basic integer delay
  parsing for config compatibility; WDL control enforces the tighter
  Cloudflare-compatible 0..60 second range. Do not rely on it for full
  wait-based aggregation yet; actual dispatch is mostly cut off by
  `max_batch_size` and the platform's scheduling cadence.
- `max_concurrency` is not supported and is rejected at deploy time.
- Queue consumers are runtime dispatch targets; declare them on routeable tenant
  Workers, not on platform binding target Workers.

## End-to-end example

`../examples/queues-demo` — a single Worker that both produces and consumes
queue messages and writes the consumed results to KV.

## Related

- [kv.md](./kv.md) — storing queue processing state.
- [cron-triggers.md](./cron-triggers.md) — time-triggered jobs.
