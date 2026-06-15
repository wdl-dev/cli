# WDL CLI 文档入口

[English](./README.md) | 中文

这组 `docs/` 面向正在修改 Worker 项目的 agent / LLM / 开发者。它不是 `GUIDE.md` 的拆分页，而是按任务拆开的专题参考：每个文件给出该能力的 Wrangler 配置、Worker 代码形态、WDL 差异、反模式和端到端示例。

`GUIDE.md` / `GUIDE-zh.md` 是完整租户手册，适合人类从安装、配置、部署、调试一路读完。`docs/` 适合在已经知道要做某个能力时直接检索细节。两边都应保留关键限制；差别是 GUIDE 优先讲常见路径，专题 docs 可以展开边角 API、限制、反模式和组合方式。

每篇专题文档都有英文版（`<name>.md`，本目录下不带 `-zh` 后缀的对应文件）。两种语言同为权威，行为变更时必须同步更新；面向 agent 的引用统一使用英文版。

## 先读什么

| 要做什么 | 入口 |
| --- | --- |
| 安装、配置 token、部署、tail、删除 worker | [deploy-zh.md](./deploy-zh.md) |
| 小型 key/value 状态、计数器、缓存条目 | [kv-zh.md](./kv-zh.md) |
| 对象/附件/blob 存储 | [r2-zh.md](./r2-zh.md) |
| SQL / 关系型状态和迁移 | [d1-zh.md](./d1-zh.md) |
| Durable Object 本地 class、SQLite-backed state | [durable-objects-zh.md](./durable-objects-zh.md) |
| Workflow 实例、durable steps、事件等待 | [workflows-zh.md](./workflows-zh.md) |
| Queue producer / consumer 后台任务 | [queues-zh.md](./queues-zh.md) |
| Cron / 定时任务 | [cron-triggers-zh.md](./cron-triggers-zh.md) |
| 静态资源和 `env.ASSETS.url()` | [assets-zh.md](./assets-zh.md) |
| WDL 环境覆盖 `[env.<name>]` 规则 | [env-overrides-zh.md](./env-overrides-zh.md) |
| Worker / namespace 运行时 secrets | [secrets-zh.md](./secrets-zh.md) |
| 本地存储控制面 token | [token-zh.md](./token-zh.md) |

组合功能时读多个专题。例如：queue 消费后写状态，读 [queues-zh.md](./queues-zh.md) 和 [kv-zh.md](./kv-zh.md)；上传文件后记录索引，读 [r2-zh.md](./r2-zh.md) 和 [d1-zh.md](./d1-zh.md)；带静态页面的管理工具，读 [assets-zh.md](./assets-zh.md) 和实际绑定对应的专题。

## 示例目录

端到端示例位于 `examples/`。当片段不够时，优先复制最接近的示例再改名：

| 场景                           | 示例                   |
| ------------------------------ | ---------------------- |
| 最小 JSONC Worker              | `hello-jsonc`          |
| KV 计数器                      | `kv-demo`              |
| D1 + migration                 | `d1-demo`              |
| Cron + KV                      | `cron-demo`            |
| Queue producer + consumer + KV | `queues-demo`          |
| Durable Object 计数器          | `durable-objects-demo` |
| Workflow 启动 / 状态 / 事件    | `workflows-demo`       |
| 静态资源                       | `pages-assets`         |
| WDL 环境覆盖与 worker 命名差异 | `env-overrides-demo`   |
| R2 + D1 + KV + assets 组合     | `inspection-demo`      |

## 写作边界

- GUIDE 保留常见路径和必须知道的限制，不把少见 API 全部塞进第一屏代码片段。
- 专题 docs 要覆盖该能力的完整 tenant-facing 行为，包括高级选项、限制和 WDL 与 Cloudflare 的差异。
- Agent 回答用户前应打开相关专题 docs；不要只凭 GUIDE 的摘要补全边角行为。
- 示例应保持可部署、可复制，不承载内部控制面或运维专用能力。
