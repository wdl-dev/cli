export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const segments = url.pathname.split("/").filter(Boolean);
    const name = segments[0] || "visitor";

    const current = Number.parseInt((await env.VISITS.get(name)) || "0", 10);
    const next = current + 1;
    await env.VISITS.put(name, String(next));

    const { keys } = await env.VISITS.list({ limit: 20 });
    const leaderboard = (
      await Promise.all(
        keys.map(async (key) => [key.name, Number.parseInt((await env.VISITS.get(key.name)) || "0", 10)])
      )
    ).toSorted((a, b) => b[1] - a[1]);

    return Response.json({
      greeting: env.GREETING,
      you: name,
      visits: next,
      leaderboard: Object.fromEntries(leaderboard),
    });
  },
};
