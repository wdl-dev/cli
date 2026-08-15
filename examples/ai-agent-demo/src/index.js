const TIME_TOOL = {
  type: "function",
  name: "get_time",
  description: "Get the current time in an IANA timezone",
  parameters: {
    type: "object",
    properties: {
      timezone: { type: "string" },
    },
    required: ["timezone"],
    additionalProperties: false,
  },
  strict: true,
};

const MAX_TOOL_ROUNDS = 8;

function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function responseText(response) {
  return (response.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text")
    .map((item) => item.text)
    .join("");
}

function executeTool(call) {
  if (call.name !== "get_time") throw new Error(`unsupported tool: ${call.name}`);
  const args = JSON.parse(call.arguments);
  const value = new Intl.DateTimeFormat("en-GB", {
    dateStyle: "full",
    timeStyle: "long",
    timeZone: args.timezone,
  }).format(new Date());
  return { type: "function_call_output", call_id: call.call_id, output: JSON.stringify({ value }) };
}

async function runAgent(ai, prompt) {
  let response = await ai.run("openai/primary", {
    input: prompt,
    tools: [TIME_TOOL],
    tool_choice: "auto",
    reasoning: { effort: "low" },
  });
  for (let round = 0; ; round += 1) {
    const calls = (response.output || []).filter((item) => item.type === "function_call");
    if (calls.length === 0) return response;
    if (round >= MAX_TOOL_ROUNDS) throw new Error(`tool loop exceeded ${MAX_TOOL_ROUNDS} rounds`);
    response = await ai.run("openai/primary", {
      previous_response_id: response.id,
      input: calls.map(executeTool),
      tools: [TIME_TOOL],
    });
  }
}

export default {
  async fetch(request, env) {
    if (request.method === "GET") {
      return json({
        worker: "ai-agent-demo",
        usage: "POST JSON { prompt }",
        models: await env.AI.models(),
      });
    }
    if (request.method !== "POST") return json({ error: "method_not_allowed" }, { status: 405 });
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: "invalid_request", message: "request body must be valid JSON" }, { status: 400 });
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "invalid_request", message: "request body must be a JSON object" }, { status: 400 });
    }
    const prompt = body.prompt;
    if (typeof prompt !== "string") {
      return json({ error: "invalid_request", message: "prompt must be a string" }, { status: 400 });
    }
    try {
      const response = await runAgent(env.AI, prompt);
      return json({ id: response.id, text: responseText(response), response });
    } catch (error) {
      return json(
        {
          error: error instanceof Error ? error.name : "Error",
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 502 }
      );
    }
  },
};
