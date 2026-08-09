# Cron 触发器 —— 定时 handler

## 是什么

按 cron 调度运行 `scheduled(event, env, ctx)` handler。平台按配置的节奏调用 handler；不需要外部调度器。

## 何时使用

- 周期性同步、轮询、清理、批处理任务。
- 任何在服务器上会用 cron 跑的事情。

如果要响应请求来触发，用 `fetch` handler。如果要响应队列消息，见 [queues-zh.md](./queues-zh.md)。

## Wrangler 配置

```toml
[triggers]
crons = ["*/5 * * * *", "0 0 * * *"]
```

或在 `wrangler.jsonc`：

```jsonc
{
  "triggers": {
    "crons": ["*/5 * * * *", "0 0 * * *"]
  }
}
```

Cron 格式是标准的 5 字段 `min hour dom mon dow`。**默认 UTC**。

需要为每个 schedule 控制时区时，用 `[[triggers.schedules]]`（平台扩展）：

```toml
[[triggers.schedules]]
cron = "0 9 * * MON-FRI"
timezone = "Asia/Shanghai"
```

`[triggers]` 和 `[[triggers.schedules]]` 都支持；选一种用。

Wrangler 4.118+ 还支持用 `triggers.events` 声明 Cloudflare Artifacts Workflow subscription。WDL 没有实现对应的 control/runtime 契约，因此 deploy 会拒绝该字段，而不是静默丢弃 subscription。

Cron triggers 是 runtime dispatch 能力。除非管理方明确给了 reserved namespace，否则只应声明在 tenant namespace 里的可路由 Worker 上。通过 `[[platform_bindings]]` 选择的 Worker 是冷加载的平台能力，不是公开/runtime dispatch 目标，不能声明 cron triggers。

## Handler 签名

```js
export default {
  async scheduled(event, env, ctx) {
    // event.cron —— 命中的 cron 字符串
    // event.scheduledTime —— epoch 毫秒
    // ctx.waitUntil(...) —— 让 handler 在 return 之后继续执行 promise
    console.log("[cron]", event.cron, "fired at", new Date(event.scheduledTime).toISOString());

    // 干活
    await env.STATE.put("last_tick", String(Date.now()));
  },

  async fetch(request, env, ctx) {
    // 可选 —— worker 可以同时有 fetch 和 scheduled
    return new Response("hello");
  },
};
```

`event.cron` 与 wrangler 配置里的字符串完全相同。一个 worker 处理多个 cron 时用它来分派。

## 与其他功能组合

cron handler 就是一个 worker —— `env` 与 `fetch` 共享。常见组合：

- **cron + KV**：跟踪上次触发状态。见 `../examples/cron-demo`。
- **cron + D1**：周期性批量 INSERT / 清理。见 [d1-zh.md](./d1-zh.md)。
- **cron + R2**：定时归档或清理已存对象。见 [r2-zh.md](./r2-zh.md)。

## 反模式

- ❌ `scheduled` 在异步操作未完成时就 return。运行时会取消未完成的 promise。用 `ctx.waitUntil(promise)` 延长执行。
- ❌ 用 `fetch` handler 配合 cron 期望"叫醒"它。两者独立运行； 没有共享内存状态。
- ❌ 把调度时间写死在 `src/`。改 `wrangler.toml` / `wrangler.jsonc`，让部署正确注册触发器。
- ❌ 假设 cron 在分钟边界精确触发。会有 jitter；不要依赖亚分钟级的时序。
- ❌ 依赖错过的触发会被补发。Cron 是 Cloudflare 式的 best-effort：按分钟槽对齐、每槽至多触发一次；停机期间错过的槽会被跳过（绝不补发）；handler 执行超过一个槽时相邻两次运行可能重叠；handler 失败只记录为结果，调度器不会重试。`event.scheduledTime` 是槽的时间戳，不是实际派发时间。

## 本地开发

`wrangler dev` 不会自动触发 scheduled —— 部署到 WDL 后看日志测试。做单元化测试时可以通过 `wrangler dev` 的 `__scheduled` 端点手工触发，但实际调度节奏只能在平台运行时观察。

## 端到端示例

`../examples/cron-demo` —— `*/1 * * * *` 触发器，每分钟更新一次 KV 里的上次触发时间。

## 相关

- [kv-zh.md](./kv-zh.md) —— 在多次触发之间跟踪状态。
- [d1-zh.md](./d1-zh.md) —— 周期性 SQL 写入。
- [env-overrides-zh.md](./env-overrides-zh.md) —— preview 和 production 可以有不同的 cron 节奏。
