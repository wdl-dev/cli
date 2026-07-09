# 环境覆盖 —— `[env.<name>]` 配置

## 是什么

Wrangler 配置可以定义环境级的覆盖（`vars`、`assets`、绑定等）——例如 `[env.preview]` 和 `[env.production]`。在 WDL 中，`--env <name>` 只选择哪组配置覆盖生效；部署出来的 worker 名仍然来自顶层 `name`。

## 何时使用

- worker 在 preview 和 production 的配置不同（不同的问候字符串、资源目录、 KV id、cron 节奏等）。
- 用户希望同一份代码部署到两个环境，不切分支也不做字符串替换。

如果 preview 和 production 的配置完全一致，就不要用 `[env.<name>]`，直接用同一配置部署两次。

## Wrangler 配置

```toml
name = "my-worker"
main = "src/index.js"
compatibility_date = "2026-06-17"

[vars]
SHARED = "top-level"
BASE_ONLY = "always-this"

[assets]
directory = "./top-public"

[env.preview]
[env.preview.vars]
ENV_NAME = "preview"
SHARED = "preview-override"

[env.production]
[env.production.vars]
ENV_NAME = "production"
SHARED = "production-override"

[env.production.assets]
directory = "./prod-public"
```

或在 `wrangler.jsonc` —— 形态相同，JSON 语法：

```jsonc
{
  "name": "my-worker",
  "main": "src/index.js",
  "compatibility_date": "2026-06-17",
  "vars": { "SHARED": "top-level", "BASE_ONLY": "always-this" },
  "assets": { "directory": "./top-public" },
  "env": {
    "preview": {
      "vars": { "ENV_NAME": "preview", "SHARED": "preview-override" }
    },
    "production": {
      "vars": { "ENV_NAME": "production", "SHARED": "production-override" },
      "assets": { "directory": "./prod-public" }
    }
  }
}
```

## 环境解析

只要存在 `[env.<name>]` 段，部署 CLI 就**强制**要求 `--env <name>`（或 `CLOUDFLARE_ENV` 环境变量）。它不会替你挑默认值。明确指定：

```bash
wdl deploy . --env preview
wdl deploy . --env production
```

解析顺序：`--env` 值 > `CLOUDFLARE_ENV` 环境变量 > 报错。

## WDL 与 Cloudflare Workers 的差异

Cloudflare Workers / Wrangler 的 `--env preview` 通常会发布带环境后缀的 worker / script 名。WDL 不会这样做：`wdl deploy . --env preview` 和 `wdl deploy . --env production` 都更新顶层 `name` 指定的同一个 worker。要部署两个独立 worker，请用两个不同的顶层 `name`、两个目录，或两个 namespace。

`vars` 和大部分 bindings 仍按 Wrangler 的 non-inheritable 心智模型处理：选中 `[env.<name>]` 后，顶层 `[vars]`、KV、D1、R2、queues、services、workflows 等不会自动继承到该 env。需要某个 runtime env 变量或 binding 时，要在对应的 `[env.<name>]` 里重新声明。

按上面的例子：

- `BASE_ONLY` 只写在顶层 `[vars]`，所以用 `--env preview` 或 `--env production` 部署时不会出现在 Worker `env` 里。
- `SHARED` 在 preview / production 的 vars 里都重新声明了，所以会分别是 `"preview-override"` / `"production-override"`。
- `ENV_NAME` 只写在 env vars 里，所以只有显式 `--env preview` 或 `--env production` 部署时才存在。

这些 vars 会进入 Worker 的 `env` 对象；它们不是当前 shell 的环境变量。敏感值仍然用 `wdl secret put`，不要写进 `[vars]`。

## Worker 名

部署出来的 worker 名**永远是顶层 `name`** —— 上面例子里就是 `my-worker`。**不会**有 `my-worker-preview` / `my-worker-production` 这种自动拆分。同一个 worker 被更新；promote 时切换哪个版本是 live。

如果想要每个环境完全独立的 worker 身份，用两份配置（两个 `name` 值，两份 `wrangler.toml` 或两个目录），不要用 `[env.<name>]`。

## 各环境的绑定

`[env.<name>]` 可以覆盖多类配置，但继承规则不同：

- Non-inheritable：`[env.<name>].vars`、`[[env.<name>.kv_namespaces]]`、`[[env.<name>.d1_databases]]`、`[[env.<name>.r2_buckets]]`、`[[env.<name>.queues.*]]`、`[[env.<name>.services]]`、`[[env.<name>.workflows]]` 等。选中 env 后，顶层同类配置不会回退进来。
- Inheritable：`main`、`compatibility_date` / `compatibility_flags`、`route` / `routes`、`[[migrations]]`、`[assets]`、`[triggers]` 等。env 里没写时继续使用顶层值；env 里写了则覆盖顶层值。

因此，共享的 `vars` 或 binding 不能只放顶层后期待所有 env 自动继承；每个 env 都需要声明自己要用的 runtime vars 和 bindings。共享的 DO migrations、assets / cron 等可放顶层，只在差异 env 下覆盖。

## 反模式

- ❌ 加了 `[env.<name>]` 但部署时忘了 `--env`。CLI 会报错；什么都部不出去。
- ❌ 传 `--env <name>` 但 wrangler 配置里没有对应的 `[env.<name>]` 块。 报 `environment "<name>" requested but no [env] config exists`，部署中止。需要环境覆盖时，配置块和部署脚本里的 `--env <name>` 必须保持一致。
- ❌ 把环境命名为 `[env.dev]` 然后期待它们部署到不同的 worker 名。 Worker 名永远来自顶层 `name`。
- ❌ 把共享 runtime vars 只写在顶层 `[vars]`，然后期待 preview / production 自动继承。`vars` 是 env-scoped；需要就每个 env 重声明。
- ❌ 把 secret 放进 `[env.<name>.vars]`。用 `wdl secret put` —— 见 [secrets-zh.md](./secrets-zh.md)。
- ❌ 大部分 inheritable 配置在 `[env.preview]` 和 `[env.production]` 下重复一遍。共享的 `main`、`compatibility_date`、assets、triggers 等可放顶层；只覆盖差异部分。

## 端到端示例

`../examples/env-overrides-demo` —— 演示 WDL 不给 worker 名加 env 后缀、`[env.<name>.vars]` 不继承顶层 `[vars]`，以及 production 如何覆盖顶层 assets 目录。

## 相关

- [deploy-zh.md](./deploy-zh.md) —— `--env` 标志和解析优先级。
- [assets-zh.md](./assets-zh.md) —— 各环境不同的资源目录。
- [secrets-zh.md](./secrets-zh.md) —— secret **不**通过 `[env.<name>]` 做环境隔离；它们绑定到部署出来的 worker。
