# AI Binding — Agent 推理

## 这是什么

WDL 提供命名空间级 AI binding，provider 凭据只保存在平台控制面中。租户代码可以使用 `env.AI.fetch()`、`env.AI.run()` 和 `env.AI.models()`，但不会拿到 provider API key。

首个版本面向 OpenAI、xAI 和 DeepSeek 官方 API。模型别名选择当前命名空间中配置的 provider 元数据；租户请求不能传入任意 provider endpoint 或认证 header。

在所选 provider 和模型描述声明支持时，WDL 保留 OpenAI Responses、Chat Completions、Embeddings、SSE、Responses WebSocket 和 Realtime WebSocket 协议形状。WDL 不替租户执行 function tool，也不会把 provider 特有响应字段压平成统一的最低公共形态。

## Wrangler 配置

声明一个 AI binding：

```toml
[ai]
binding = "AI"
```

该表只接受 `binding`。provider 由每次调用的模型 id 选择，而不是写在 Wrangler 配置中。与其它资源 binding 一样，AI binding 按 environment 隔离。

最不易误用的方式是使用 handler 或 Durable Object 的位置参数 `env`。代码可以从 `cloudflare:workers` 导入 `{ env }`，并在 invocation 内读取 `env.AI`；但不能在模块求值期间缓存 `env.AI` 后期待它具有 `run()` 或 `models()`，那个过早取得的值只有原始 `fetch()` host binding。启用 `disallow_importable_env` 时，只有位置参数 env 提供完整 facade。

## 配置 provider

Provider 元数据和凭据是命名空间资源。即使命名空间暂时没有任何已部署 Worker，它们仍会保留，与 namespace secret 的生命周期一致。

在项目内创建 provider JSON 文件：

```json
{
  "kind": "openai",
  "models": {
    "primary": {
      "upstreamModel": "gpt-5",
      "protocol": "responses",
      "transports": ["http", "sse", "responses_websocket"],
      "inputModalities": ["image", "text"],
      "outputModalities": ["text"],
      "capabilities": {
        "functionTools": true,
        "structuredOutput": true,
        "reasoning": true,
        "previousResponseId": true,
        "providerTools": true,
        "binaryFrames": false
      }
    }
  }
}
```

然后分别写入元数据和凭据：

```bash
wdl ai providers put openai --file provider.openai.json --ns <namespace>
printf '%s' "$OPENAI_API_KEY" | wdl ai credential put openai --ns <namespace>
wdl ai providers get openai --ns <namespace>
wdl ai models --ns <namespace>
```

`providers put` 会生成新的 provider revision。同一官方 adapter kind 内更新时保留既有 credential；切换 kind 时清除 credential，新建 provider 则默认没有 credential。返回的 provider 状态显示 credential 缺失时，才需要执行 `credential put`。凭据从隐藏 TTY 输入或 stdin 读取；CLI 不提供命令行 credential flag，list/get 也绝不返回凭据值。官方 provider credential 必须是不含空白的 visible-ASCII bearer token。

`providers put` 会整条替换 provider metadata；`models` 中省略的 alias 会被删除。`--file` 必须留在当前项目目录内，并且只能包含可写的 `{ kind, models }` 形状。不要把 `providers get --json` 的结果原样回灌，因为 `name`、`revision` 和 `credentialConfigured` 是只读响应字段。编辑既有 provider 时使用：

```bash
wdl ai providers get openai --json --ns <namespace> \
  | jq '.provider | {kind, models}' > provider.openai.json
$EDITOR provider.openai.json
wdl ai providers put openai --file provider.openai.json --ns <namespace>
```

支持的 provider kind 与规范上游范围：

| `kind` | HTTP 协议 | WebSocket 协议 |
| --- | --- | --- |
| `openai` | Responses、Chat Completions、Embeddings | Responses WebSocket、Realtime |
| `xai` | Responses、Chat Completions、Embeddings | Responses WebSocket、Realtime |
| `deepseek` | Responses 和 Chat Completions 兼容路径 | 首个版本不支持 |

Provider `name` 与模型 alias 组成租户模型 id `<provider>/<alias>`，例如 `openai/primary`。`upstreamModel` 是 provider 原生模型 id，可以包含 provider 特有标点。

Provider 管理命令：

```bash
wdl ai providers list [--json]
wdl ai providers get <provider> [--json]
wdl ai providers put <provider> --file <path> [--json]
wdl ai credential put <provider> [--json]
wdl ai providers delete <provider> [--yes] [--json]
wdl ai models [--json]
```

`wdl ai` 会脱敏无效参数的细节，因为用户可能已经把 credential 误贴进命令行。如果完整子命令路径前的 string option 使用分离式值，而该值本身也是 AI 命令词，请把完整子命令路径放到前面，或改用 `--ns=models`、`--file=put` 这类 inline 形式。

Model list 包含全部已配置的 provider metadata，不按 credential 状态过滤；所选 provider 缺少 credential 时，推理仍会 fail closed。

`wdl ai models` 读取 Control 的当前权威状态。一个已加载 Worker 内，`env.AI.models()` 与 `run()` 在该 module 生命周期中共享一份延迟加载的 catalog snapshot；alias、protocol、transport、modality 和 capability 变更要等 module 重载或重新部署后才可见。Credential 变化和 upstream model 轮换会在每次推理时重新解析，无需 redeploy；补上缺失 credential 后，下一次调用也会立即生效。

`providers delete` 默认会提示确认，并同时删除 provider metadata 和 credential。该命令没有 dry-run。先运行 `wdl config explain` 确认最终解析出的 namespace，再用 `wdl ai providers get <provider> --ns <namespace>` 查看目标，并在删除时传入同一个显式 `--ns`。只有完成这项独立检查并与用户确认后，才能传 `--yes`。

CLI 有意不复制完整 descriptor grammar 和总量限制；Control 是唯一权威校验者。

## 使用 `run()` 构建 Agent

`run(model, inputs, options?)` 注入已配置的上游模型并发送原生协议 body。Responses 示例：

```js
const response = await env.AI.run("openai/primary", {
  input: "Check the weather and call a tool if needed.",
  tools: [
    {
      type: "function",
      name: "get_weather",
      description: "Get weather for a city",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
        additionalProperties: false,
      },
      strict: true,
    },
  ],
  reasoning: { effort: "medium" },
});
```

租户负责校验 tool 参数、执行工具，并在后续 Responses 调用中提交 `function_call_output`。WDL 不自动执行工具，也不会自动跟随 response continuation。

流式调用返回 `ReadableStream`：

```js
const stream = await env.AI.run("openai/primary", {
  input: "Write a concise migration plan.",
  stream: true,
});

for await (const chunk of stream) {
  // 解析 provider 的语义 SSE event。
}
```

取消使用 `options.signal`：

```js
const controller = new AbortController();
const pending = env.AI.run("openai/primary", { input: "..." }, {
  signal: controller.signal,
});
controller.abort();
await pending;
```

`run()` option 只支持 `signal` 和 `websocket`。不支持的 Cloudflare option 会明确报错。需要原始 `Response` 时使用 `fetch()`；本实现有意不支持 `returnRawResponse`。

## Raw fetch 与 OpenAI SDK

`env.AI.fetch()` 只接受虚拟 origin `https://ai.wdl` 及受支持的 `/v1/...` 路径。请求 body 携带 WDL 模型别名；host binding 解析官方目标并附加 provider 凭据。

```js
const response = await env.AI.fetch("https://ai.wdl/v1/responses", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "openai/primary", input: "Hello" }),
});
```

官方 OpenAI JavaScript SDK 可用于 JSON、SSE 和取消：配置 `baseURL: "https://ai.wdl/v1"`、占位 `apiKey`，并设置 `fetch: env.AI.fetch.bind(env.AI)`。占位 key 只满足 SDK 自身校验；WDL 会移除调用方 authorization，并在 host binding 内附加已配置凭据。当前不承诺 SDK 的 WebSocket helper；WebSocket 应直接使用 binding 表面。

## WebSocket 推理

模型声明支持 `responses_websocket` 或 `realtime_websocket` 时：

```js
const response = await env.AI.run("openai/realtime", null, {
  websocket: true,
  signal: request.signal,
});
const socket = response.webSocket;
socket.accept();
socket.send(JSON.stringify({ type: "session.update", session: {} }));
```

应用负责 provider 协议帧、重连和 close 处理。WDL 桥接文本/二进制帧及 provider close code，但不会恢复已中断的模型会话。在 Durable Object 中保持长连接会消耗 do-runtime 自己的 AI pool，并可能让 actor 保持活跃。

如果应用把 AI socket 桥接到另一个公开 `WebSocketPair`，必须把 AI upgrade headers 复制到自己的公开 `101` response。它们会让 Gateway 在 runtime 丢失时终止 session，而不是静默替换 runtime 并创建新的 provider session：

```js
const aiUpgrade = await env.AI.run("openai/realtime", null, {
  websocket: true,
});
// Bridge aiUpgrade.webSocket to client.
return new Response(null, {
  status: 101,
  webSocket: client,
  headers: aiUpgrade.headers,
});
```

Gateway 会在发送公开 response 前消费掉内部 policy header。

## 安全与运维边界

- Provider 凭据加密落盘，绝不进入 bundle metadata、生成源码、租户原始 env、日志或请求参数。
- Provider kind 固定规范官方 endpoint；租户模型别名、请求 body 和 header 不能选择其它 host。
- Provider 流量使用 runtime 专用的 public-only network binding。
- 普通请求、流和 WebSocket 使用三个独立的 per-replica pool；饱和时立即失败。这是进程隔离，不是租户 quota 或计费策略。
- 调用具有独立的 request/deadline、idle、frame、字节和总时长边界；清理不只依赖调用方断开信号。
- Provider warning 和协议 payload 保持原生。`run()` 的稳定 WDL 错误使用 `AIError`；`fetch()` 返回 HTTP JSON error。

WDL 当前不提供托管模型凭据、持久用量统计、消费 quota、AI Gateway、异步 batch、`toMarkdown()`、background Responses/webhook、provider file API、WebRTC 或 SIP。

## 端到端示例

`../examples/ai-agent-demo` 展示由 bearer token 保护的 Responses function-tool 循环。写入 provider 文件，配置 provider credential 和 demo 的 Worker 级访问 token 并部署 Worker 后，再 POST prompt：

```bash
cd examples/ai-agent-demo
wdl ai providers put openai --file provider.openai.json --ns <namespace>
printf '%s' "$OPENAI_API_KEY" | wdl ai credential put openai --ns <namespace>
AI_DEMO_TOKEN="$(openssl rand -hex 32)"
printf '%s' "$AI_DEMO_TOKEN" | wdl secret put --worker ai-agent-demo AI_DEMO_TOKEN --ns <namespace>
wdl deploy . --ns <namespace>
printf 'authorization: Bearer %s\n' "$AI_DEMO_TOKEN" |
  curl -X POST -H @- \
    -H 'content-type: application/json' \
    -d '{"prompt":"What time is it in Asia/Tokyo?"}' \
    https://<namespace>.<platform-domain>/ai-agent-demo/
```

未配置 `AI_DEMO_TOKEN` 时，demo 会 fail closed。它是应用访问 token，与 namespace provider credential 相互独立；对外开放基于该示例修改的 Worker 前，应换成应用自身的正式鉴权。
