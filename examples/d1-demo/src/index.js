export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const name = segments[0] || "visitor";

    await env.DB.prepare(
      `INSERT INTO visits (name, count, updated_at)
       VALUES (?1, 1, CURRENT_TIMESTAMP)
       ON CONFLICT(name) DO UPDATE SET
         count = count + 1,
         updated_at = CURRENT_TIMESTAMP`
    )
      .bind(name)
      .run();

    const current = await env.DB.prepare("SELECT count FROM visits WHERE name = ?1").bind(name).first();

    const { results } = await env.DB.prepare(
      "SELECT name, count FROM visits ORDER BY count DESC, name ASC LIMIT 20"
    ).all();

    return Response.json({
      greeting: env.GREETING,
      you: name,
      visits: current?.count || 0,
      leaderboard: Object.fromEntries(results.map((row) => [row.name, row.count])),
    });
  },
};
