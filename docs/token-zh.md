# Tokens —— `wdl token` 参考

[English](./token.md) | 中文

## 是什么

`wdl token` 管理本地凭证存储 `~/.config/wdl/credentials`（`$XDG_CONFIG_HOME/wdl/credentials`，Windows 上为 `%APPDATA%\wdl\credentials`），让命令无需每个 shell 都 export `ADMIN_TOKEN`、也无需在每个项目的 `.env` 里放 token 就能解析出 control URL 和 token。

没有"登录"这回事。WDL token 由运维方签发；`wdl token set` 只是把它存起来（存前会调 `/whoami` 校验，并确认其 principal 就是你要存入的那个 namespace），`wdl token rm` 删的是本地副本——**不会吊销** token。

存储用的是和项目 `.env` 相同的 `dotenv`/INI 方言，按 namespace 为 key，每条自包含。开头（任何段之前）的一行 `WDL_NS` 指定**默认 namespace**——即不带 `--ns` 时使用的那个，和项目 `.env` 里的 base `WDL_NS` 行为完全一致：

```ini
WDL_NS="acme"

[acme]
CONTROL_URL="https://api.example"
ADMIN_TOKEN="<token>"
LABEL="production"
```

它由命令独占：`wdl token` 会 canonical 重写整个文件（默认在前，然后排序、加引号的各段），所以项目专属的值请手编项目 `.env`。文件以 `0600` 权限写入。

## 命令

```bash
# 存 token。token 从 stdin 读（TTY 下隐藏输入）、调 /whoami 校验、确认属于 --ns 后再存。
# control URL 来自 --control-url 或 CONTROL_URL —— 绝不来自存储本身。
# 第一个存入的 namespace 自动成为默认；--default 可把任意一次 set 设为默认。
wdl token set --ns acme --control-url https://api.example
wdl token set --ns acme --control-url https://api.example --label production
wdl token set --ns demo --control-url https://api.example --default
printf '%s' "$TOKEN" | wdl token set --ns acme --control-url https://api.example

# 列出已存的 namespace 和脱敏 token；默认那个用 * 标记
# （--json 供脚本用，每行带 "default" 布尔字段，仍脱敏）。
wdl token list

# 选择哪个已存 namespace 作为默认（不带 --ns 时使用）。
wdl token use acme

# 删除某 namespace 的本地副本（不会在控制面吊销）。
wdl token rm --ns acme
```

## 在解析链中的位置

存储是优先级最低的凭证层：

```
CLI 标志 > shell/CI env > 项目 ./.env > 全局 token 存储 > 未配置（报错）
```

更高层的值总是胜出，存储只填空缺。解析按 namespace 进行：选中某条后，它同时提供 control URL 和 token。当某个值来自存储时，`wdl config explain` 会把来源显示为 `token store [<ns>].…`。

**选哪个 namespace** 走它自己的链，存储默认在最底层——和项目 `.env` 的 base `WDL_NS` 同形，只低一层：

```
--ns > shell/CI WDL_NS > 项目 ./.env 的 WDL_NS > 存储默认（base WDL_NS）
```

所以设了存储默认后，`wdl deploy`、`wdl doctor` 等不带 `--ns` 也能跑；要换别的就传 `--ns`（或 `wdl token use <ns>`）。当 namespace 来自存储默认时，`wdl config explain` 把来源显示为 `token store default`。

`wdl token` 子命令是这条链的例外：`set`、`use`、`rm` 会改动存储，所以它们只从显式 `--ns`（或 `use` 的位置参数）取 namespace —— 绝不取 ambient `WDL_NS` —— 以免一个游离的 shell 值写错、切错或删错条目。

存储是**可信**的（它在你的 home 目录、由你经 `wdl token` 写入，token 和端点同源）。项目 `.env` **不可信**：若一个 `.env` 提供了 control 端点却没同时提供 token，该端点仍会被丢弃——这样不可信的项目目录永远无法把你存的 token 重定向到它指定的主机。

## 反模式

- ❌ 把 `wdl token rm` 当吊销。它只删本地副本；在运维方吊销之前 token 仍然有效。
- ❌ 手编 `~/.config/wdl/credentials`。下次 `wdl token` 写入时会被 canonical 重写，你的改动（含注释）会丢失。手管的覆盖值请用项目 `.env`。
- ❌ 把 token 作为命令行参数传。`set` 从 stdin 读，避免进入 shell 历史——在提示符输入或用管道传入。
- ❌ 指望存储能覆盖 shell 或项目 `.env` 里已设的 token。它是最低层，只填空缺。

## 相关

- [deploy-zh.md](./deploy-zh.md) —— `ADMIN_TOKEN` / `CONTROL_URL` 的优先级，以及存储所处其下的 `.env` 结构。
- [secrets-zh.md](./secrets-zh.md) —— `wdl secret`，管理 worker 的运行时密钥（与这里管理的部署 token 是两回事）。
