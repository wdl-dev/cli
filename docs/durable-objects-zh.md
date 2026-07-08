# Durable Objects —— 同 Worker 有状态对象

## 是什么

WDL 支持同一个 Worker 内的 Durable Object class。跨 script binding、 `script_name`、rename/delete migration、平台级 WebSocket session/cursor 恢复暂未实现。

## Wrangler 配置

DO class 必须列在 `[[migrations]].new_classes` 或 `[[migrations]].new_sqlite_classes`；在 WDL 中两种写法都映射到 SQLite-backed DO storage。

```toml
[[durable_objects.bindings]]
name = "ROOMS"
class_name = "Room"

[[migrations]]
tag = "v1"
new_classes = ["Room"]
```

## Worker 代码

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

## 支持面

当前支持 `stub.fetch()`、JSON-structured `stub.method(...args)` RPC、native `ctx.storage`、同步 `ctx.storage.sql`、alarm、普通 WebSocket upgrade 以及 native WebSocket hibernation API surface。

使用 `ctx.storage.sql` 时，不要使用以 `_cf_` 开头的应用表名；workerd 对这个前缀做大小写不敏感保留。`ctx.storage.deleteAll()` 也会保留平台自有的 `_cf_*` 表。

## 端到端示例

`../examples/durable-objects-demo` —— 同 Worker 内 `Room` Durable Object，展示内存计数和 SQLite-backed storage 计数。
