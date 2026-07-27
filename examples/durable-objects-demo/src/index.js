import { DurableObject } from "cloudflare:workers";

function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.memoryHits = 0;
  }

  ensureSchema() {
    this.ctx.storage.sql.exec("CREATE TABLE IF NOT EXISTS counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL)");
  }

  readCounter(name) {
    this.ensureSchema();
    const rows = this.ctx.storage.sql.exec("SELECT value FROM counters WHERE name = ?", name);
    return [...rows][0]?.value ?? 0;
  }

  incrementCounter(name) {
    const value = this.readCounter(name) + 1;
    this.ctx.storage.sql.exec(
      "INSERT INTO counters (name, value) VALUES (?, ?) ON CONFLICT(name) DO UPDATE SET value = excluded.value",
      name,
      value
    );
    return value;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const room = url.searchParams.get("room") || "main";

    if (url.pathname === "/hit") {
      this.memoryHits += 1;
      return json({
        room,
        memoryHits: this.memoryHits,
        storedHits: this.incrementCounter("hits"),
      });
    }

    if (url.pathname === "/" || url.pathname === "/status") {
      return json({
        room,
        memoryHits: this.memoryHits,
        storedHits: this.readCounter("hits"),
      });
    }

    return json({ error: "not_found", path: url.pathname }, { status: 404 });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const room = url.searchParams.get("room") || "main";
    const id = env.ROOMS.idFromName(room);
    return env.ROOMS.get(id).fetch(request);
  },
};
