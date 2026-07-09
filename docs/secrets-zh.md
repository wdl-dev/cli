# Secrets —— `wdl secret` 参考

## 是什么

运行时密钥是 worker 在请求时读取的键值对，不会被打包进 bundle。通过 `wdl secret put` 设置；worker 端通过 `env.<KEY>` 读取。

不要把密钥放进 `[vars]` —— `[vars]` 的值是 bundle 的一部分，任何有读权限的人都能看到。

## 何时使用

- API key、token、签名密钥，凡是不该出现在 git diff 或构建产物里的东西。

非敏感配置（问候字符串、功能开关、公开 URL）放 `wrangler.json` / `wrangler.jsonc` / `wrangler.toml` 的 `[vars]`。

## 设置

```bash
# Worker 级（最常见）。会 promote 一个新版本；新流量 cold-load 更新后的值。
printf '%s' "$VAL" | wdl secret put --worker <worker-name> KEY

# 命名空间级（共享）。在下一次自然冷启动时生效 —— **不会** bump
# 每个 worker。慎用，仅在该值确实应该跨命名空间所有 worker 共享时
# 才用。
printf '%s' "$VAL" | wdl secret put --scope ns KEY
```

用 `printf '%s'`（不要用 `echo`），避免在密钥值末尾带上换行符。

## 列举与删除

```bash
wdl secret list --worker <worker-name>
wdl secret list --scope ns

wdl secret delete --worker <worker-name> KEY
wdl secret delete --scope ns KEY
```

自动化脚本需要原始 control 响应时，`list` / `put` / `delete` 都可以加 `--json`。 `wdl secret delete` 默认会提示确认。先 `wdl secret list` 看一眼，确认没看错；**不要**主动加 `--yes`。

## 运行时优先级

```
worker 级 secret  >  命名空间级 secret  >  [vars]
```

同名 key 的 worker 级 secret 会盖过命名空间级。`[vars]` 里的同名条目会被两种 secret 都遮蔽。

修改 worker 级 secret 会创建并 promote 新版本，但已经加载的历史版本可能继续持有旧值，直到 runtime eviction 或 recycle。需要严格撤销时，应同时考虑禁用旧凭据。

Worker 级 secret mutation 是原子的：如果更新期间 active version 变化，control 会返回 `secret_mutation_contention`，CLI 会要求重试，而不是留下"已存储但未 promote"的半成功状态。Namespace secret mutation 在 retained worker metadata 持续变化时也可能返回 `namespace_secret_mutation_contention`。

如果 secret mutation 返回 `secret_encryption_unconfigured`、`secret_decrypt_failed`、`invalid_envelope`、`unsupported_envelope`、`unknown_kid` 或 `secret_not_encrypted`，这次 mutation 没有写入。这类错误需要运维侧修复 secret-envelope 配置或已存储 envelope 数据；等运维确认修复后再重试。

## 约束

- Key 必须符合环境变量命名规范：`[A-Z_][A-Z0-9_]*` —— 例如 `STRIPE_KEY`、`API_TOKEN`、`SIGNING_SECRET`。
- 值上限 64 KiB。
- Secrets 会和 `[vars]`、binding metadata 一起计入 workerLoader env budget。如果 mutation 返回 `worker_env_too_large`，减少 env payload；如果错误点名 retained version，redeploy/delete 该版本。

## Worker 端读取

```js
export default {
  async fetch(request, env) {
    const stripeKey = env.STRIPE_KEY;       // worker 级或 ns 级
    // ...
  },
};
```

## 反模式

- ❌ `[vars] = { STRIPE_KEY = "sk_live_..." }`。`[vars]` 会进 bundle。用 `wdl secret put`。
- ❌ 把第三方 API token 硬编码到 `.env` 或 Wrangler config。用 `wdl secret put` 推送。
- ❌ 在没有先 `wdl secret list` 并跟用户确认时，给 `wdl secret delete` 加 `--yes`。
- ❌ 用 `echo "$VAL" |` 而不是 `printf '%s' "$VAL" |`。`echo` 会在末尾加换行符，被一并写进 secret 值里。
- ❌ 期望命名空间级 secret 立即给每个 worker 生效。它不会 —— 下次冷启动时才生效。需要"立刻生效"用 worker 级 secret。

## 相关

- [deploy-zh.md](./deploy-zh.md) —— `ADMIN_TOKEN`（部署凭证，不是运行时密钥）。
