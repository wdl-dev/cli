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

Use the positional handler or Durable Object `env` for the least surprising
surface. Code may import `{ env }` from `cloudflare:workers` and read `env.AI`
during an invocation, but it must not cache `env.AI` during module evaluation
and expect `run()` or `models()` there: that early value is the raw
`fetch()`-only host binding. With `disallow_importable_env`, only positional env
provides the facade.

## Configure a provider

Provider metadata and credentials are namespace resources. They remain after the
namespace has zero deployed Workers, matching namespace-secret lifecycle.

For a common single-model configuration, generate a project-local provider JSON
file interactively:

```bash
wdl ai providers init openai
```

The local initializer offers defaults for the provider kind, model alias,
upstream model id, and output filename, and lets an interactive user change each
one. It refuses to overwrite an existing file. The same command works
non-interactively with those defaults.

Provider names matching `openai`, `xai`, or `deepseek` select that kind; other
names default to `openai`. Use `--kind`, `--alias`, and `--file` to override the
inferred kind, `primary` alias, and default filename. The initializer pre-fills
`gpt-5.6-luna` for OpenAI, `grok-4.6` for xAI, and `deepseek-v4-flash` for
DeepSeek; use `--model` to override these starting values. It emits a
conservative text-only Responses descriptor over HTTP/SSE with all optional
capabilities disabled. Edit the JSON when the selected model needs another
protocol, transport, modality, or capability. The initializer is offline and
does not read WDL credentials or contact Control; Control remains the canonical
validator.

The generated file has the same writable shape as a manually authored file:

```json
{
  "kind": "openai",
  "models": {
    "primary": {
      "upstreamModel": "gpt-5.6-luna",
      "protocol": "responses",
      "transports": ["http", "sse"],
      "inputModalities": ["text"],
      "outputModalities": ["text"],
      "capabilities": {
        "functionTools": false,
        "structuredOutput": false,
        "reasoning": false,
        "previousResponseId": false,
        "providerTools": false,
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

`providers put` creates a new provider revision. An update that keeps the same
official adapter kind preserves an existing credential; changing kind clears it,
and a newly created provider has none. Run `credential put` whenever the
returned provider state reports a missing credential. Credential input is read
from hidden TTY input or stdin; there is no command-line credential flag and
credential values are never returned by list/get commands. Official provider
credentials must be visible-ASCII bearer tokens without whitespace.

`providers put` replaces the complete provider metadata record; an alias omitted
from `models` is removed. Its `--file` must stay inside the current project
directory and must contain only the writable `{ kind, models }` shape. Do not
pass `providers get --json` back unchanged because `name`, `revision`, and
`credentialConfigured` are response-only fields. To edit an existing provider:

```bash
wdl ai providers get openai --json --ns <namespace> \
  | jq '.provider | {kind, models}' > provider.openai.json
$EDITOR provider.openai.json
wdl ai providers put openai --file provider.openai.json --ns <namespace>
```

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
wdl ai providers init <provider> [options]
wdl ai providers list [--json]
wdl ai providers get <provider> [--json]
wdl ai providers put <provider> --file <path> [--json]
wdl ai credential put <provider> [--json]
wdl ai providers delete <provider> [--yes] [--json]
wdl ai models [--json]
```

Invalid `wdl ai` argument details are redacted because a credential may have
been pasted into the command line. If a string option before the complete
subcommand path has a separate value that is also an AI command word, put the
subcommand path first or use the inline form, such as `--ns=models` or
`--file=put`.

The model list contains configured provider metadata regardless of credential
status. Inference still fails closed until the selected provider has a
credential.

`wdl ai models` reads the current Control state. Inside a loaded Worker,
`env.AI.models()` and `run()` share one lazily loaded catalog snapshot for that
module lifecycle. Alias, protocol, transport, modality, and capability edits
therefore become visible after a reload or redeploy. Credential changes and
upstream-model rotation are resolved for every inference call and take effect
without redeploy; adding a missing credential likewise enables the next call.

`providers delete` prompts by default and deletes both the provider metadata and
its credential. It has no dry-run. First run `wdl config explain` to confirm the
resolved namespace, then inspect the target with
`wdl ai providers get <provider> --ns <namespace>` and use the same explicit
`--ns` for deletion. Pass `--yes` only after that independent check and user
confirmation.

The CLI intentionally leaves the complete descriptor grammar and aggregate
limits to Control, which is the canonical validator.

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

If an application bridges the AI socket to a separate public `WebSocketPair`,
copy the AI upgrade headers onto that public `101` response. They tell Gateway
to terminate the session instead of silently replacing a lost runtime and
creating a fresh provider session:

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

Gateway consumes the internal policy header before sending the public response.

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

`../examples/ai-agent-demo` demonstrates a Responses function-tool loop behind a
bearer token. Put the provider file, configure its credential and the demo's
Worker-level access token, deploy the Worker, then POST a prompt:

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

The demo fails closed when `AI_DEMO_TOKEN` is absent. It is an application
access token, separate from the namespace provider credential; replace it with
the application's real authentication before exposing a derived Worker.
