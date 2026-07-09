# 使用说明

这份文档面向使用平台部署应用的用户。你不需要了解平台内部实现；按 Cloudflare Workers 的方式写 Worker，用平台提供的 `wdl` CLI 部署即可。

## 准备工作

### 管理方会提供的信息

管理方会给你这些信息：

- Namespace：你的租户命名空间，例如 `acme`。
- Tenant token：只能操作你自己 namespace 的部署令牌。
- Control URL：部署入口，由运维方提供。CLI 没有内置默认值，未配置时命令会直接报配置错误。（WDL Team 的托管预览在 `https://api.wdl.dev`。）
- Platform domain：Worker 对外服务的运行时域名，例如 `wdl.sh`。

没有运维方？平台已开源——自己跑 [wdl-dev/wdl](https://github.com/wdl-dev/wdl)，把 `CONTROL_URL` 指向你自己的控制面即可；namespace、token、platform domain 都由你自己设定。

默认 Worker 访问地址形态是：

```text
https://<namespace>.<platform-domain>/<worker-name>/<path>
```

### 安装 CLI

前置条件：

- Worker 项目使用 Wrangler v4（`wrangler@^4`）；CLI 的打包步骤已不再支持 v3。
- 本机使用 Node.js 22 或更新版本，与 CLI 运行时和 Wrangler v4 基线一致。
- 如果 Worker 项目有依赖，部署前先在 Worker 项目目录执行 `npm install`。

从 npm 安装：

```bash
npm i -g @wdl-dev/cli
```

或者从本仓库的 checkout 运行：

```bash
git clone https://github.com/wdl-dev/cli.git
cd cli
npm install
npm link
```

如果不想全局 link，可以直接调用同一入口：

```bash
node /path/to/cli/bin/wdl.js deploy ./my-worker
```

查看单个命令帮助时，可以运行 `wdl <command> --help` 或 `wdl help <command>`。

### 配置默认值

推荐的做法是 `wdl token` 存储（见下文）；凭证也可以来自本机或 CI 的 shell：

```bash
export WDL_NS=acme
export ADMIN_TOKEN="<tenant-token>"
export CONTROL_URL="https://<your-control-plane>"
```

`ADMIN_TOKEN` 是 `wdl deploy`、`wdl tail`、`wdl secret`、`wdl workers`、`wdl delete` 等 CLI 命令共同读取的令牌环境变量名；这里放的是你的 tenant token，不代表你有管理方权限。

也可以把 WDL 平台默认值放到 `.env` 文件里。CLI 只读取运行 `wdl` 时所在目录下的 `./.env`（不会向上层目录查找），所以请在放置 `.env` 的目录里执行 `wdl`：

```ini
WDL_NS=acme
ADMIN_TOKEN=<tenant-token>
CONTROL_URL=https://<your-control-plane>
```

如果你需要同时操作多个 namespace，可以把共享值放在 base 段，把不同 namespace 的 token 放进 section：

```ini
CONTROL_URL=https://<your-control-plane>
WDL_NS=acme

[acme]
ADMIN_TOKEN=<acme-token>

[acme-staging]
ADMIN_TOKEN=<acme-staging-token>
```

CLI 只会从 `.env` 读取 WDL 平台变量：`ADMIN_TOKEN`、`CONTROL_URL`、`CONTROL_CONNECT_HOST`、`WDL_NS`。优先级是 `CLI flag > shell/CI env > [resolved-ns] section > base .env > wdl token store`，都没有提供时命令直接报错——没有内置默认值。namespace 解析顺序是 `--ns`，然后是 shell 或 base `.env` 里的 `WDL_NS`，再然后是 token store 的默认 namespace。section 名可以是 `[acme]` 这类 tenant namespace，也可以是 `[__name__]` 这种运维保留的不透明 section。Tenant Wrangler 配置默认仍使用普通 tenant namespace 语法，除非运维方明确给了这种 namespace token；否则不要把 `__name__` 形态写进 `[[services]].ns`、`allowed_callers` 或命令示例。如果没有解析出 namespace，section 会全部跳过；后续命令如果需要 namespace 或 token，会按正常校验报错。只有临时切换 namespace 时才需要显式传 `--ns`。不带 scheme 的生产 control host（例如 `api.wdl.dev`）默认补 `https://`；`localhost:8080` 或 `*.test:8080` 这类本地开发地址默认补 `http://`。任何不带 scheme 的 `:8080` control URL 都会按本地 HTTP 处理。需要强制使用其它协议时，显式写 scheme。

`CONTROL_CONNECT_HOST` 是本地开发 / 调试用的覆盖开关：它改变请求实际连接的 TCP 目标，而 HTTP Host header 和 TLS SNI 仍跟随 `CONTROL_URL`（所以 HTTPS 下控制面证书仍会拒绝被重定向的连接；纯 http 没有这层保护）。只在本地开发用 —— 不要在 CI 或生产 shell 中持久设置，残留值可能把 admin token 路由到非预期目标。覆盖值写成 URL 时，scheme 只决定默认 TCP 端口（`http` 为 80，`https` 为 443）；请求使用 HTTP 还是 HTTPS、Host 和 SNI 仍由 `CONTROL_URL` 决定。

推荐的做法是把这些凭证放进托管存储，而不是 shell export 或项目 `.env`：`wdl token set --ns <ns> --control-url <url>` 用隐藏输入读取 token、调 `/whoami` 校验后按 namespace 存入 `~/.config/wdl/credentials`（不进 shell 历史、也不落在项目文件里）。存储是优先级最低的层——命令行标志、shell env、项目 `.env` 仍然胜出——`wdl token list` / `wdl token rm` 管理它。第一个存入的 namespace 成为默认（一行 base `WDL_NS`，和项目 `.env` 一样），命令不带 `--ns` 也能跑；`wdl token use <ns>` 切换默认。详见 [token-zh.md](./docs/token-zh.md)。

`wdl deploy` 在上传前会以你的 OS 用户身份运行项目本地的 Wrangler dry-run 和 build 钩子，这些代码能读到磁盘上的 store（env scrub 只把 WDL 变量挡在 Wrangler 子进程的环境外，挡不住文件），所以只部署你信任的项目。`--no-token-store`（或 `WDL_TOKEN_STORE=off`）让 CLI 只从 flag / shell / `.env` 解析凭据、完全不读 store —— 这是给不太信任的项目或 CI 用的解析 opt-out，不是对文件本身的保护。

用 `wdl config explain` 查看最终 namespace、control URL、脱敏 token 以及每个值的来源。用 `wdl whoami` 调 control-plane `/whoami`，查看当前 authenticated principal、token id、platform version、最低支持 CLI version 和 URL hints。用 `wdl doctor` 做本地可用性检查，包括 Node.js、wdl-cli、Wrangler、配置文件是否存在、凭据是否能解析，以及 `/whoami` 是否可达；在 CI 里可加 `--strict`，命令仍会打印检查结果，但只要任一检查失败就以非零退出。当 control plane 暴露 `/whoami` 时，`doctor` 可以发现 token 是否有效、principal namespace、platform version 和 CLI compatibility；更细的 capability 检查仍需要额外的 control endpoint。

## 脚手架新 Worker

`wdl init` 是新建 WDL Worker 项目的默认脚手架：

```bash
wdl init my-worker --ns acme
cd my-worker
npm install
```

它会写入：

- `package.json` —— 传了 `--ns` 时 `npm run deploy` 会把它烤进去，否则就是 `wdl deploy .`（namespace 在部署期解析），另有 `npm run dry-run` 本地打包检查；devDependencies 固定 `wrangler@^4` 和 `@wdl-dev/cli`。
- `wrangler.jsonc` —— 顶层 `name` 是 worker 名（默认等于目录名，可用 `--worker <name>` 覆盖）。
- `src/index.js`、`.gitignore`，以及 `AGENTS.md`/`CLAUDE.md`，方便 AI 代理找到 `node_modules/@wdl-dev/cli/docs/` 下的分主题文档。

`wdl init . --ns acme` 可以在当前（空）目录原地脚手架。目录名须以字母开头，只能包含字母、数字和连字符。

## 从 example 脚手架

AI agent（Claude Code）直接拷 `examples/<name>/`。脚手架契约写在 `.claude/rules/` 里：

- `.claude/rules/examples.md` —— 列出每个 example 一句话说明 + 拷贝步骤（改 `name`、生成 `.gitignore`）。

用户在 Claude Code 里打开 wdl-cli 时这份规则会自动加载。

## 部署第一个 Worker

按标准 Cloudflare Workers module worker 写法开发：

```js
export default {
  async fetch(request, env, ctx) {
    return new Response(`hello from ${env.APP_NAME}`);
  },
};
```

最小 `wrangler.toml`：

```toml
name = "hello"
main = "src/index.js"
compatibility_date = "2026-06-17"

[vars]
APP_NAME = "hello"
```

新项目建议使用 `compatibility_date = "2026-06-17"`；除非需要的功能或管理方明确要求更新的目标日期。

你可以继续使用 `wrangler dev` 做本地开发；部署到本平台时改用 `wdl deploy`。平台部署命令会调用 `wrangler deploy --dry-run`（Wrangler v4）打包项目，解析顺序是 `WDL_WRANGLER_BIN`、Worker 项目本地 wrangler、CLI 包本地 wrangler、最后是 `PATH`。TypeScript、模块解析、esbuild 打包等流程仍走 wrangler 的标准路径。

如果同时存在多个 Wrangler 配置文件，WDL 跟随 Wrangler 的优先级：`wrangler.json`，然后 `wrangler.jsonc`，最后 `wrangler.toml`。

`wrangler.json` 和 `wrangler.jsonc` 都按 Wrangler 的 JSONC 语法解析，支持注释和尾随逗号。

配置好 CLI 默认值后执行：

```bash
cd /path/to/my-worker
npm install
wdl deploy .
```

也可以不设置环境变量，显式传参：

```bash
wdl deploy . \
  --ns acme \
  --control-url https://<your-control-plane> \
  --token "<tenant-token>"
```

部署成功后，CLI 会自动上传新版本、promote 成线上版本，并输出公网访问地址：

```text
https://<namespace>.<platform-domain>/<worker-name>/<path>
```

例如：

```bash
curl https://acme.wdl.sh/hello/
curl https://acme.wdl.sh/hello/api/users
```

Worker 看到的 path 会去掉 `/<worker-name>` 前缀；上面第二个请求里，Worker 看到的是 `/api/users`。

## 实时查看 Worker 日志

部署后可以用 `wdl tail` 查看当前 namespace 内 Worker 从现在开始的 live 运行状态：

```bash
wdl tail hello
```

常用形态：

```bash
wdl tail hello api                 # 一个终端看多个 worker
wdl tail hello --raw               # 每行输出原始 JSON
wdl tail hello --since 1700000000000-0
wdl tail hello --max-reconnects 0  # 不限制自动重连次数
```

`wdl tail` 会显示 fetch 请求 start/finish（包含 method、对应浏览器访问形态的 pathname（worker 内部路径加上 worker 名前缀，不含 host / query string）、status/outcome、duration），worker 在 fetch 请求路径里产生的 `console.log` / `console.info` / `console.warn` / `console.error`，以及 fetch handler 抛出的未捕获异常。它是 live-only 调试工具：首次连接不会回放历史日志；同一个 CLI 进程的单 worker 网络重连会尽量自动续读，但你按 `Ctrl+C` 退出后再重新运行是一个新进程，会从“现在以后”的日志开始，除非你显式传 `--since <stream-id>`。多 worker 会话在重连期间可能漏事件；如果需要对某个 worker 尽量不丢日志，单独开一个 `wdl tail <worker>` 终端。

`wdl tail` 是 best-effort 实时调试工具，不是审计历史。高流量 worker 或终端连接消费太慢时，可能跳过中间事件。过大的 console 或 exception 事件会整条丢弃，并以较小的 warning 事件报告，而不是截断后输出。事故复盘和完整 payload 请使用管理方提供的常规日志平台。

control 可能主动回收长时间运行的 tail 会话：客户端约 15s 不读会收到 `session_idle`，会话达到运维方配置的最大时长（默认 15 分钟）会收到 `session_expired`。CLI 会打印 warning 并自动重连；如果反复出现，通常说明终端或外层 wrapper 没有及时消费输出。

普通格式化输出会把 worker 名前缀拼到 fetch path 上：worker 内部看到的 `/` 会显示成 `/<worker>/`，便于和浏览器访问路径对应。`--raw` 保留原始JSON payload。

cron / queue delivery 会在 `wdl tail` 里显示 start/finish 事件，包含 worker、request id、outcome 和 duration，所以能看到 worker 是否确实被定时器或队列触发。scheduled / queue handler 里的 `console.*` 不会出现在 `wdl tail` 中；这类细节请到管理方提供的常规日志平台按时间窗口排查。

## URL 和路由

| 用途 | URL | 用法 |
| --- | --- | --- |
| 部署 / 控制面 | 运维方提供，例如 `https://api.wdl.dev` | 设置为 `CONTROL_URL`，或通过 `--control-url` 传给 CLI；只给 CLI 使用 |
| 默认 Worker 流量 | `https://<namespace>.<platform-domain>/<worker-name>/` | 浏览器、API、curl 等公网访问地址 |

不要把用户访问 Worker 的流量打到 control URL。control URL 只用于部署和管理命令。

自定义域名和 Wrangler `routes` 目前还不是 tenant self-service 的 GA 能力。除非管理方明确为你的 namespace 开通自定义 host，否则使用默认 Worker URL：

```text
https://<namespace>.<platform-domain>/<worker-name>/
```

如果管理方已明确为你的 namespace 开通自定义 routing，会同时给出允许使用的 host 和 route pattern。普通 tenant 示例和首次部署不要配置 `route` / `routes`。如果 custom-host promote 因 host 已被占用而失败，请联系管理方；同一个 namespace 内的多个 Worker 仍可以在已开通的形态下按路径拆分流量。

## 支持的 wrangler 配置

Wrangler 能打包、但 WDL 不能运行的形状由 control plane 作为 canonical validator 拒绝，包括不支持的 workerd experimental compatibility flags 和 WDL 保留注入模块名。CLI 仍会对低成本的本地问题 fail-fast，例如 Python Workers modules，以及 `[vars]`、显式 bindings、隐式 `ASSETS` binding 之间的 runtime `env` 名称冲突。Deploy 和 secret mutation 还会校验留有 headroom 的 workerd 1 MiB `workerLoader` env budget；过大的 `[vars]`、secrets、binding metadata 或 retained versions 可能触发 `worker_env_too_large`。

| 配置 | 支持情况 |
| --- | --- |
| `name` / `main` / `compatibility_date` / `compatibility_flags` | 支持 |
| `[vars]` | 支持；必须是 object。值必须是 string / number / boolean；array 和嵌套值会被拒绝。接受的值会暴露到 Worker `env` |
| `[[kv_namespaces]]` | 支持常用 KV API |
| `[[d1_databases]]` | 支持 binding；先用 `wdl d1` 创建/管理数据库，再用 `database_id`（如果存在则优先）或 `database_name`（namespace 内唯一 alias）引用 |
| `[assets] directory = "..."` | 支持；静态文件部署到平台资产服务，Worker 使用 `env.ASSETS.url(path)` 获取 URL |
| `route` / `routes` | tenant self-service 暂未 GA；只有管理方明确为你的 namespace 开通自定义 host 时才使用 |
| `[triggers] crons` | 支持；Cloudflare 兼容写法，按 UTC 执行 |
| `[[triggers.schedules]]` | 平台扩展；每条 cron 可单独指定 `timezone`，不属于 Cloudflare 标准配置 |
| `[[queues.producers]]` / `[[queues.consumers]]` | 支持生产和消费；`delivery_delay` 和 `retry_delay` 生效，`max_concurrency` 会被拒绝 |
| `[[services]]` | 支持 Worker 调 Worker；同 namespace 可直接绑定，跨 namespace 需要目标方授权 |
| `[[platform_bindings]]` | 支持平台提供的第一方能力，例如平台封装的共享服务 |
| `[env.<name>]` | 支持；用 `--env <name>` 或 `CLOUDFLARE_ENV` 选择；见下面的环境覆盖说明 |
| `[[r2_buckets]]` | 支持常用 R2 object API，包括条件请求、range GET 和 `list({ include })`；对象存储在平台本地 R2，并按 namespace + `bucket_name` 隔离 |
| Durable Objects | 支持本 worker 内 class，要求 class 列在 `[[migrations]].new_classes` 或 `[[migrations]].new_sqlite_classes`；两种写法在 WDL 都映射到 SQLite-backed DO storage。`script_name`、rename/delete migration 暂未实现。`stub.fetch()`、JSON-structured `stub.method(...args)` DO RPC、同步 `ctx.storage.sql`、alarm shim、普通 WebSocket upgrade 和 native WebSocket hibernation API surface 可用；平台级 session/cursor 恢复仍由应用自己处理 |
| `[[workflows]]` | 支持当前 Worker 内定义的 workflow class。可用 `WorkflowEntrypoint`、`env.<BINDING>.create()`、`createBatch()`、`get()`、`status()`、`pause()`/`resume()`/`restart()`/`terminate()`、`sendEvent()`、`step.do()`/`sleep()`/`sleepUntil()`/`waitForEvent()`、retry、`NonRetryableError`、same-worker DO progress callback 和 runtime-observed parallel/DAG step。这是 WDL Workflows 支持，不是完整 Cloudflare Workflows parity。Instance payload、单 turn step fan-out 和并行 step 顺序都有上限；已启动的 step 必须 await。不支持 `script_name`、跨 worker workflow、跨 worker callback、service-binding callback 和 Cloudflare source-AST visualizer |
| Analytics Engine | 暂不支持，部署时会拒绝 |
| 其他未映射的 Wrangler 绑定/配置/策略段（例如 `ai`、`vectorize`、`hyperdrive`、`agent_memory`、`websearch`、`media`、`stream`、`ratelimits`、`vpc_services`、`cloudchamber`、`containers`、`wasm_modules`、`[site]`、`limits`、`placement`、`observability`、`workers_dev`、`pages_build_output_dir`） | 不支持；部署时显式报错，不会静默丢弃绑定/配置。CLI 报错会点名被拒字段；内部拒绝列表跟随打包的 Wrangler schema，这里不复刻完整清单 |

Cron triggers 和 queue consumers 是运行时 dispatch 能力。除非管理方明确给了 reserved namespace，否则只应声明在 tenant namespace 里的可路由 Worker 上。通过 `[[platform_bindings]]` 选择的 Worker 是冷加载的平台能力，不是公开/runtime dispatch 目标，不能声明 cron triggers 或 queue consumers。

R2 custom metadata key 读取时会按 HTTP header 语义归一成小写。R2 object head 会暴露 HTTP metadata 和 custom metadata，所以鉴权上与读取 object body 同级，不开放给 observer 角色。R2 支持条件请求、range GET 和 `list({ include: [...] })` metadata hydration。 `list({ include })` 会在并发上限内额外发起 HEAD；只有列表结果确实需要 metadata 时再打开。

删除 Worker 不会删除 R2 数据。可以用 `wdl r2 buckets list` 和 `wdl r2 objects list <bucket>` 查看 namespace 内的 R2 数据；用 `wdl r2 objects head <bucket> <key>` / `wdl r2 objects get <bucket> <key>` 查看单个对象；用 `wdl r2 objects delete <bucket> <key> --yes` 显式删除单个对象。`wdl r2 buckets list` 是从已有对象 prefix 推出来的，所以已声明的 bucket 要到第一次 PUT 后才会出现。object delete 是幂等的单次 S3 DELETE，不做 retry，也不报告对象此前是否存在。对象不存在时，`HEAD` 遵循 HTTP 语义返回空 404； `wdl r2 objects head` 会显示状态码，不会有 JSON 错误体可解析。

`wdl r2 objects get` 会写出原始 object bytes。需要 stream bytes 时请 pipe 或重定向 stdout；在交互终端中请使用 `--out <path>`。

R2 object key 可以包含开头、结尾或连续的 `/` 分隔符；CLI 会保留这些 empty path segments。`.` 和 `..` segment 会被拒绝，避免 key 和 control-plane URL traversal 混淆。

### 环境覆盖

如果 Wrangler 配置里有 `[env.<name>]`，必须通过 `--env <name>` 或 `CLOUDFLARE_ENV` 显式选择；CLI 不会自动挑一个默认环境。和 Cloudflare Workers / Wrangler 不同，WDL 不会把环境名追加到 worker / script 名后面：`wdl deploy . --env preview` 仍然更新顶层 `name` 指定的 worker。`vars` 和大部分 bindings 仍是 env-scoped / non-inheritable：选中 env 后，顶层 `[vars]`、KV、D1、R2、queues、services、workflows 等不会自动进入该 env。需要同时跑 staging / production 时，默认用不同 namespace 区分，除非管理方另有约定。

### KV

配置：

```toml
[[kv_namespaces]]
binding = "VISITS"
id = "visits"
```

代码：

```js
const count = Number((await env.VISITS.get("count")) || "0") + 1;
await env.VISITS.put("count", String(count));

const profile = await env.VISITS.get("user:42", { type: "json" });
const avatar = await env.VISITS.get("user:42:avatar", { type: "arrayBuffer" });
const avatarStream = await env.VISITS.get("user:42:avatar", { type: "stream" });

return Response.json({ count });
```

支持常见 KV 操作：单 key `get`（text/json/arrayBuffer/stream value）、批量 `get`（text/json value）、`getWithMetadata`、批量 `getWithMetadata` （text/json value）、`put`、`delete`、`list` 和 `put(..., { expirationTtl | expiration })`。批量读取会在 proxy 前拒绝 arrayBuffer/stream shape。

`list({ metadata: true })` 会返回每个 key 的 metadata，且不会读取完整 value。返回 key 不保证排序，`limit` 是目标页大小且最多 1000，不透明 WDL cursor 必须原样传回。KV value 在代理前限制为 25 MiB；key（和 list 前缀）的字节长度限制为 512B，与 Cloudflare 一致——超过会报 `KV key exceeds 512 byte limit`。

WDL KV 写入会立即可见。key 过期时 value 和 metadata 会一起消失；不带过期时间重新 `put` 会清掉之前的过期设置。`cacheTtl` 会作为 Cloudflare KV API shape 被接受，但 WDL 没有 edge read cache，也没有全球最终一致性窗口，所以它不会改变读取行为。

### R2

用 Cloudflare 的 `[[r2_buckets]]` 形态声明 R2 binding：

```toml
[[r2_buckets]]
binding = "BUCKET"
bucket_name = "uploads"
```

Worker 使用常见 R2 object API：

```js
const url = new URL(request.url);
const key = url.searchParams.get("key") || "hello.txt";

if (request.method === "POST") {
  await env.BUCKET.put(key, request.body, {
    httpMetadata: { contentType: request.headers.get("content-type") || "application/octet-stream" },
  });
  return Response.json({ uploaded: key });
}

if (url.pathname === "/list") {
  const page = await env.BUCKET.list({ prefix: url.searchParams.get("prefix") || "" });
  return Response.json({ objects: page.objects.map((obj) => obj.key) });
}

const obj = await env.BUCKET.get(key);
if (!obj) return new Response("not found", { status: 404 });
return new Response(obj.body, {
  headers: { "content-type": obj.httpMetadata.contentType || "application/octet-stream" },
});
```

WDL 不会创建真实的 per-namespace S3 bucket。`bucket_name` 是部署时写进 bundle metadata 的虚拟 bucket 名；runtime 会把对象映射到平台 R2 S3 bucket 下的 `r2/<namespace>/<bucket_name>/<key>`。同 namespace 里多个 Worker 使用同一个 `bucket_name` 时会共享同一个虚拟 bucket；不同 namespace 通过 prefix 隔离。

当前支持 `head`、`get`、`put`、`delete`、`list` 等常用路径。需要时也可以使用条件读取、range GET 和 `list({ include })` metadata hydration；metadata hydration 会在并发上限内额外发起 HEAD。`put(stream, ...)` 目前会先 buffer，再做单次 S3 PUT，最大 25 MiB。multipart upload、SSE-C、checksum selection 暂不支持。

用 `wdl r2` 命令查看或显式删除 namespace 内的 R2 数据：

```bash
wdl r2 buckets list
wdl r2 objects list uploads --prefix images/
wdl r2 objects head uploads images/logo.png
wdl r2 objects get uploads images/logo.png --out logo.png
wdl r2 objects delete uploads images/logo.png --yes
```

`examples/inspection-demo` 展示了 R2 + D1 + KV + Assets 组合使用。

### D1

部署绑定 D1 的 Worker 前，先创建数据库：

```bash
wdl d1 create main
```

然后声明 binding 并部署 Worker：

配置：

```toml
[[d1_databases]]
binding = "DB"
database_name = "main"
migrations_dir = "migrations"
```

代码：

```js
const { results } = await env.DB.prepare("select 1 as ok").all();
return Response.json(results[0]);
```

部署：

```bash
wdl deploy .
```

`database_name` 在你的 namespace 内唯一。`wdl deploy` 接受 Cloudflare 的 D1 binding 配置形态，但数据库 lifecycle 和 migrations 走本平台的 `wdl d1` 命令，不走 `wrangler d1`。`wdl d1 migrations status/apply` 会读取匹配 `[[d1_databases]]` entry 的 `migrations_dir`，除非显式传了 `--dir`；匹配时 `database_id` 优先于 `database_name`。`migrations_dir` 和显式 `--dir` 都必须留在项目根目录内。如果 Wrangler 配置里声明了 D1 bindings，但没有任何一条能匹配这次命令传入的数据库引用，CLI 会直接报错，并提示改用配置里的 `database_name` / `database_id` 或显式传 `--dir`；不会静默回退到 `./migrations`。`preview_database_id` 和 `migrations_table` 不参与 WDL。

Migration 是 forward-only。WDL 使用 migration 文件名作为 migration id，已经 apply 的 migration 文件不应重命名或修改；重命名会被视为一条新的 migration。平台不提供自动 down/rollback workflow。若 Worker 版本可能 rollback，migration 应按 expand/contract 方式编写。

以 `_cf_` 开头的 SQLite object name 是 workerd 保留名，大小写不敏感。不要创建或 `RENAME TO` 到 `_cf_*` 形式的 D1 table、index、trigger 或 view；包含这类 DDL 的 migration 在新数据库上可能失败。已经 apply 的 migration 文件不要回改；需要修正时新增 forward migration，把应用数据迁到非保留名称。

常用命令：

```bash
wdl d1 list
wdl d1 execute main --sql "select 1"
wdl d1 migrations list main
wdl d1 migrations status main
wdl d1 migrations apply main
wdl d1 delete main
```

`wdl d1 execute` 要求 `--sql` 和 `--file` 二选一（即使是 `--sql ""` 也会和 `--file` 互斥），且被选中的 SQL 来源必须非空。`--file` 必须存在、可读，并留在项目根目录内；文件缺失或不可读时 CLI 会先在本地拒绝，不会联系 control。

`wdl d1 delete` 默认会要求确认。自动化脚本里只有在已有独立安全检查后，才建议传 `--yes`。

D1 运行时请求在执行前有边界：binary query body 最大 8 MiB；解码后的请求最多 1000 条 SQL 语句，SQL 加 params 聚合最大 8 MiB；结果 body 受平台默认 16 MiB 聚合上限保护。多语句 `exec()` 会在同一个 SQLite transaction 中执行；如果后面的语句失败，这次 `exec()` 里之前已经执行的语句会回滚。

`wdl d1 migrations status/apply` 走 control-plane JSON request parser，所以请求体上限是 1 MiB。特别大的 migration 集合或 SQL 文件应拆成更小批次再 apply。

`examples/d1-demo` 提供了一个最小 visitor counter 示例，包含 D1 binding 和 forward-only migration。

### Durable Objects

在 Wrangler 配置里声明 Durable Object binding。class 必须在同一个 Worker 里，并列入 `[[migrations]].new_classes` 或 `[[migrations]].new_sqlite_classes`：

```toml
[[durable_objects.bindings]]
name = "ROOMS"
class_name = "Room"

[[migrations]]
tag = "v1"
new_classes = ["Room"]
```

```js
import { DurableObject } from "cloudflare:workers";

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
  }

  async fetch(request) {
    this.ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS hits (name TEXT PRIMARY KEY, value INTEGER NOT NULL)"
    );
    return Response.json({ objectId: String(this.ctx.id) });
  }
}

export default {
  async fetch(request, env) {
    const id = env.ROOMS.idFromName("main");
    return env.ROOMS.get(id).fetch(request);
  },
};
```

当前支持 `stub.fetch()`、JSON-structured `stub.method(...args)` RPC、native `ctx.storage`、同步 `ctx.storage.sql`、alarm、普通 WebSocket upgrade 以及 native WebSocket hibernation API surface。跨 script binding、rename/delete migration、平台级 WebSocket session/cursor 恢复暂未实现。

使用 `ctx.storage.sql` 时，不要使用以 `_cf_` 开头的应用表名；workerd 对这个前缀做大小写不敏感保留。`ctx.storage.deleteAll()` 也会保留平台自有的 `_cf_*` 表。

`examples/durable-objects-demo` 提供了最小的同 Worker Durable Object 计数器，使用 SQLite-backed storage 保存状态。

### Workflows

在 Wrangler 配置里为当前 Worker 内的 workflow class 声明 binding：

```toml
[[workflows]]
name = "orders"
binding = "ORDERS"
class_name = "OrderWorkflow"
```

用 `wdl workflows` 查看定义和管理实例：

```bash
wdl workflows list
wdl workflows instances api orders
wdl workflows status api orders order-123 --include-steps
wdl workflows pause api orders order-123
wdl workflows resume api orders order-123
wdl workflows restart api orders order-123 --yes
wdl workflows terminate api orders order-123 --yes
```

这是 WDL Workflows 支持，不是完整 Cloudflare Workflows parity。 `script_name`、跨 worker workflow、跨 worker callback、service-binding callback 和 Cloudflare source-AST visualizer 不支持。same-worker DO progress callback 和 runtime-observed parallel/DAG `step.do` execution 可用。

重要运行限制和编程规则：

- 每个 instance 的聚合 payload 上限是 16 MiB。超过上限的 step/event 写入会让请求失败；runtime 写入过大的 terminal result 时，会在同一个事务里把 instance 转为 failed。
- 一个 `step.do` 如果永久失败，本次 run 会进入 terminal failure，即使用户代码 catch 了这次抛错也一样。
- 单个 step 最多记录 1000 条 dependency edge。单次 dispatch turn 最多有 1000 个 in-flight workflow steps，并最多启动 1000 个 fresh backend steps。
- 用户代码必须 await 所有已启动的 `step.do`。run 在仍有 started step 未 settle 时返回会失败为 `workflow_invalid_step`。
- 并行 `step.do` sibling 必须在同一个同步 fan-out batch 创建。一旦 await 了其中一个 sibling，就必须等完整 batch 结束后才能启动下一批 durable step，这样 replay 才能计算相同的 dependency frontier。
- `step.sleep()`、`step.sleepUntil()` 和 `step.waitForEvent()` 会 suspend 整个 run，不能和其他 in-flight step 重叠。不要用 `Promise.race()` 只处理最快的 durable step 后立刻 sleep/wait，同时留下其他 started step 继续运行。

`examples/workflows-demo` 提供了最小的 workflow 示例，包含启动、查询状态和发送 approval 事件。

### Secrets

不要把密钥写进 `[vars]`。用 secret 命令：

```bash
printf '%s' "$STRIPE_KEY" | wdl secret put --worker hello STRIPE_KEY
wdl secret list --worker hello
wdl secret delete --worker hello STRIPE_KEY
```

自动化脚本需要 control 原始响应而不是人类可读摘要时，`wdl secret list`、`put`、`delete` 都可以传 `--json`。

也可以设置 namespace 级共享 secret：

```bash
printf '%s' "$DATABASE_URL" | wdl secret put --scope ns DATABASE_URL
```

同名变量优先级：worker secret > namespace secret > `[vars]`。 `wdl secret delete` 默认会要求确认。自动化脚本里只有在已经校验过目标 namespace、scope 和 key 后，才建议传 `--yes`。

生效时机：

- 已有线上版本的 Worker 修改 worker-level secret 时，平台会自动创建并 promote 一个新版本，因此新流量会 cold-load 更新后的 secret。已经加载的历史版本可能继续持有旧值，直到 runtime eviction 或 recycle。
- worker-level secret 修改是原子的。如果 mutation 期间 active version 变化，control 会返回 `secret_mutation_contention`，CLI 会要求重试，而不是留下"已存储但未 promote"的半成功状态。
- `secret_encryption_unconfigured`、`secret_decrypt_failed`、`invalid_envelope`、`unsupported_envelope`、`unknown_kid` 或 `secret_not_encrypted` 这类 secret-envelope 错误表示 mutation 没有写入；等运维侧修复 envelope 配置或已存储数据后再重试。
- worker-level secret 可以在第一次部署前设置；第一次部署会读取这些 secret。
- namespace-level secret 会共享给 namespace 下的所有 Worker，但不会批量 bump 所有 Worker。它会在下一次自然 cold-load 时生效，例如新部署、runtime recycle 或 isolate eviction。
- secret key 必须符合环境变量命名规则，例如 `STRIPE_KEY`；value 最大 64 KiB，并且和 `[vars]` 一样计入 workerLoader env budget。

### Queues

生产者：

```toml
[[queues.producers]]
binding = "JOBS"
queue = "jobs"
```

```js
await env.JOBS.send({ type: "sync", id: "123" });
await env.JOBS.send({ type: "later" }, { delaySeconds: 60 });
await env.JOBS.sendBatch([
  { body: { id: "a" } },
  { body: "plain text" },
]);
```

消费者：

```toml
[[queues.consumers]]
queue = "jobs"
max_batch_size = 10
max_batch_timeout = 5
max_retries = 3
retry_delay = 10
dead_letter_queue = "jobs-dlq"
```

```js
export default {
  async queue(batch, env, ctx) {
    for (const msg of batch.messages) {
      try {
        await handleJob(msg.body);
        msg.ack();
      } catch {
        msg.retry({ delaySeconds: 30 });
      }
    }
  },
};
```

生产者限制：单条消息 body 最大 128,000 bytes；`sendBatch()` 最多 100 条；batch body 总量最大 256,000 bytes。

Queue backlog metrics 目前只是占位形状：`send()` / `sendBatch()` 会带 CF 形状的 metadata，`queue.metrics()` 也存在；但 `backlogCount` 和 `backlogBytes` 当前返回 `0`，不是实时 queue depth。

Queue consumers 是 runtime dispatch 目标。把它声明在可路由的 tenant Worker 上，不要声明在 platform binding target Worker 上。

租户可以依赖的 Queue 行为：

| 能力 | 行为 |
| --- | --- |
| Body 类型 | 默认是 `json`。字符串 payload 用 `{ contentType: "text" }`，`Uint8Array` payload 用 `{ contentType: "bytes" }`。不支持 `v8` structured clone payload。 |
| 发送延迟 | `[[queues.producers]].delivery_delay` 是默认发送延迟，单位秒。`send(body, { delaySeconds })` 和 `sendBatch()` 每条消息上的 `delaySeconds` 会覆盖默认值；`delaySeconds: 0` 表示立即投递。 |
| 重试延迟 | `[[queues.consumers]].retry_delay` 是默认重试延迟，单位秒。`msg.retry({ delaySeconds })` / `batch.retryAll({ delaySeconds })` 会覆盖默认值；`delaySeconds: 0` 表示立即重试。 |
| attempts | handler 看到的 `msg.attempts` 首投从 `1` 开始。`max_retries = N` 时，一条消息最多会被投递 `N + 1` 次，然后进入死信处理。 |
| 死信队列 | 尊重 `dead_letter_queue` 配置；未配置时使用该 queue 的默认 DLQ。 |
| Batch timeout | CLI 会转发通过基础整数 delay 解析的 `max_batch_timeout` 以兼容配置；WDL control 负责执行更严格的 Cloudflare 兼容 0..60 秒范围。当前 dispatch 由 `max_batch_size` 截断，不应依赖 timeout 触发 batch flush。 |
| 不支持的配置 | `max_concurrency` 会在部署阶段直接拒绝，不会静默忽略。 |

`examples/queues-demo` 提供了单 Worker 生产、消费 queue 消息，并把投递状态写入 KV 的完整示例。

### Cron

Cloudflare 兼容写法如下，按 UTC 执行：

```toml
[triggers]
crons = ["*/5 * * * *"]
```

如果需要按指定时区触发，可以使用本平台扩展写法：

```toml
[[triggers.schedules]]
cron = "0 9 * * 1-5"
timezone = "Asia/Shanghai"

[[triggers.schedules]]
cron = "0 18 * * *"
timezone = "America/Los_Angeles"
```

`[[triggers.schedules]]` 不是 Cloudflare 标准配置；如果同一份项目也要部署到 Cloudflare，请使用 `[triggers] crons`，不要依赖这个扩展。

Cron triggers 是 runtime dispatch 目标。把它声明在可路由的 tenant Worker 上，不要声明在 platform binding target Worker 上。

代码：

```js
export default {
  async scheduled(event, env, ctx) {
    await doWork();
  },
};
```

### Assets

```toml
[assets]
directory = "./public"
```

```js
const logoUrl = await env.ASSETS.url("logo.png");
return Response.redirect(logoUrl);
```

这里只支持 `assets.directory` 这类“Worker 返回资源 URL，浏览器直接取静态资源”的模式。Cloudflare Workers Assets 的 `run_worker_first` 拦截模式尚未实现；即使配置了也不会生效。如果静态文件必须经过 Worker 鉴权或改写，请把文件打进 Worker bundle，由 Worker 自己返回。

发送给 control 的 deploy manifest JSON 最大 32 MiB。Assets 会在部署时以 base64（约 4/3 膨胀）嵌进这个 JSON 请求，所以大量静态文件可能先撞到 control request cap，而不是运行时限制。CLI 另外在打包前预检：单文件最大 25 MiB、总量最大 100 MiB。大体积或频繁变化的文件应使用 R2。

CLI 默认跳过 assets 目录里的 `.git/`、`node_modules/`、`.DS_Store`、 `.wrangler/`、`.deploy-dist/`、`.wrangler.wdl-tmp*.json`、`.env`/`.env.*`，不作为静态资源上传；deploy 会输出一行 note 列出被跳过的条目。需要排除更多文件（或用 `!pattern` 行刻意取回某个默认排除项）时，在 assets 目录放一个 gitignore 语法的 `.assetsignore` 文件——与 Cloudflare Workers Assets 同一机制。 `.assetsignore` 本身默认也不会上传。

### Service bindings

同 namespace 内 Worker 调 Worker：

```toml
[[services]]
binding = "AUTH"
service = "auth-worker"
```

```js
const res = await env.AUTH.fetch(request);
```

具名 entrypoint：

```toml
[[services]]
binding = "BILLING"
service = "billing-worker"
entrypoint = "Billing"
```

跨 namespace 调用需要**目标** Worker 在自己的 `[[exports]]` 里授权你要调用的 entrypoint（默认 fetch handler 用 `entrypoint = "default"`，命名 entrypoint 用类名）：

```toml
[[exports]]
entrypoint = "default"
allowed_callers = ["acme"]
```

顶层 `allowed_callers` 不支持 —— 授权只写在目标的 `[[exports]]` 里，`wdl deploy` 会直接拒绝顶层写法。

Service binding 在部署时解析并绑定到目标当时的线上版本。目标 Worker 后续升级不会自动影响已经部署的调用方；调用方重新部署后才会绑定到目标的新版本。如果目标修改了它的 `[[exports]]`（`allowed_callers` 或 `required_caller_secrets`），已经部署的调用方仍会使用旧的解析结果，直到调用方重新部署。

`export default function(request, env, ctx)` 会被当作 fetch handler 简写，并通过 `.fetch(...)` 暴露；它不是可直接调用的 default RPC method。RPC method 应放在命名 `WorkerEntrypoint` 上，或放在 default object / class 的方法上。

### Platform bindings

如果平台提供了第一方共享能力，你只需要绑定平台给出的符号名：

```toml
[[platform_bindings]]
binding = "PAYMENT"
platform = "STRIPE"
```

```js
const result = await env.PAYMENT.charge({ amount: 100 });
```

`binding` 和 `platform` 必须是大写下划线形式，例如 `PAYMENT`、`JSJ_BRIDGE`。如果该平台能力要求 caller secret，部署时 CLI 会提示缺少哪些 secret。

## 附录：高级运行时 HTTP API

除了 bindings，加载的 Worker 还能直接使用 workerd 的标准运行时 API。如果只是写普通 HTTP API Worker，可以先跳过这一节。下面这些都在本平台端到端验证过，可以直接用。

### WebSocket

在 `fetch` 里返回带 `WebSocketPair` 的 101 响应即可，升级握手和后续帧会原样穿过平台各层：

```js
export default {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected websocket", { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    server.addEventListener("message", (evt) => server.send("echo:" + evt.data));
    return new Response(null, { status: 101, webSocket: client });
  },
};
```

### 流式响应 (SSE / chunked)

body 为 `ReadableStream` 的 `Response` 会被逐块透传，平台不做缓存。适合 `text/event-stream`、渐进式下载、长连推送等。

### 原始 TCP：`cloudflare:sockets`

`import { connect } from "cloudflare:sockets"` 可用；租户 ns 只能连公网 TCP 端点，平台内网地址会被 workerd 的网络边界挡掉。

```js
import { connect } from "cloudflare:sockets";

export default {
  async fetch() {
    const sock = connect("example.com:80");
    // 通过 sock.writable / sock.readable 收发 …
  },
};
```

### 客户端断开

响应头发出后，`request.signal` **不再可靠** —— workerd 认为响应已提交，不再 abort 入站 Request。响应 body 的 `ReadableStream.cancel` 也只能按 best-effort 使用：长流应配合周期性写入/heartbeat，捕获下游读者离开后 `controller.enqueue` 抛错的情况，并为需要确定性清理的协议保留应用层 timeout 或 close message。如果有必须在响应流水线拆除之后仍然完成的副作用（日志、计数器等），请在请求一开始就注册 `ctx.waitUntil`；从 `cancel` 内部再调用 `waitUntil` 会和 IoContext teardown 赛跑。

```js
const { promise: outcome, resolve: resolveOutcome } = Promise.withResolvers();
ctx.waitUntil((async () => { console.log("client:", await outcome); })());

const stream = new ReadableStream({
  async start(controller) {
    try {
      controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"));
      resolveOutcome("ended-normally");
    } catch {
      resolveOutcome("downstream-gone");
    }
  },
  cancel() { resolveOutcome("cancel"); },
});
return new Response(stream);
```

## 命名约束

常用命名规则：

- namespace：1-63 个小写字母、数字、短横线，且必须以小写字母或数字开头和结尾，例如 `acme-prod`。`__foo__` 这类双下划线形式是平台保留名称，不要写进 tenant 配置。
- worker name：字母、数字、下划线、短横线，以字母或数字开头。
- KV id / queue name：小写字母、数字、短横线。
- binding name：合法 JavaScript 标识符，例如 `DB`、`MY_QUEUE`、`authService`。
- platform binding：大写字母、数字、下划线，例如 `PAYMENT`。

## 常用操作命令

列出当前 namespace 下的 Worker：

```bash
wdl workers
```

删除非线上版本：

```bash
wdl delete version hello v1
```

删除整个 Worker 前先预览：

```bash
wdl delete worker hello --dry-run
```

确认后删除：

```bash
wdl delete worker hello
```

`wdl delete worker` 默认会要求确认。建议先用 `--dry-run` 预览受影响的线上版本、保留版本、路由、worker secrets、queue consumers 和资产清理。自动化脚本里只有在已有独立安全检查后，才建议传 `--yes`。

确认后删除 D1 数据库：

```bash
wdl d1 delete main
```

实时查看 Worker 日志：

```bash
wdl tail hello
```

## 常见问题排查

| 现象 | 可能原因 | 检查方式 |
| --- | --- | --- |
| `Missing admin token` | 没有提供 tenant token | 运行 `wdl token set --ns <ns> --control-url <url>`（推荐），或设 `ADMIN_TOKEN` / 传 `--token` |
| `wrangler build failed` | Wrangler 无法打包 Worker 项目 | 在 Worker 项目目录执行 `npx wrangler deploy --dry-run`，先修本地构建或配置错误 |
| deploy 成功但 promote 失败 | route、自定义 host 或 binding 在 promote 阶段校验失败 | 确认自定义 host 已为你的 namespace 开通，service binding 目标存在 |
| Worker URL 返回 404 | URL 形态或 worker name 不对 | 使用 `https://<namespace>.<platform-domain>/<worker-name>/`，不要漏掉 worker name 这一段路径 |
| Worker URL 返回 `502 runtime_error` | Worker `fetch()` handler 在产生响应前抛错 | 用 `wdl tail <worker>` 和请求日志排查；异常细节不会复制到客户端响应体 |
| namespace-level secret 没有立刻变化 | namespace secret 不会给所有 Worker 自动 bump 版本 | 重新部署该 Worker，或等待自然 cold-load；需要立即发布时使用 worker-level secret |
| service binding 仍调用旧目标行为 | binding 在调用方部署时固定版本 | 重新部署调用方 Worker |
| `wdl tail` 没有历史日志 | tail 是 live-only；首次连接只看之后的新事件 | 先打开 `wdl tail <worker>`，再触发请求；需要手动续读时使用单 worker 的 `--since <stream-id>` |
| 多 worker `wdl tail` 重连后可能少日志 | 一个连接无法同时保存多个 worker 的独立续读位置 | 对关键 worker 单独运行 `wdl tail <worker>` |
| `tail session_idle` / `tail session_expired` | control 因客户端停止读取或会话达到时长上限而回收 live-tail stream | CLI 会自动重连；如果反复出现，确认终端或外层 wrapper 正在消费输出 |
| scheduled / queue handler 的 `console.*` 没出现在 `wdl tail` | `wdl tail` 显示 fetch / scheduled / queue start/finish；scheduled / queue handler 内部 console 不进入 tail 流 | 用 `wdl tail` 确认触发和 outcome；handler 内部 console 到常规日志平台按时间窗口排查 |

## 兼容性总结

你可以把本平台理解为"用 Cloudflare Workers 写法开发，用平台 CLI 部署"的运行环境：Worker module 语法、`fetch`、`scheduled`、`queue` handler 按 Cloudflare Workers 心智模型编写，wrangler 项目可以直接部署（支持 `wrangler.toml`、`wrangler.jsonc`、`wrangler.json`）。

矩阵右侧三列把差异分为三类。**更强 / 新增**——架构差异带来的优势（单区意味着强一致，而 Cloudflare 是最终一致）以及 WDL 在 Cloudflare 之外补充的能力；**语义差异**——模型不同但不构成强弱，知道即可；**未实现**——该能力面确实不存在。

| 能力面 | 状态 | 更强 / 新增 | 语义差异 | 未实现 |
| --- | --- | --- | --- | --- |
| Module Workers（`fetch` / `scheduled` / `queue`） | 支持 | — | 未捕获异常返回平台 `502 runtime_error`；异常详情进 `wdl tail` 和日志，不进响应体 | — |
| WebSocket 升级 | 支持 | — | — | 平台重启后的会话自动恢复；客户端应重连 |
| 流式响应、出站 TCP（`cloudflare:sockets`） | 支持 | — | 租户 worker 只能连公网端点；平台内网地址被阻断 | — |
| `compatibility_date` / `compatibility_flags` | 部分 | — | 平台运行单一 workerd 配置；不按 worker 逐个模拟 Cloudflare 的历史行为变更 | — |
| KV | 支持 | 写入立即可见——Cloudflare 的边缘复制是最终一致，这里是强一致 | `cacheTtl` 可接受但不是新鲜度契约 | — |
| R2 | 支持 | — | 单区对象存储 | Multipart 上传、`preview_bucket_name`、`jurisdiction` |
| 静态资源 | 部分 | `env.ASSETS.url(path)` 发放带 token 的 CDN URL——WDL 新增能力 | — | Cloudflare Pages 式资源管线、fetch 形态的 assets binding |
| D1 | 部分 | 单主库——默认读己之写，没有复制延迟和 bookmark 语义需要操心 | 请求/结果有大小上限；生命周期和迁移用 `wdl d1` 管理，`[[d1_databases]]` 只作为 binding 声明 | 读副本复制、Time Travel / bookmarks |
| Durable Objects | 部分 | — | 仅同 worker 内 class；`new_classes` 与 `new_sqlite_classes` 在 WDL 等价 | `script_name`（跨 script binding）、rename/delete migration、WebSocket 会话/游标恢复 |
| Queues | 部分 | — | 按 batch 大小驱动派发；`max_batch_timeout` 为配置兼容而保存，不是聚合窗口 | `max_concurrency`（显式拒绝）、`contentType: "v8"` |
| Cron 触发器 | 支持 | — | Cloudflare 兼容表达式，按 UTC 执行；best-effort 分钟槽——错过的槽跳过不补发，失败不重试 | — |
| Workflows | 部分 | 并行 / DAG step 在运行时实测捕获，包括 `Promise.all` 并行分支 | WDL 自有的 payload 语义；payload 与单 turn step fan-out 有上限；严格 await 顺序；`step.do` 永久失败即终止运行（即使被 catch） | 完整 Cloudflare Workflows 对等、`script_name` / 跨 worker workflow 与 callback、source-AST 可视化 |
| Service bindings | 支持 | — | — | — |
| Platform bindings | 支持 | WDL 新增、Cloudflare 无对应物：运维方管控的平台能力经 `[[platform_bindings]]` 注入 `env` | — | — |
| Vars 与 secrets | 支持 | — | Secrets 由平台管理（`wdl secret` 写入），不是 Cloudflare 账号 secrets | — |
| Cache API（`caches.default`） | 不支持 | — | — | 未暴露；不要依赖它 |
| Workers AI、Vectorize、Analytics Engine、Browser Rendering、Hyperdrive、Email | 不支持 | — | — | 无 binding；部署阶段显式拒绝这些配置段 |

与 Cloudflare 账号资源无关：`kv_namespaces.id`、queue 名、platform binding 名都是本平台内的资源名。
