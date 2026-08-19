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

它由命令独占：`wdl token` 会 canonical 重写整个文件（默认在前，然后排序、加引号的各段），所以项目专属的值请手编项目 `.env`。文件以 `0600` 权限写入。读取时会拒绝非普通文件或 symlink 的 credentials 路径；在 POSIX 上还会 fail closed：文件必须属于当前用户，所在目录不能 group/world-writable，且 group/other 用户不可访问该文件。如果可信 store 的 owner 错误，请由管理员执行 `chown <user> <file>`，或删除后用 `wdl token set` 重建各条目；然后用 `chmod 700 <dir>` 和 `chmod 600 <file>` 修复权限。不要为了共享 store 放宽这些检查。

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

`wdl token` 会脱敏无效参数的细节。如果子命令前的 string option 使用分离式值，且该值是 `set`、`list`、`use` 或 `rm`，请把子命令放到前面，或改用 `--flag=value`；例如在该位置引用字面名为 `list` 的 namespace 时使用 `--ns=list`。

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

如果解析需要读取 store，而该次读取发现它损坏、无法读取或未通过安全检查，`wdl config explain` 会排除它，以成功状态展示剩余 flag / shell / `.env` 来源，并在人类可读的 `tokenStore` block 或 JSON `tokenStore.error` 中报告故障。这个诊断 fallback 不会放宽实际操作命令：它们需要 store 时仍会 fail closed。如果更高优先级来源已经覆盖 namespace、control URL 和 token，CLI 不会读取或诊断 store。

`wdl token` 子命令是这条链的例外：`set`、`use`、`rm` 会改动存储，所以它们只从显式 `--ns`（或 `use` 的位置参数）取 namespace —— 绝不取 ambient `WDL_NS` —— 以免一个游离的 shell 值写错、切错或删错条目。

通过上方路径和权限检查的存储才被视为**可信**：token 和端点同源，存放在受保护的用户级配置目录中。项目 `.env` **不可信**：若一个 `.env` 提供了 control 端点却没同时提供 token，该端点仍会被丢弃——这样不可信的项目目录永远无法把你存的 token 重定向到它指定的主机。

## 安全：deploy 会以你的身份运行项目代码

`wdl deploy` 在上传前会**以你的 OS 用户身份**运行项目本地的 Wrangler dry-run 以及任何 build 命令 / 依赖钩子。把 `ADMIN_TOKEN` 和控制面变量从子进程**环境**里 scrub 掉，只挡住了*环境*这条路 —— 它**不是沙箱**。磁盘上的 `~/.config/wdl/credentials` 仍被这些代码读到，就和 `~/.aws/credentials`、`~/.npmrc` 一样。所以恶意项目能读它；又因为 store 可能存着**多个 namespace** 的 token，一次不可信的 deploy 就能偷走与该项目无关的 namespace 的 token。

- 只对**你信任的项目**跑 `wdl deploy`。
- 对不可信 / 第三方项目，**别留全局 store**：用 shell 里的临时 `ADMIN_TOKEN` / `CONTROL_URL`，或 `--token` / `--control-url`，只覆盖那一个 namespace；最好再配专用 OS 用户或容器。
- `--no-token-store`（或 `WDL_TOKEN_STORE=off`）让 CLI 只从 flag / env / `.env` 解析凭据、完全不读 store。这是**解析层面的 opt-out，不是对文件的保护** —— 磁盘上的字节仍被项目代码读得到。真正的保护来自“根本不留 store”，而非这个开关。

## 反模式

- ❌ 把 `wdl token rm` 当吊销。它只删本地副本；在运维方吊销之前 token 仍然有效。
- ❌ 手编 `~/.config/wdl/credentials`。下次 `wdl token` 写入时会被 canonical 重写，你的改动（含注释）会丢失。手管的覆盖值请用项目 `.env`。
- ❌ 把 token 作为命令行参数传。`set` 从 stdin 读，避免进入 shell 历史——在提示符输入或用管道传入。
- ❌ 指望存储能覆盖 shell 或项目 `.env` 里已设的 token。它是最低层，只填空缺。

## 相关

- [deploy-zh.md](./deploy-zh.md) —— `ADMIN_TOKEN` / `CONTROL_URL` 的优先级，以及存储所处其下的 `.env` 结构。
- [secrets-zh.md](./secrets-zh.md) —— `wdl secret`，管理 worker 的运行时密钥（与这里管理的部署 token 是两回事）。
