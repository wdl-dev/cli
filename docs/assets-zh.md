# Assets —— CDN 静态文件

## 是什么

配置目录（通常是 `./public`）下的文件在部署时被上传到 S3，由 CDN 对外提供访问。Worker 通过 `await env.ASSETS.url(path)` 拿到 CDN URL。

配置字段沿用 Cloudflare Workers Assets 的 `assets.directory` 形态，但运行时目前只实现 URL 生成，不实现 Workers Assets 的请求拦截或 `fetch()` 读取。

## 何时使用

- 随 worker 一起发布的静态 HTML / CSS / JS / 图片 / 字体。
- SPA 的构建产物目录（例如 Vite 的 `dist/`）。
- 任何 worker 想给出 CDN URL 的文件。

**运行时上传**的动态 blob 用 R2 —— 见 [r2-zh.md](./r2-zh.md)。Assets 每次部署不可变；R2 是读写存储。

## Wrangler 配置

```jsonc
{
  "assets": {
    "directory": "./public"
  }
}
```

或在 `wrangler.toml`：

```toml
[assets]
directory = "./public"
```

目录路径相对于 wrangler 配置文件。目录下的文件原样上传；子目录在 CDN URL 中保留结构。

Deploy manifest JSON 最大 32 MiB。Assets 会在部署时以 base64（约 4/3 膨胀）嵌进这个 JSON 请求，所以大文件集合可能先撞到 control request cap。CLI 另外在上传前预检：单文件最大 25 MiB、总量最大 100 MiB。大体积、运行时上传或频繁变化的文件用 R2 —— 见 [r2-zh.md](./r2-zh.md)。

CLI 默认不会上传 assets 目录里的 `.git/`、`node_modules/`、`.DS_Store`、`.wrangler/`、`.deploy-dist/`、`.wrangler.wdl-tmp*.json`、`.env*`、`.dev.vars*` 和 `.wdl-empty.env`；deploy 会输出一行 note 列出被跳过的条目。要排除更多文件，在 assets 目录放一个 gitignore 语法的 `.assetsignore`（支持 `!pattern` 反向规则，可刻意取回某个默认排除项）——与 Cloudflare Workers Assets 同一机制。CLI 会在打包后自行收集 assets，Wrangler dry-run 不会按 assets 扫描该目录。`.assetsignore` 本身默认也不会上传。

## Worker 端使用

```js
export default {
  async fetch(request, env, ctx) {
    // 拿到某个文件的 CDN URL
    const cssUrl = await env.ASSETS.url("/styles.css");
    // → "https://cdn.<...>/styles.css"（或类似 —— 主机由平台决定）

    return Response.json({ cssUrl });
  },
};
```

`await env.ASSETS.url(path)` 是常见用法 —— 把 URL 嵌进 HTML 或 JSON 响应，让浏览器直接走 CDN。

## HTML 页面的 URL 占位符

如果服务的 HTML 页面引用 CSS / JS bundle，在 Worker 返回 HTML 时用 `await env.ASSETS.url(...)` 拼出资源 URL。可工作的模式见 `../examples/pages-assets` 和 `../examples/inspection-demo`。

## 不要写 `assets.run_worker_first`

平台静默忽略 `run_worker_first`。不要加；worker 永远先看到请求。

## 构建产物

如果 assets 是构建出来的（例如 SPA），构建输出落到配置的目录下。**不要把构建产物提交到 git** —— 加进 `.gitignore`，在 `wdl deploy` 之前跑构建。例如：

```
# .gitignore
public/
```

……再按项目自己的构建命令生成该目录，例如 Vite/React 项目的 `npm run build`。WDL CLI 不会自动猜测或运行前端构建命令。

## 反模式

- ❌ 把运行时变化的文件或大体积文件集合放 assets。Assets 每次部署不可变，且受 deploy manifest 32 MiB 上限约束。用 R2 —— 见 [r2-zh.md](./r2-zh.md)。
- ❌ 加 `assets.run_worker_first`。会被静默忽略。
- ❌ 把 `assets.binding` 改成 `ASSETS` 以外的名字，或设置仅 Cloudflare 支持的 `html_handling` / `not_found_handling`。CLI 会拒绝，避免 Worker 带着不同的资源行为部署。
- ❌ 在源码里硬编码 CDN 主机。永远走 `await env.ASSETS.url(...)`。
- ❌ 把构建产物提交到 git。在部署时生成。

## 端到端示例

`../examples/pages-assets` —— 最小的 HTML 页面 + 静态资源。`../examples/inspection-demo` —— assets 与 D1 + KV + R2 组合。`../examples/env-overrides-demo` —— 演示 `[env.<name>.assets]` 如何覆盖顶层资源目录。

## 相关

- [r2-zh.md](./r2-zh.md) —— 运行时上传的 blob。
- [env-overrides-zh.md](./env-overrides-zh.md) —— 各环境用不同资源目录。
