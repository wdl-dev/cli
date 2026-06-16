# WDL CLI

[![npm](https://img.shields.io/npm/v/@wdl-dev/cli)](https://www.npmjs.com/package/@wdl-dev/cli) [![CI](https://github.com/wdl-dev/cli/actions/workflows/ci.yml/badge.svg)](https://github.com/wdl-dev/cli/actions/workflows/ci.yml) [![license](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/wdl-dev/cli/blob/main/LICENSE)

[English](https://github.com/wdl-dev/cli/blob/main/README.md) | 中文

`wdl` 把 Cloudflare Workers 风格的应用部署到 **WDL 平台**——一套可自托管的运行时 + 控制面，让 Workers 形态的代码在 Cloudflare 之外运行。它是租户侧 CLI：用 Wrangler v4 在本地打包项目、上传到运维方的控制面，并在你自己的命名空间里管理周边的一切——D1、R2、KV、Queues、Durable Objects、Workflows、secrets 和实时日志。

## 与 Cloudflare Workers 的关系

- 你写的就是标准 module worker（`export default { fetch }`），配普通的 `wrangler.toml` / `wrangler.jsonc`，pin 在 `wrangler@^4`。
- `wdl deploy` 只用 `wrangler deploy --dry-run` 做**本地打包**——不会向 Cloudflare 发送任何东西。在 WDL 平台上不要用 `wrangler deploy` 发布，真实发布走 `wdl deploy`。
- Worker 通过平台域名上带路径前缀的 URL 提供服务：

  ```text
  https://<namespace>.<platform-domain>/<worker-name>/<path>
  ```

  Worker 看到的路径已剥掉 `/<worker-name>` 前缀。

- 差异分三类——**更强**（单区架构带来强一致 KV 和读己之写的 D1，外加 platform bindings 这类 WDL 新增能力）、**语义差异**、**未实现**——逐能力面的对照见[兼容矩阵](https://github.com/wdl-dev/cli/blob/main/GUIDE-zh.md#兼容性总结)。

## 托管平台（预告）

WDL 首先是开源基础设施：运维方自建平台，租户用本 CLI 部署。WDL Team 之后也会运营一个实验性的托管平台——控制面在 `api.wdl.dev`，worker 通过 `*.wdl.sh` 提供服务——wdl.dev 自身的全部功能都会以 worker 形式跑在这个平台上，平台迭代公开可见。目前尚未上线；想成为种子用户，欢迎发邮件到 <hi@wdl.dev> 联系我们。

## 功能

- **部署** —— 本地 Wrangler v4 打包、manifest 校验、版本化上传 + promote； `[env.<name>]` 环境覆盖。
- **资源** —— D1（SQL、迁移）、R2 对象、KV、Queue 生产/消费、Durable Objects、Workflows、CDN 静态资源。
- **Secrets** —— worker 级与命名空间级运行时密钥，从 stdin 读值，不进 shell 历史。
- **可观测** —— `wdl tail` 实时流式输出 console 与异常；`wdl workers` 列出部署状态。
- **诊断** —— `wdl doctor`、`wdl config explain`、`wdl whoami` 说清 CLI 解析出了什么、控制面看到了什么。
- **护栏** —— 破坏性命令默认确认、所有控制面数据做终端转义加固、 `.env` 端点信任守卫防止 token 被发往不该去的主机。

## 安装

需要 Node.js ≥ 22。

```bash
npm i -g @wdl-dev/cli
```

## 快速开始

平台运维方会提供三个值：命名空间、租户 token、控制面地址。CLI **没有内置端点**——`CONTROL_URL` 未配置时命令会直接报配置错误。

```bash
export WDL_NS=acme
export ADMIN_TOKEN="<tenant-token>"
export CONTROL_URL="https://<your-control-plane>"

wdl init hello --ns "$WDL_NS"
cd hello
npm install
npm run deploy          # 本地打包、上传、promote

wdl tail hello          # 边访问 URL 边看实时日志
```

Worker 此时位于 `https://<namespace>.<platform-domain>/hello/`。

凭证也可以放进带命名空间分段的 `.env` 文件——复制 [`.env.example`](https://github.com/wdl-dev/cli/blob/main/.env.example)，来源优先级（flag 高于 shell env，高于 `.env`，高于 `wdl token` store）见 [docs/deploy.md](https://github.com/wdl-dev/cli/blob/main/docs/deploy.md)。

## 命令

```bash
wdl init <target> [--ns <ns>] [--worker <name>]
wdl deploy <project-dir> [--ns <namespace>] [--env <name>] [--verbose]
wdl tail <worker> [<worker>...] [--ns <namespace>] [--raw]
wdl workers [--ns <namespace>]
wdl secret <put|list|delete> (--worker <name> | --scope ns) [KEY] [--json]
wdl token set --ns <ns> [--control-url <url>] [--label <text>] [--default]
wdl token list [--json] / wdl token use <ns> / wdl token rm --ns <ns>
wdl d1 <create|list|delete|execute|migrations> ...
wdl r2 buckets list / wdl r2 objects <list|head|get|delete> ...
wdl workflows <list|instances|status|pause|resume|restart|terminate> ...
wdl delete worker <name> [--dry-run] / wdl delete version <name> <version>
wdl config explain / wdl doctor / wdl whoami [--json]
wdl --version / wdl <command> --help
```

破坏性命令默认提示确认；只有自动化已核对过目标时才传 `--yes`。

## 文档

| 位置 | 内容 |
| --- | --- |
| [GUIDE.md](https://github.com/wdl-dev/cli/blob/main/GUIDE.md) / [GUIDE-zh.md](https://github.com/wdl-dev/cli/blob/main/GUIDE-zh.md) | 完整租户手册：配置、部署、各类绑定、调试 |
| [docs/](https://github.com/wdl-dev/cli/blob/main/docs/README-zh.md) | 分功能参考（KV、D1、R2、queues、cron、DO、workflows、assets、环境覆盖、secrets），中英双语 |
| [examples/](https://github.com/wdl-dev/cli/tree/main/examples) | 每个功能一个可部署的最小项目 |

| 需求 | 示例 |
| --- | --- |
| 最小 JSONC 配置 | [`hello-jsonc`](https://github.com/wdl-dev/cli/tree/main/examples/hello-jsonc) |
| KV 绑定 | [`kv-demo`](https://github.com/wdl-dev/cli/tree/main/examples/kv-demo) |
| D1 + 迁移 | [`d1-demo`](https://github.com/wdl-dev/cli/tree/main/examples/d1-demo) |
| Cron 触发器 + KV | [`cron-demo`](https://github.com/wdl-dev/cli/tree/main/examples/cron-demo) |
| Queue 生产 + 消费 | [`queues-demo`](https://github.com/wdl-dev/cli/tree/main/examples/queues-demo) |
| Durable Object 计数器 | [`durable-objects-demo`](https://github.com/wdl-dev/cli/tree/main/examples/durable-objects-demo) |
| Workflow 启动 / 状态 / 事件 | [`workflows-demo`](https://github.com/wdl-dev/cli/tree/main/examples/workflows-demo) |
| 静态资源 | [`pages-assets`](https://github.com/wdl-dev/cli/tree/main/examples/pages-assets) |
| 环境覆盖与 worker 命名 | [`env-overrides-demo`](https://github.com/wdl-dev/cli/tree/main/examples/env-overrides-demo) |
| R2 + D1 + KV + assets 组合 | [`inspection-demo`](https://github.com/wdl-dev/cli/tree/main/examples/inspection-demo) |

## 配合 AI 代理使用

随包分发的文档为 agent 可读而写：`wdl init` 会在每个新项目里放一份 `AGENTS.md`，指向 `node_modules/@wdl-dev/cli/docs/`，编码代理不出仓库就能查到绑定配置和部署规则。

<details>
<summary>用 AI 代理新建并部署 worker 的 prompt 模板</summary>

```
我想新建并部署一个 WDL Worker 应用。

功能：[在这里描述，例如 "一个带访问计数的 hello 页面，计数存 KV"]
Namespace：[如果已知就填，例如 acme；不知道就先问我]
Worker/项目目录名：[如果已知就填，例如 hello-counter；不知道就先问我]

请直接开始执行，不要只给计划。全程遵守：

- 不要打印、复述、提交或写入代码任何 token。
- 需要 `ADMIN_TOKEN` 等凭证时，让我在本机终端用隐藏输入或本地配置写入，不要让我把 token 明文发到聊天里。
- 这个平台必须用 `wdl deploy` 做真实发布，不要用 `wrangler deploy` 发布到 Cloudflare。

步骤：

1. 检查 Node.js >= 22 和 npm。缺 `wdl` 时执行 `npm i -g @wdl-dev/cli`；安装后确认 `command -v wdl` 可用。
2. 确认 namespace 和 control 凭证能解析出来——跑 `wdl doctor`。它们可以来自 shell/CI env（`WDL_NS`、`ADMIN_TOKEN`、`CONTROL_URL`）、项目 `.env`，或 `wdl token` store；control URL 和 token 由运维方提供（CLI 没有内置控制面地址）。都解析不出来时，最干净的做法是让我跑 `wdl token set --ns <ns> --control-url <url>`，在隐藏提示里输入 token——它会经校验、以 `0600` 存入，并成为默认 namespace，之后 `wdl deploy` 不用再带 `--ns`。优先用这个，而不是把 token 写进 shell rc 文件。
3. 确认项目目录名以字母开头，后续只含字母、数字和连字符。执行：
   `wdl init <name> && cd <name> && npm install`
   （给 `wdl init` 加 `--ns <ns>` 可把 namespace 烤进 deploy 脚本；否则部署期从 `wdl token` 默认或 `--ns` 解析。）
4. 立刻打开并阅读新目录里的 `AGENTS.md`，再根据我的功能打开 `node_modules/@wdl-dev/cli/docs/` 下相关文档和示例。注意：session 中新生成的 `AGENTS.md` 不会自动加载，必须显式读取。
5. 根据功能修改 `wrangler.jsonc` 和 `src/`。需要第三方 API 鉴权 secret 时用 `wdl secret put --worker <worker-name> <KEY>` 写入，不要把 token 放进源码、`wrangler.jsonc` 或 `.env`。
6. 先跑 `npm run dry-run` 修复本地 bundle 问题，再跑 `npm run deploy` 部署。
7. 部署成功后给我 Worker URL（形态 `https://<namespace>.<platform-domain>/<worker-name>/`）、本次改了哪些文件，以及我该如何验证。
```

</details>

## 参与贡献

欢迎贡献——带复现步骤的 bug 报告、wrangler v4 配置面的覆盖、Windows 行为、文档修正和测试都很有价值。

代码库小而轻依赖：纯 ESM JavaScript、无构建步骤，`bin/wdl.js` 是dispatcher，`commands/` 一个命令一个文件，命令框架、控制面客户端和 Wrangler 配置解析在 `lib/`。整个测试套件基于 mock 依赖离线运行——开发不需要控制面。

```bash
git clone https://github.com/wdl-dev/cli.git
cd cli
npm install
npm link            # 让 `wdl` 解析到工作树
npm test
```

从 [CONTRIBUTING.md](https://github.com/wdl-dev/cli/blob/main/CONTRIBUTING.md) 开始（架构总览、项目不变量、从哪入手）；完整约定见 [AGENTS.md](https://github.com/wdl-dev/cli/blob/main/AGENTS.md)。漏洞通过 [SECURITY.md](https://github.com/wdl-dev/cli/blob/main/SECURITY.md) 报告，不要开公开 issue。

## 许可证

版权所有 2026 The WDL Authors，以 [Apache-2.0](https://github.com/wdl-dev/cli/blob/main/LICENSE) 许可发布。
