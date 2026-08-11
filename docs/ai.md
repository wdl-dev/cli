# AI Binding — Agent Inference

## What it is

WDL exposes a namespace-scoped AI binding backed by credentials that stay in the
platform control plane. Tenant code receives `env.AI.fetch()`, `env.AI.run()`,
and `env.AI.models()` without receiving provider API keys.

The first release targets the official OpenAI, xAI, and DeepSeek APIs. Model
aliases select provider metadata configured for the current namespace; tenant
requests cannot supply arbitrary provider endpoints or authentication headers.

WDL preserves OpenAI Responses, Chat Completions, Embeddings, SSE, Responses
WebSocket, and Realtime WebSocket protocol shapes where the selected provider
and model descriptor advertise them. It does not execute function tools for the
tenant or normalize provider-specific response fields.

## Wrangler configuration

Declare one AI binding:

```toml
[ai]
binding = "AI"
```

The table accepts only `binding`. Provider selection is made by the model id on
each call, not in Wrangler config. The binding is environment-scoped like other
resource bindings.

## Configure a provider

Provider metadata and credentials are namespace resources. They remain after the
namespace has zero deployed Workers, matching namespace-secret lifecycle.

Create a project-local provider JSON file:

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

Then write metadata and its credential separately:

```bash
wdl ai providers put openai --file provider.openai.json --ns <namespace>
printf '%s' "$OPENAI_API_KEY" | wdl ai credential put openai --ns <namespace>
wdl ai providers get openai --ns <namespace>
wdl ai models --ns <namespace>
```

`providers put` creates a new provider revision and clears any prior credential.
This prevents a changed destination/model definition from silently inheriting a
credential approved for an older revision. Run `credential put` again after
every metadata update. Credential input is read from hidden TTY input or stdin;
there is no command-line credential flag and credential values are never
returned by list/get commands. Official provider credentials must be
visible-ASCII bearer tokens without whitespace.

Supported provider kinds and canonical upstream ownership:

| `kind`     | HTTP protocols                                     | WebSocket protocols                |
| ---------- | -------------------------------------------------- | ---------------------------------- |
| `openai`   | Responses, Chat Completions, Embeddings            | Responses WebSocket, Realtime      |
| `xai`      | Responses, Chat Completions, Embeddings            | Responses WebSocket, Realtime      |
| `deepseek` | Responses and Chat Completions compatibility paths | Not available in the first release |

The provider `name` and each model alias form the tenant model id
`<provider>/<alias>`, for example `openai/primary`. `upstreamModel` is the
provider's native model id and may use provider-specific punctuation.

Provider management commands:

```bash
wdl ai providers list [--json]
wdl ai providers get <provider> [--json]
wdl ai providers put <provider> --file <path> [--json]
wdl ai credential put <provider> [--json]
wdl ai providers delete <provider> [--yes] [--json]
wdl ai models [--json]
```

Deleting a provider also deletes its credential. The CLI intentionally leaves
the complete descriptor grammar and aggregate limits to Control, which is the
canonical validator.

## Agent calls with `run()`

`run(model, inputs, options?)` injects the configured upstream model and sends
the native protocol body. For Responses:

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

The tenant validates tool arguments, executes the tool, and sends
`function_call_output` in a later Responses call. WDL never executes tools or
automatically follows a response continuation.

Streaming returns the response body as a `ReadableStream`:

```js
const stream = await env.AI.run("openai/primary", {
  input: "Write a concise migration plan.",
  stream: true,
});

for await (const chunk of stream) {
  // Parse the provider's semantic SSE events.
}
```

Cancellation uses `options.signal`:

```js
const controller = new AbortController();
const pending = env.AI.run("openai/primary", { input: "..." }, {
  signal: controller.signal,
});
controller.abort();
await pending;
```

The only `run()` options are `signal` and `websocket`. Unsupported Cloudflare
options fail loudly. Use `fetch()` when the application needs the raw
`Response`; `returnRawResponse` is intentionally not implemented.

## Raw fetch and the OpenAI SDK

`env.AI.fetch()` accepts only the virtual origin `https://ai.wdl` and the
supported `/v1/...` paths. The request body carries a WDL model alias; the host
binding resolves the official destination and attaches the provider credential.

```js
const response = await env.AI.fetch("https://ai.wdl/v1/responses", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ model: "openai/primary", input: "Hello" }),
});
```

The official OpenAI JavaScript SDK works for JSON, SSE, and cancellation when
configured with `baseURL: "https://ai.wdl/v1"`, a placeholder `apiKey`, and
`fetch: env.AI.fetch.bind(env.AI)`. The placeholder satisfies SDK validation;
WDL strips caller authorization and attaches the configured credential inside
the host binding. SDK WebSocket helpers are not claimed; use the binding's
WebSocket surface directly.

## WebSocket inference

For a model that advertises `responses_websocket` or `realtime_websocket`:

```js
const response = await env.AI.run("openai/realtime", null, {
  websocket: true,
  signal: request.signal,
});
const socket = response.webSocket;
socket.accept();
socket.send(JSON.stringify({ type: "session.update", session: {} }));
```

The application owns provider protocol frames, reconnection, and close handling.
WDL bridges text/binary frames and provider close codes but does not resume an
interrupted model session. Long-lived AI sockets in a Durable Object consume the
do-runtime AI pool and can keep that actor active.

## Security and operational boundaries

- Provider credentials are encrypted at rest and never enter bundle metadata,
  generated source, raw tenant env, logs, or request arguments.
- Provider kind fixes the canonical official endpoint. Tenant model aliases,
  request bodies, and headers cannot select another host.
- Provider traffic uses the runtime's dedicated public-only network binding.
- Request, streaming, and WebSocket concurrency use separate per-replica pools.
  Saturation fails immediately; it is process isolation, not tenant quota or
  billing policy.
- Calls have independent request/deadline, idle, frame, byte, and duration
  bounds. Caller disconnect is not the only cleanup signal.
- Provider warnings and protocol payloads remain provider-native. Stable WDL
  errors use `AIError` from `run()` or an HTTP JSON error from `fetch()`.

WDL does not yet provide managed model credentials, durable usage accounting,
spend quotas, AI Gateway, asynchronous batch, `toMarkdown()`, background
Responses/webhooks, provider file APIs, WebRTC, or SIP.

## End-to-end example

`../examples/ai-agent-demo` demonstrates a Responses function-tool loop. Put the
provider file, configure its credential, deploy the Worker, then POST a prompt:

```bash
cd examples/ai-agent-demo
wdl ai providers put openai --file provider.openai.json --ns <namespace>
printf '%s' "$OPENAI_API_KEY" | wdl ai credential put openai --ns <namespace>
wdl deploy . --ns <namespace>
curl -X POST -H 'content-type: application/json' \
  -d '{"prompt":"What time is it in Asia/Tokyo?"}' \
  https://<namespace>-ai-agent-demo.<platform-domain>/
```
