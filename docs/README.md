# WDL CLI docs entrypoint

English | [中文](./README-zh.md)

These `docs/` target the agent / LLM / developer actively modifying a Worker
project. They are not split-out pages of `GUIDE.md`; they are per-task topic
references: each file covers that capability's Wrangler config, Worker code
shape, WDL differences, anti-patterns, and end-to-end examples.

`GUIDE.md` / `GUIDE-zh.md` are the full tenant manual, meant to be read through
by a human — install, configure, deploy, debug. `docs/` is for looking up
details once you already know which capability you are building. Both keep the
critical limits; the difference is that GUIDE leads with the common path while
the topic docs expand edge APIs, limits, anti-patterns, and combinations.

Every topic doc has a Chinese twin at `<name>-zh.md`. Both languages are
authoritative and must be updated together; agent-facing references use the
English set.

## What to read first

| Task                                                    | Entry                                      |
| ------------------------------------------------------- | ------------------------------------------ |
| Install, configure tokens, deploy, tail, delete workers | [deploy.md](./deploy.md)                   |
| Small key/value state, counters, cache entries          | [kv.md](./kv.md)                           |
| Object / attachment / blob storage                      | [r2.md](./r2.md)                           |
| SQL / relational state and migrations                   | [d1.md](./d1.md)                           |
| Durable Object local classes, SQLite-backed state       | [durable-objects.md](./durable-objects.md) |
| Workflow instances, durable steps, event waits          | [workflows.md](./workflows.md)             |
| Queue producer / consumer background work               | [queues.md](./queues.md)                   |
| Cron / scheduled jobs                                   | [cron-triggers.md](./cron-triggers.md)     |
| Static assets and `env.ASSETS.url()`                    | [assets.md](./assets.md)                   |
| WDL `[env.<name>]` override rules                       | [env-overrides.md](./env-overrides.md)     |
| Worker / namespace runtime secrets                      | [secrets.md](./secrets.md)                 |
| Storing control-plane tokens locally                    | [token.md](./token.md)                     |

Combining features means reading several topics. For example: writing state
after consuming a queue, read [queues.md](./queues.md) and [kv.md](./kv.md);
recording an index after uploads, read [r2.md](./r2.md) and [d1.md](./d1.md); an
admin tool with a static page, read [assets.md](./assets.md) plus the topics for
the bindings it actually uses.

## Example directory

End-to-end examples live in `examples/`. When a snippet is not enough, copy the
closest example and rename it:

| Scenario                          | Example                |
| --------------------------------- | ---------------------- |
| Minimal JSONC Worker              | `hello-jsonc`          |
| KV counter                        | `kv-demo`              |
| D1 + migrations                   | `d1-demo`              |
| Cron + KV                         | `cron-demo`            |
| Queue producer + consumer + KV    | `queues-demo`          |
| Durable Object counter            | `durable-objects-demo` |
| Workflow start / status / events  | `workflows-demo`       |
| Static assets                     | `pages-assets`         |
| WDL env overrides & worker naming | `env-overrides-demo`   |
| R2 + D1 + KV + assets combined    | `inspection-demo`      |

## Writing boundaries

- GUIDE keeps the common paths and the must-know limits; it does not pack every
  rare API into the first screen of snippets.
- A topic doc covers that capability's complete tenant-facing behavior,
  including advanced options, limits, and WDL-vs-Cloudflare differences.
- Agents should open the relevant topic doc before answering; do not fill in
  edge behavior from GUIDE's summary alone.
- Examples stay deployable and copyable; they carry no control-plane or
  operator-only capabilities.
