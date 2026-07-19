# Workflows —— 长流程实例

## 是什么

WDL 支持当前 Worker 内定义的 workflow class。它不是完整 Cloudflare Workflows parity；跨 worker workflow、跨 worker callback、service-binding callback、`script_name` 和 Cloudflare source-AST visualizer 暂不支持。same-worker DO progress callback 和 runtime-observed parallel/DAG `step.do` execution 可用。

Workflows 依赖 WDL control/runtime 服务，不能只靠 `wrangler dev` 在本地完整验证。部署到 WDL 后用 `wdl workflows` 和日志确认实例状态。

## Wrangler 配置

```toml
[[workflows]]
name = "orders"
binding = "ORDERS"
class_name = "OrderWorkflow"
```

Worker 代码遵循 Cloudflare Workflows 心智模型：`WorkflowEntrypoint`、 `env.<BINDING>.create()`、`createBatch()`、`get()`、`status()`、`pause()`、 `resume()`、`restart()`、`terminate()`、`sendEvent()`、`step.do()`、 `step.sleep()`、`step.sleepUntil()`、`step.waitForEvent()`、retry、 `NonRetryableError`、same-worker DO progress callback 和 runtime-observed parallel/DAG step。

如果一个 `step.do` 永久失败，本次 workflow run 会进入 terminal failure，即使用户代码 catch 了这次抛错也一样。

## 编写限制

- `createBatch()` 每次最多接受 100 个 entry。
- 单个 workflow result 上限是 1 MiB；一次 runtime 到 Workflows backend 的 JSON 请求上限是 2 MiB。
- 每个 workflow instance 的聚合 payload 上限是 16 MiB。超过上限的 step/event 写入会让请求失败；runtime 写入过大的 terminal result 时，会在同一个事务里把 instance 转为 failed。
- 新创建的 completed、failed 和 terminated instance 默认保留 8 小时。需要时可通过 `create({ retention: { successRetention, errorRetention } })` 分别覆盖成功和错误保留时间。
- 一个 step 最多记录 1000 条 dependency edge。单次 runtime dispatch turn 最多有 1000 个 in-flight workflow steps，且最多启动 1000 个 fresh backend steps。
- 启动了 `step.do` promise 后，必须 await 所有已启动 step；run 在仍有 started step 未 settle 时返回会失败为 `workflow_invalid_step`。
- 并行 `step.do` sibling 必须在同一个同步 fan-out batch 里创建，再统一 `await`。一旦 await 了其中一个 sibling，就必须等完整 batch 结束后才能启动下一批 durable step，这样 replay 才能计算相同的 dependency frontier。
- `step.sleep()`、`step.sleepUntil()` 和 `step.waitForEvent()` 会 suspend 整个 run，不能和其他 in-flight step 重叠。不要用 `Promise.race()` 只处理最快的 step 后直接进入 sleep/wait；先处理或取消业务侧并发，再让 workflow suspend。

## CLI

```bash
wdl workflows list
wdl workflows instances <worker> <workflowName> [--limit <n>] [--cursor <c>]
wdl workflows status <worker> <workflowName> <instanceId> --include-steps [--step-limit <n>]
wdl workflows pause <worker> <workflowName> <instanceId>
wdl workflows resume <worker> <workflowName> <instanceId>
wdl workflows restart <worker> <workflowName> <instanceId> --yes
wdl workflows terminate <worker> <workflowName> <instanceId> --yes
```

`restart` 和 `terminate` 是破坏性实例生命周期操作；只有在已经独立确认 namespace、worker、workflow 和 instance id 后才传 `--yes`。

`wdl workflows list` 会把 active Worker version 不再导出的定义标为 `retired=yes`。既有实例仍可查看和 terminate，但 restart 会返回 `workflow_not_exported`；需要先部署一个重新导出该 workflow name 的 active version。

Workflows API 的语义大小限制会返回 `request_too_large`；HTTP body 解析阶段的大小限制可能返回 `request_body_too_large`。Workflows 5xx 表示平台或 backend 故障，响应体会保持通用错误摘要；底层诊断进入平台日志，不作为稳定 CLI 输出。`workflow_metadata_contention` 表示 control 读取期间 active workflow metadata 发生变化，重试命令即可。

## 端到端示例

`../examples/workflows-demo` —— 从 HTTP 路由启动 workflow、查询状态，并向等待中的实例发送 approval 事件。
