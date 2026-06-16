# 部署 —— `wdl deploy` 参考

## 是什么

`wdl deploy <dir>` 用 `wrangler deploy --dry-run` 打包一个 Cloudflare Workers 风格的项目，然后把产物推送到 WDL 控制平面。**它不等同于 `wrangler deploy`**，后者直接对接 Cloudflare。在这个平台上**不要**用 `wrangler deploy` —— 只用 `wdl deploy`。

wrangler 解析顺序是 `WDL_WRANGLER_BIN`、Worker 项目本地 wrangler、CLI 包本地 wrangler、最后是 `PATH`。默认不会临时 `npx --yes wrangler` 拉包；只有设置 `WDL_ALLOW_NPX_WRANGLER=1` 时才允许这个 fallback。

## CLI 调用形式

按以下顺序选一种：

1. **`command -v wdl` 成功** —— 已全局安装（`npm i -g @wdl-dev/cli`）。直接用 `wdl ...`。
2. **在 wdl-cli 仓库内开发**（`<repo>/bin/wdl.js` 存在）—— 用 `node <repo>/bin/wdl.js ...`。这是开发场景。
3. **两种都不是** —— 停下，告诉用户；不要乱编一个路径。

下面例子里，把 `wdl` 当作占位符，替换成你解析出的实际形式。

## 凭证 —— 一次性配置

CLI 需要三个值：

| 值 | 用途 |
| --- | --- |
| `ADMIN_TOKEN` | 租户部署 token。**敏感** —— 不要粘到聊天/提交记录里。 |
| `WDL_NS` | 租户命名空间，例如 `acme`、`demo-prod`。 |
| `CONTROL_URL` | 控制面地址，由运维方提供（例如 `https://api.wdl.dev`）。CLI 没有内置默认值，必须配置。 |

**推荐路径：** `wdl token set --ns <ns> --control-url <url>` 在隐藏提示里读取 token、调 `/whoami` 校验后以 `0600` 存入 `~/.config/wdl/credentials` —— 它不会落在任何项目文件或 shell 历史里。第一个存入的 namespace 成为默认，之后 `wdl deploy` 不用再带 `--ns`。一份存储服务这台机器上所有项目；详见 [token-zh.md](./token-zh.md)。

**per-repo 备选：** 当某个项目需要锁定自己的 control URL / namespace 时，复制 `.env.example` 到 `.env`，填写 `[<ns>]` 段（提交的 `.env.example` 也向队友说明配置形状）。CLI 只读取运行 `wdl` 时所在目录下的 `./.env`（不会向上层目录查找），所以要在放置 `.env` 的目录里执行 `wdl`。token 留在被 gitignore 的 `.env` 里，绝不提交。

**CI / 自动化：** 把 `ADMIN_TOKEN`、`CONTROL_URL`、`WDL_NS` 作为环境变量从 CI secret store 注入 —— 不用交互式的 token store，也绝不提交 `.env`。

裸 control host 会自动补 scheme；生产 host 默认 `https://`，本地 `.test` / `.local` 或 `:8080` 默认 `http://`。如果要强制协议，直接显式写 `https://...` 或 `http://...`。

优先级：`CLI 标志 > shell env > .env 中 [<ns>] 段 > .env 基础段 > wdl token store`。都没有提供时命令直接报错——没有内置默认值。

不确定最终取了哪个值时，运行 `wdl config explain`；要确认 token 实际连到哪个 control、principal、platform version 和 URL hints，运行 `wdl whoami`；本机与远端基础排查运行 `wdl doctor`。当 control 支持 `/whoami` 时，`doctor` 会验证远端 token、principal namespace、platform version 和 CLI compatibility。

运行时密钥（与 `ADMIN_TOKEN` 不同）见 [secrets-zh.md](./secrets-zh.md)。

## Worker URL 形态

```
https://<namespace>.<platform-domain>/<worker-name>/<path>
```

Worker 看到的路径是**剥掉 `/<worker-name>` 之后的路径**。除非运维方明确启用，租户没有自定义路由能力；首次配置不要加 `route` / `routes`。

## 核心命令

| 目标 | 命令 |
| --- | --- |
| 部署一个项目 | `wdl deploy <dir> [--ns <ns>] [--env <name>] [--verbose]` |
| 列出 worker | `wdl workers` |
| 实时查看 worker 日志 | `wdl tail <worker> [--raw]` |
| 删除非 live 版本 | `wdl delete version <worker> <vN>` |
| 删除 worker（预览） | `wdl delete worker <worker> --dry-run` |
| 查看 Workflow 实例 | `wdl workflows instances <worker> <workflow>` |

只要 `WDL_NS` 通过 env 或 `.env` 设置了，或者 `wdl token` store 有默认 namespace，`--ns` 就是可选的。每个子命令都实现了 `--help` —— 不知道用什么 flag 时直接跑。

## 标准部署流程

1. **解析 CLI 调用形式**（上文）。
2. **解析凭证** —— 优先用 `.env` 或 `wdl token` store，不要内联环境变量。
3. **wrangler 版本检查。** 打包步骤需要 `wrangler@^4`。如果项目 pin 了 v3，停下，告诉用户 —— 不要默默升级。
4. **安装 worker 依赖**（在 worker 目录下 `npm install`），如果 `node_modules` 不存在。
5. **预创建持久化绑定。** 读 wrangler 配置：
   - `[[d1_databases]]` → 对每个 `database_name`，先 `wdl d1 list` 检查；缺的用 `wdl d1 create <name>` 创建。见 [d1-zh.md](./d1-zh.md)。
   - `[[r2_buckets]]` 和 `[[kv_namespaces]]` 是惰性的 —— 不需要预创建；首次使用时绑定即生效。见 [r2-zh.md](./r2-zh.md) 和 [kv-zh.md](./kv-zh.md)。
   - `[[queues.*]]` —— 见 [queues-zh.md](./queues-zh.md)；不确定队列归属时再找运维方确认。
6. **应用 D1 迁移**，如果设置了 `migrations_dir` —— 见 [d1-zh.md](./d1-zh.md)。
7. **部署：** `wdl deploy .`。CLI 会打印上传、提升、运行时 URL —— 把这个 URL 给用户看。

Deploy 上传给 control 的 manifest JSON 最大 32 MiB。Assets 在部署时会嵌进这个 JSON 请求；如果静态文件集合较大，可能先撞到 control request cap。大体积或频繁变化的文件用 R2，不要放进 assets。

## 环境覆盖

当 wrangler 配置有 `[env.<name>]` 段时，`--env <name>`（或 `CLOUDFLARE_ENV`）是**必填**的 —— CLI 不会替你挑默认值。明确指定：

```bash
wdl deploy . --env preview
wdl deploy . --env production
```

部署出来的 worker 名永远来自顶层 `name`，不带环境后缀。Wrangler / Cloudflare Workers 的 `--env` 可能让你预期 `my-worker-preview` 这类名字；WDL 不做这个自动补后缀。配置形态见 [env-overrides-zh.md](./env-overrides-zh.md)。

## 支持 / 不支持的 wrangler 配置

**支持：** `name`、`main`、`compatibility_date`/`flags`、`[vars]`、`[[kv_namespaces]]`、`[[d1_databases]]`、`[[durable_objects.bindings]]`、`[[workflows]]`、`[[r2_buckets]]`、`[assets] directory`、`[triggers] crons`、`[[triggers.schedules]]`（带 timezone，平台扩展）、`[[queues.producers]]` / `[[queues.consumers]]`、`[[services]]`、`[[platform_bindings]]`、`[env.<name>]`。

**不支持（部署失败）：** Analytics Engine。Durable Objects 仅支持同 worker class；`script_name`、rename/delete migration 暂未实现。WDL Workflows 仅支持当前 Worker 内定义的 workflow class，不是完整 Cloudflare Workflows parity；`script_name`、跨 worker workflow、跨 worker callback、service-binding callback 和 Cloudflare source-AST visualizer 暂不支持。`route` / `routes` 仅在运维方启用时支持。`assets.run_worker_first` 会被静默忽略。

Cron triggers 和 queue consumers 是 runtime dispatch 能力，只应声明在可路由的 tenant Worker 上。通过 `[[platform_bindings]]` 选择的 Worker 是冷加载的平台能力，不是 public/runtime dispatch 目标，不能声明 cron triggers 或 queue consumers。

## 破坏性命令

`wdl delete worker`、`wdl delete version`、`wdl d1 delete`、`wdl secret delete` 默认会提示确认。如果有 `--dry-run`，先跑一遍（或先做只读检查），然后跟用户确认了再加 `--yes`。**不要**主动加 `--yes`。

删除 worker **不会**删除 R2 数据 —— 见 [r2-zh.md](./r2-zh.md)。

## 常见错误

| 现象 | 原因 / 修复 |
| --- | --- |
| `wdl: command not found` | CLI 不在 PATH。在 wdl-cli 仓库内用 `node <repo>/bin/wdl.js`；其他情况执行 `npm i -g @wdl-dev/cli`。 |
| `Missing admin token` | 没解析出 token。运行 `wdl token set --ns <ns> --control-url <url>`（推荐），或设 `ADMIN_TOKEN` / 传 `--token` / 用 `.env` 的 `[<ns>]` 段。 |
| `401 unknown_token: unauthorized` | Token 对这个控制平面 / 命名空间无效。重新检查 `ADMIN_TOKEN`。 |
| `[vars] must be an object` | 用 `[vars]` 表/对象；数组不合法。 |
| `[vars] <NAME>: only string/number/boolean values are supported` | 移除嵌套值；敏感字符串改用 secret。 |
| `wrangler build failed` | 在项目里跑 `npx wrangler deploy --dry-run` 然后在那边修。 |
| 部署成功但 promote 失败 | 自定义主机或服务绑定的目标校验问题；检查绑定目标。 |
| Worker URL 返回 404 | URL 缺了 `/<worker-name>` 这一段。 |
| `wdl tail` 没有历史日志 | tail 是 live-only；先打开 `wdl tail <worker>` 再触发请求。 |
| Namespace secret 没生效 | NS 级 secret 不会强制 bump worker；重新部署一次或改用 worker 级 secret。 |
| 服务绑定还在打老目标 | 绑定在调用方部署时就锁定了；重新部署调用方。 |

## 反模式

- ❌ 在这个平台上跑 `wrangler deploy`。它对接的是 Cloudflare，不是 WDL。用 `wdl deploy`。
- ❌ 把含 `ADMIN_TOKEN` 的 `.env` 文件提交到 git。
- ❌ "以防万一"加 Durable Objects / Workflows 配置 —— 它们会改变运行时入口和部署校验；只在代码实际使用时添加。
- ❌ 把 `wrangler` pin 到 `^3`。打包步骤需要 v4。

## 端到端示例

`../examples/<name>` 下的每个示例都是可部署的项目。`../examples/hello-jsonc` 是最小的。
