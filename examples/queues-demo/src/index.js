const JOB_PREFIX = "job:";

function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

async function readPayload(request) {
  const raw = await request.text();
  if (!raw) return { source: "queues-demo", createdAt: new Date().toISOString() };
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function listJobs(env) {
  const { keys } = await env.QUEUE_STATE.list({ prefix: JOB_PREFIX, limit: 20 });
  const jobs = await Promise.all(keys.map(async (key) => env.QUEUE_STATE.get(key.name, { type: "json" })));
  return jobs.filter(Boolean).toSorted((a, b) => (b.receivedAt || "").localeCompare(a.receivedAt || ""));
}

async function enqueue(request, env) {
  const url = new URL(request.url);
  const requestedDelay = Number.parseInt(url.searchParams.get("delay") || "0", 10);
  const delaySeconds = Number.isFinite(requestedDelay) && requestedDelay > 0 ? requestedDelay : 0;
  const payload = await readPayload(request);
  const id = crypto.randomUUID();

  await env.JOBS.send(
    { id, payload, queuedAt: new Date().toISOString() },
    delaySeconds > 0 ? { delaySeconds } : undefined
  );

  return json({ id, status: "queued", delaySeconds });
}

async function clearJobs(env) {
  const { keys } = await env.QUEUE_STATE.list({ prefix: JOB_PREFIX, limit: 1000 });
  await Promise.all(keys.map((key) => env.QUEUE_STATE.delete(key.name)));
  return json({ deleted: keys.length });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/enqueue") {
      return enqueue(request, env);
    }

    if (request.method === "GET" && url.pathname === "/jobs") {
      return json({ jobs: await listJobs(env) });
    }

    if (request.method === "DELETE" && url.pathname === "/jobs") {
      return clearJobs(env);
    }

    return json({
      worker: "queues-demo",
      routes: {
        "POST /enqueue?delay=0": "enqueue a JSON or text payload",
        "GET /jobs": "list consumed messages stored in KV",
        "DELETE /jobs": "clear stored message records",
      },
      jobs: await listJobs(env),
    });
  },

  async queue(batch, env) {
    for (const message of batch.messages) {
      const body = message.body || {};
      const id = body.id || message.id;
      await env.QUEUE_STATE.put(
        `${JOB_PREFIX}${id}`,
        JSON.stringify({
          id,
          queue: batch.queue,
          attempts: message.attempts,
          payload: body.payload ?? body,
          queuedAt: body.queuedAt || null,
          receivedAt: new Date().toISOString(),
        })
      );
      message.ack();
    }
  },
};
