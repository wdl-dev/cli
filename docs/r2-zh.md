# R2 —— 对象存储

## 是什么

命名空间级的对象存储，在 worker 中通过 `env.<BUCKET>` 用 `head` / `get` / `put` / `delete` / `list` 访问。用来放大型 blob（图片、PDF、压缩包），或者比 KV 更大、更不适合 KV 的东西。

`bucket_name` 是平台本地的虚拟命名空间，**不是** Cloudflare 账户级 bucket。删除 worker **不会**删除 R2 数据。

## 何时使用

- 文件（图片、附件、PDF）。
- 单个 blob 大于几 KB 的任何东西。
- 要用 CDN 提供下载的内容 —— 但如果是静态/构建产物，先看 [assets-zh.md](./assets-zh.md)。

小型 key-value 查找优先 KV —— 见 [kv-zh.md](./kv-zh.md)。关系型数据用 D1 —— 见 [d1-zh.md](./d1-zh.md)。

## Wrangler 配置

```toml
[[r2_buckets]]
binding = "IMAGES"
bucket_name = "inspection-images"
```

或在 `wrangler.jsonc`：

```jsonc
{
  "r2_buckets": [
    { "binding": "IMAGES", "bucket_name": "inspection-images" }
  ]
}
```

R2 bucket 是**惰性**的 —— 不需要预创建。绑定首次使用时即可工作；worker 写入第一个对象时 bucket 就出现了。

读取时 custom metadata key 会按 HTTP header 语义归一成小写。`head()` 会暴露 HTTP metadata 和 custom metadata，所以鉴权上与读取对象 body 同级。

## Worker 端读写

```js
export default {
  async fetch(request, env, ctx) {
    // PUT
    await env.IMAGES.put("receipts/2026-04-29.pdf", request.body, {
      httpMetadata: { contentType: "application/pdf" },
    });

    // GET —— 找不到时返回 null
    const obj = await env.IMAGES.get("receipts/2026-04-29.pdf");
    if (!obj) return new Response("not found", { status: 404 });
    return new Response(obj.body, {
      headers: { "Content-Type": obj.httpMetadata?.contentType ?? "application/octet-stream" },
    });

    // RANGE GET
    const preview = await env.IMAGES.get("receipts/2026-04-29.pdf", {
      range: { offset: 0, length: 1024 },
    });

    // Conditional GET / HEAD
    const fresh = await env.IMAGES.get("receipts/2026-04-29.pdf", {
      onlyIf: { etagDoesNotMatch: obj.etag },
    });

    // HEAD —— 只取 metadata，不下载 body
    const meta = await env.IMAGES.head("receipts/2026-04-29.pdf");

    // LIST —— 分页；include metadata 时会额外读取每个对象的 HEAD
    const page = await env.IMAGES.list({ prefix: "receipts/", limit: 100 });
    const pageWithMeta = await env.IMAGES.list({
      prefix: "receipts/",
      include: ["httpMetadata", "customMetadata"],
    });

    // DELETE
    await env.IMAGES.delete("receipts/2026-04-29.pdf");
  },
};
```

### 读取和 metadata

`get()` 支持常见 range GET 形态（`offset` / `length` / `suffix` / raw `header`）和条件读取。`get()` / `head()` 的 `onlyIf` 支持 ETag 条件和上传时间条件；`put(..., { onlyIf })` 当前只支持 ETag 条件，precondition 失败时返回 `null`。

`list({ include: ["httpMetadata", "customMetadata"] })` 会为列表里的对象额外发起 HEAD 来补齐 metadata，并带有并发上限。需要大范围扫描时，不要默认打开 metadata include；只在列表结果确实要展示或决策 metadata 时使用。

### `put` 大小上限

`put(stream, ...)` 会先把流缓冲下来再发一次 S3 PUT，**上限 25 MiB**。当前平台还不支持 multipart upload；超过上限会报错，不会自动分片上传。

## 从 CLI 检查

```bash
wdl r2 buckets list

wdl r2 objects list <bucket> [--prefix <p>] [--delimiter <d>] [--limit <n>] [--cursor <c>]
wdl r2 objects head <bucket> <key>          # 只看 metadata，不下载 body
wdl r2 objects get  <bucket> <key> --out file  # 下载
wdl r2 objects delete <bucket> <key> --yes  # 破坏性 —— 先确认
```

`wdl r2 objects get` 会写出原始 object bytes。需要 stream bytes 时请 pipe 或重定向 stdout；在交互终端中请使用 `--out <path>`。

列表被截断时输出会带 `Next cursor: <c>`；把它传给下一次 `--cursor` 继续翻页（`wdl r2 buckets list` 同样支持 `--cursor` / `--limit`，其中 `--limit` 必须是 1..1000）：

```bash
wdl r2 objects list receipts --limit 100
# ...
# Next cursor: eyJrZXkiOiJyZWNlaXB0cy8wMDk5In0
wdl r2 objects list receipts --limit 100 --cursor eyJrZXkiOiJyZWNlaXB0cy8wMDk5In0
```

`wdl r2 objects head` 是只读检查工具 —— 在做破坏性操作前先确认目标对象是否正确。对象不存在时，control 遵循 HTTP `HEAD` 语义返回空 404；CLI 会显示状态码，不会有 JSON 错误体可解析。

R2 object key 可以包含开头、结尾或连续的 `/` 路径分隔符；CLI 会保留这些 empty path segments。`.` 和 `..` segment 会被拒绝，避免 object key 和 control-plane URL path traversal 混淆。

## Worker 删除后的清理

删除 worker **不会**删除 R2 数据。`wdl delete worker <name>` 之后 R2 对象还在。要清理：

```bash
wdl r2 objects list <bucket>            # 先确认有哪些
wdl r2 objects delete <bucket> <key>    # 一个一个删，每个都提示
```

加 `--yes` 之前先跟用户确认。对象删除不可逆。

## 反模式

- ❌ 用 R2 存小型 key-value（单字符串开关之类）。KV 读写都更便宜 —— 见 [kv-zh.md](./kv-zh.md)。
- ❌ 期望 `put(stream, ...)` 处理 >25 MiB 的 blob。当前平台会拒绝，multipart upload 尚未支持。
- ❌ 主动给 `wdl r2 objects delete` 加 `--yes`。先 `head` 或 `list`，跟用户确认。
- ❌ 以为删除 worker 会清理 R2。不会 —— R2 比 worker 活得久。

## 端到端示例

`../examples/inspection-demo` —— R2 + D1 + KV + assets 在一个项目里组合。

## 相关

- [kv-zh.md](./kv-zh.md) —— 小型 KV 存储。
- [d1-zh.md](./d1-zh.md) —— 关系型数据。
- [assets-zh.md](./assets-zh.md) —— CDN 服务的静态文件。
