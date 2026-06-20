# KV —— 小型 key/value 存储

## 是什么

命名空间级的 key/value 存储，在 worker 中通过 `env.<NAMESPACE>` 用 `get` / `getWithMetadata` / `put` / `list` / `delete` 访问。支持 text/json value 的批量 `get` / `getWithMetadata`，也支持 `put(..., { expirationTtl })` / `put(..., { expiration })` 这类过期时间。单 key `get` 支持 text、json、arrayBuffer 和 stream result shape；批量读取只支持 text/json value。与 Cloudflare KV 的主要差异是：写入会立即可见，`list()` 不保证按字典序返回。

## 何时使用

- 计数器、开关、小型 per-user 状态、缓存条目。
- 单个 key + 值能轻松塞进几 KB 的场景。

关系型数据用 D1 —— 见 [d1-zh.md](./d1-zh.md)。大型 blob 用 R2 ——见 [r2-zh.md](./r2-zh.md)。

## Wrangler 配置

```toml
[[kv_namespaces]]
binding = "VISITS"
id = "visits"
```

或在 `wrangler.jsonc`：

```jsonc
{
  "kv_namespaces": [
    { "binding": "VISITS", "id": "visits" }
  ]
}
```

`binding` 是运行时暴露的名字（`env.VISITS`）。`id` 是**平台本地的 namespace id** —— 一个短字符串，**不是** Cloudflare 的 UUID。CLI 会把这个绑定原样放进上传的 manifest。

KV namespace 是**惰性**的 —— 不需要预创建步骤。绑定首次使用时即可工作。

## Worker 端读写

```js
export default {
  async fetch(request, env, ctx) {
    // GET —— 找不到时返回 null
    const raw = await env.VISITS.get("count");
    const count = raw === null ? 0 : Number(raw);

    // PUT
    await env.VISITS.put("count", String(count + 1));
    await env.VISITS.put("flash", "ok", { expirationTtl: 60 });

    // 类型自动转换
    const obj = await env.VISITS.get("user:42", { type: "json" });
    const buf = await env.VISITS.get("user:42:avatar", { type: "arrayBuffer" });
    const stream = await env.VISITS.get("user:42:avatar", { type: "stream" });
    const many = await env.VISITS.get(["user:42", "user:43"], { type: "json" });

    // LIST —— 分页
    const page = await env.VISITS.list({ prefix: "user:", limit: 100 });
    const pageWithMeta = await env.VISITS.list({ prefix: "user:", metadata: true });

    // DELETE
    await env.VISITS.delete("count");

    return Response.json({ count: count + 1 });
  },
};
```

### 与 Cloudflare KV 的差异

本平台的 KV 写入会立即可见；同一个 worker 紧跟着读自己的写，应读到新值。不要依赖 Cloudflare KV 的全球最终一致性语义来设计延迟可见行为。

`list()` 支持 `prefix`、`limit`、`cursor` 分页，也支持 `list({ metadata: true })` 返回每个 key 的 metadata 而不读取完整 value。返回顺序不保证字典序；cursor 是不透明的 WDL cursor，必须原样传回。 `limit` 是目标页大小，最多 1000；响应不会返回总数。需要稳定排序时，在业务侧对返回的 key 排序。

KV value 在代理前限制为 25 MiB；key（和 list 前缀）的字节长度限制为 512B，与 Cloudflare KV 一致——超过会报 `KV key exceeds 512 byte limit`。

需要随 value 保存少量附加信息时，也支持 `put(..., { metadata })`、 `getWithMetadata()` 和 `list({ metadata: true })`；普通计数器、开关和缓存不需要用它。带 `expirationTtl` 或 `expiration` 的 key 到期后，value 和 metadata 会一起消失；不带过期时间重新 `put` 会清掉之前的过期设置。

`get(..., { cacheTtl })` 会作为 Cloudflare KV API shape 被接受，但当前没有 Cloudflare edge read cache，也没有全球最终一致性窗口；`cacheTtl` 不会改变 WDL KV 的读取行为。

## 反模式

- ❌ 用 KV 存关系型数据。list+filter 不可扩展；D1 就是为这个存在的。
- ❌ 把大型 blob 放 KV（接近或超过 25 MiB）。用 R2 —— 见 [r2-zh.md](./r2-zh.md)。
- ❌ 依赖 `list()` 的返回顺序。需要稳定顺序时自己排序。
- ❌ 部署前预创建 namespace。KV 是惰性的 —— 加上 `[[kv_namespaces]]` 条目然后部署即可。

## 端到端示例

`../examples/kv-demo` —— 最小计数器。`../examples/cron-demo` —— KV 跟踪上次 cron 触发时间。`../examples/queues-demo` —— KV 保存 queue 消费结果。`../examples/inspection-demo` —— KV 与 D1 / R2 / assets 组合。

## 相关

- [d1-zh.md](./d1-zh.md) —— 关系型数据。
- [r2-zh.md](./r2-zh.md) —— 大型 blob。
