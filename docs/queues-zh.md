# Queues —— 异步消息

## 是什么

Queue 适合把请求里的耗时工作拆到后台处理，例如同步外部系统、生成报表、发送通知或批量清理。Worker 用 producer binding 发送消息，用 `queue()` handler 消费消息。

## Wrangler 配置

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

如果消费者要把处理结果写到 KV、D1 或 R2，把对应 binding 一起声明。

## Worker 代码

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

失败时可以调用 `message.retry({ delaySeconds: 30 })`，或让 handler 抛错交给平台按 `max_retries` 和 `dead_letter_queue` 处理。

## 行为和限制

- WDL runtime 当前强制单条消息 body 最大 128,000 bytes。
- `sendBatch()` 最多 100 条，WDL runtime 当前强制 batch body 总量最大 256,000 bytes。
- 默认 body 类型是 JSON；字符串用 `{ contentType: "text" }`，二进制用 `{ contentType: "bytes" }`。
- `delivery_delay` 和 `send(..., { delaySeconds })` 可用于延迟投递。
- `retry_delay` 和 `message.retry({ delaySeconds })` 可用于延迟重试；显式传 `delaySeconds` 会覆盖 consumer 的 `retry_delay`，传 `0` 表示立即重试。
- `message.attempts` 从 1 起计，因此 `max_retries = N` 意味着 handler 最多观察到 N + 1 次尝试，之后消息进入 dead-letter queue。
- Dead-letter queue 是有界的诊断通道（默认约 1 万条，近似裁剪）——应及时排空，不要当作持久归档使用。
- CLI 会转发通过基础整数 delay 解析的 `max_batch_timeout` 以兼容配置；WDL control 负责执行更严格的 Cloudflare 兼容 0..60 秒范围。当前不要依赖它做完整的等待聚合，实际 dispatch 主要由 `max_batch_size` 和平台调度节奏截断。
- `max_concurrency` 当前不支持，部署时会被拒绝。
- Queue consumer 是 runtime dispatch 目标，应声明在可路由的 tenant Worker 上，不要声明在 platform binding target Worker 上。

## 端到端示例

`../examples/queues-demo` —— 单 Worker 同时生产和消费 queue 消息，并把消费结果写入 KV。

## 相关

- [kv-zh.md](./kv-zh.md) —— 保存 queue 处理状态。
- [cron-triggers-zh.md](./cron-triggers-zh.md) —— 定时触发任务。
