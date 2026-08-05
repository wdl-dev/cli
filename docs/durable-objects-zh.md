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

## 会话策略与 facet

默认情况下，promote 新 Worker version 会让已经构造的 DO facet 停留在构造它的 version 上，直到 host actor 重启或 facet 被删除。已打开的 WebSocket 也会继续在该 version 上 drain，但前提是它的 backend 仍健康：backend 一旦丢失，WDL 不会重连已不活跃的 version——WebSocket 会以 `1012` 关闭，client 必须重连才能到达 active version。希望每次 promotion 都让旧 version 的会话退役、并在下一次 dispatch 时退役旧 facet 的应用可以显式配置：

```toml
[wdl]
session_policy = "restart"
```

`session_policy` 接受 `preserve` 或 `restart`，默认是 `preserve`。它在新 version 被 promote 时生效，只上传 bundle 时不会触发。该策略并非 Durable Object 专属：它约束的是 worker 的既有会话，因此没有 Durable Object 的纯 WebSocket worker 也可以设置它。

使用 `restart` 时，WDL 会在旧 version facet 下一次 dispatch 时将其中止，但不会删除 SQLite state。Active HTTP/RPC call 可能失败，已有 WebSocket 会在 promote 时立即以 `1012` 关闭，而不是等到 backend 丢失；client 必须重连并重新执行应用握手。下一次 invocation 会使用同一份持久化 storage 构造 active class version。这与 Cloudflare 的默认行为一致——部署新代码会重启每个 Durable Object。由已被取代的 version 排定的 alarm 会改由 active version 执行；`preserve` 则让它们留在排定它的 version 上。

Promotion 与 route 变更在同一个事务中原子提交该策略；后续的 `preserve` promotion 可以覆盖尚未被观察到的 restart 工作，但无法撤销已经发生的关闭或 facet abort。如果 `wdl deploy` 在 promote 前失败，之前的 version 继续服务；重新运行同一个 `wdl deploy` 即可重试——除非失败原因是 control 未确认该策略，那需要先升级 control。

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

DO fetch 请求体上限是 1 MiB。RPC method name 必须符合 JavaScript identifier grammar，且最多 256 ASCII bytes。RPC arguments 最多 1 MiB，只接受 structural JSON：finite number、string、boolean、null、dense array 和 plain object。序列化不会调用 `toJSON()`；sparse array、循环结构、非 plain object 和其它非 JSON 值会在 dispatch 前被拒绝。

Object name 和 id 必须是 well-formed Unicode；lone UTF-16 surrogate 会被拒绝。DO class name 使用 ASCII JavaScript class-name grammar，最多 468 bytes。

使用 `ctx.storage.sql` 时，不要使用以 `_cf_` 开头的应用表名；workerd 对这个前缀做大小写不敏感保留。`ctx.storage.deleteAll()` 也会保留平台自有的 `_cf_*` 表。

## 端到端示例

`../examples/durable-objects-demo` —— 同 Worker 内 `Room` Durable Object，展示内存计数和 SQLite-backed storage 计数。
