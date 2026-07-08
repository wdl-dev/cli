# D1 —— SQL / 关系型存储

## 是什么

命名空间级的 SQL 数据库，在 worker 中通过 `env.<DB>` 用 prepared statements 访问。Schema 通过 `migrations/` 目录下的文件管理；用 `wdl d1 migrations` 显式应用，**不可回滚**。

## 何时使用

- 关系型数据：外键、JOIN、多行查询。
- 跨请求共享的持久化应用状态。

如果只是小型 key-value 查找，优先用 KV —— 见 [kv-zh.md](./kv-zh.md)。大型 blob 用 R2 —— 见 [r2-zh.md](./r2-zh.md)。

## Wrangler 配置

```toml
[[d1_databases]]
binding = "DB"
database_name = "main"
migrations_dir = "migrations"
```

或在 `wrangler.jsonc`：

```jsonc
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_name": "main",
      "migrations_dir": "migrations"
    }
  ]
}
```

`binding` 是运行时暴露的名字（`env.DB`）。`database_id` 如果存在会优先作为平台数据库引用；否则使用 `database_name`。这里的值是平台本地的 D1 名或 alias，**不是** Cloudflare 的 UUID。

## 设置

首次部署前先创建数据库：

```bash
wdl d1 create main
```

然后在 `migrations/` 下加 SQL 迁移文件：

```
migrations/
  0001_create_users.sql
  0002_add_email_index.sql
```

文件名就是迁移 ID。应用：

```bash
wdl d1 migrations status main      # 查看待应用
wdl d1 migrations apply main       # 单向，不能回滚
```

`migrations_dir` 和显式 `--dir` 都必须留在项目根目录内。

迁移一旦应用就不可改。**绝对不要**重命名或修改已应用的文件 —— CLI 通过文件名追踪，重命名会被当作全新的迁移再执行一次。

## Worker 端读写

```js
export default {
  async fetch(request, env, ctx) {
    // SELECT
    const { results } = await env.DB
      .prepare("SELECT id, name FROM users WHERE active = ?")
      .bind(1)
      .all();

    // INSERT
    await env.DB
      .prepare("INSERT INTO users (name, email) VALUES (?, ?)")
      .bind("Alice", "alice@example.com")
      .run();

    // 单行
    const row = await env.DB
      .prepare("SELECT * FROM users WHERE id = ?")
      .bind(42)
      .first();

    return Response.json({ results });
  },
};
```

所有用户控制的值都用 `.bind(...)`。**绝不**把值字符串拼接到 SQL 里 —— D1 支持 prepared statements，正是为了避免 SQL 注入。

## 从 CLI 检查

```bash
wdl d1 list
wdl d1 execute main --sql "SELECT name FROM sqlite_master WHERE type='table'"
wdl d1 execute main --file query.sql
wdl d1 execute main --sql "SELECT * FROM users WHERE id = ?" --params '[42]'
wdl d1 execute main --sql "DELETE FROM tmp" --mode run   # all | raw | run | exec
```

`wdl d1 execute` 既能读也能写。破坏性语句之前先跑只读版本（例如 `DELETE` 之前先 `SELECT COUNT(*)`）。

`--sql` 和 `--file` 必须二选一（即使是 `--sql ""` 也会和 `--file` 互斥）。被选中的 SQL 来源必须非空。

`--mode` 选结果形态（`all` / `raw` / `run` / `exec`）；`exec` 跑一批语句，不接受 `--params`——这个组合 CLI 会在本地直接拒掉。

D1 请求在执行前会被限流：binary query body 最大 8 MiB；解码后的请求最多 1000 条 SQL 语句，SQL 加 params 聚合最大 8 MiB；每条语句最多返回 65,536 行（对齐 Cloudflare D1，超限报 `limit-exceeded`）；结果 body 受平台默认 16 MiB 聚合上限保护。多语句 `exec()` 在同一个 SQLite transaction 中执行；如果后面的语句失败，这次 `exec()` 里之前已经执行的语句会回滚。

D1 migration 管理走 control-plane JSON request parser，所以 `wdl d1 migrations status/apply` 请求体上限是 1 MiB。特别大的 migration 集合或 SQL 文件应拆成更小批次再 apply。`d1 execute --file` 的路径必须存在、可读，并且留在项目根目录内；文件缺失或不可读时 CLI 会在本地拒绝，不会联系 control。

以 `_cf_` 开头的 SQLite object name 是 workerd 保留名，大小写不敏感。不要创建或 `RENAME TO` 到 `_cf_*` 形式的应用 table、index、trigger 或 view；包含这类 DDL 的 migration 在新数据库上可能失败。已经 apply 的 migration 文件不要回改；需要修正时新增 forward migration，把应用数据迁到非保留名称。

## 删除数据库

```bash
wdl d1 delete <name>           # 默认提示确认；和用户确认后再加 --yes
```

删除 worker **不会**删除 D1 数据。要删数据用 `wdl d1 delete`。明确跟用户确认 —— 没有撤销。

## 反模式

- ❌ 重命名已应用的迁移文件。会被再应用一次。
- ❌ 修改已应用的迁移内容。不会重跑；schema 和文件不一致。
- ❌ 把值字符串拼接到 SQL。永远 `.bind(...)`。
- ❌ 跳过首次部署的 `wdl d1 create`。`[[d1_databases]]` 条目**不会** 自动创建数据库。
- ❌ 以为 `database_id` 会被忽略。CLI 会优先匹配 `database_id`，没有时才回退到 `database_name`。

## 端到端示例

`../examples/d1-demo` —— 最小的 D1 + 迁移配置。`../examples/inspection-demo` 把 D1 与 KV / R2 / assets 组合。

## 相关

- [secrets-zh.md](./secrets-zh.md) —— D1 查询可能要用的运行时密钥（如加密 key）。
- [deploy-zh.md](./deploy-zh.md) —— 部署前后的检查流程，以及何时运行 D1 迁移。
