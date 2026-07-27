const SCHEMA = `
create table if not exists inspections (
  id text primary key,
  image_key text not null,
  image_name text not null,
  image_type text not null,
  image_size integer not null,
  comment text not null,
  created_at text not null
)`;

const MAX_IMAGE_BYTES = 25 * 1024 * 1024;

function json(value, init = {}) {
  const headers = new Headers(init.headers);
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify(value), { ...init, headers });
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function safeFileName(name) {
  return (
    String(name || "upload")
      .replaceAll("/", "-")
      .replaceAll("\\", "-")
      .replace(/[^\w. -]/g, "")
      .trim()
      .slice(0, 80) || "upload"
  );
}

async function ensureSchema(env) {
  await env.DB.exec(SCHEMA);
}

async function incrementCounter(env, key) {
  const current = Number.parseInt((await env.COUNTERS.get(key)) || "0", 10) || 0;
  const next = current + 1;
  await env.COUNTERS.put(key, String(next));
  return next;
}

async function counters(env) {
  const [visits, submissions] = await Promise.all([env.COUNTERS.get("visits"), env.COUNTERS.get("submissions")]);
  return {
    visits: Number.parseInt(visits || "0", 10) || 0,
    submissions: Number.parseInt(submissions || "0", 10) || 0,
  };
}

function rowToInspection(row) {
  return {
    id: row.id,
    imageKey: row.image_key,
    imageName: row.image_name,
    imageType: row.image_type,
    imageSize: row.image_size,
    imageUrl: `images/${encodeURIComponent(row.image_key)}`,
    comment: row.comment,
    createdAt: row.created_at,
  };
}

async function listInspections(env) {
  await ensureSchema(env);
  const { results } = await env.DB.prepare(
    `
    select id, image_key, image_name, image_type, image_size, comment, created_at
    from inspections
    order by created_at desc
    limit 30
  `
  ).all();
  return results.map(rowToInspection);
}

async function createInspection(request, env) {
  await ensureSchema(env);
  const form = await request.formData();
  const image = form.get("image");
  const comment = String(form.get("comment") || "").trim();

  if (!(image instanceof File)) {
    return json({ error: "image is required" }, { status: 400 });
  }
  if (!image.type.startsWith("image/")) {
    return json({ error: "image must be an image/* file" }, { status: 400 });
  }
  if (image.size > MAX_IMAGE_BYTES) {
    return json({ error: "image must be 25 MiB or smaller" }, { status: 400 });
  }
  if (!comment) {
    return json({ error: "comment is required" }, { status: 400 });
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const imageName = safeFileName(image.name);
  // R2 overwrites by key; the UUID segment keeps same-name uploads separate.
  const imageKey = `inspections/${id}/${imageName}`;

  await env.IMAGES.put(imageKey, image.stream(), {
    httpMetadata: {
      contentType: image.type,
      cacheControl: "private, max-age=300",
    },
    customMetadata: {
      inspectionId: id,
      originalName: image.name || imageName,
    },
  });

  try {
    await env.DB.prepare(
      `
      insert into inspections
        (id, image_key, image_name, image_type, image_size, comment, created_at)
      values (?, ?, ?, ?, ?, ?, ?)
    `
    )
      .bind(id, imageKey, imageName, image.type, image.size, comment, createdAt)
      .run();
  } catch (err) {
    await env.IMAGES.delete(imageKey).catch(() => {});
    throw err;
  }

  await incrementCounter(env, "submissions");
  return json(
    {
      inspection: rowToInspection({
        id,
        image_key: imageKey,
        image_name: imageName,
        image_type: image.type,
        image_size: image.size,
        comment,
        created_at: createdAt,
      }),
      counters: await counters(env),
    },
    { status: 201 }
  );
}

async function imageResponse(env, encodedKey) {
  const key = decodeURIComponent(encodedKey);
  const obj = await env.IMAGES.get(key);
  if (!obj) return new Response("not found", { status: 404 });

  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("cache-control", obj.httpMetadata.cacheControl || "private, max-age=300");
  headers.set("content-length", String(obj.size));
  return new Response(obj.body, { headers });
}

async function page(env) {
  const [cssUrl, jsUrl] = await Promise.all([env.ASSETS.url("style.css"), env.ASSETS.url("app.js")]);
  await incrementCounter(env, "visits");

  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Inspection photo log</title>
  <link rel="stylesheet" href="${escapeHtml(cssUrl)}">
</head>
<body>
  <main class="shell">
    <section class="panel compose">
      <div class="intro">
        <p class="eyebrow">Inspection Demo</p>
        <h1>Inspection photo log</h1>
        <p class="lede">Upload a site photo with a note: the image goes to R2, the record goes to D1, and visit/submission counters live in KV.</p>
      </div>

      <form id="inspection-form" class="form">
        <label class="file-picker">
          <input id="image" name="image" type="file" accept="image/*" required>
          <span class="file-copy">
            <span>Inspection photo</span>
            <strong id="file-name">No file selected</strong>
          </span>
          <span class="file-button">Choose photo</span>
        </label>
        <label class="field">
          <span>Comments</span>
          <textarea name="comment" rows="4" maxlength="600" required
            placeholder="e.g. East wing door access OK; temperature and humidity readings stable."></textarea>
        </label>
        <div class="actions">
          <button type="submit">Submit inspection</button>
          <span id="status" role="status"></span>
        </div>
      </form>
    </section>

    <section class="stats" aria-label="Counters">
      <div><span id="visit-count">0</span><small>visits</small></div>
      <div><span id="submit-count">0</span><small>submissions</small></div>
    </section>

    <section class="panel">
      <div class="section-head">
        <h2>Recent inspections</h2>
        <button id="refresh" type="button">Refresh</button>
      </div>
      <div id="list" class="list"></div>
    </section>
  </main>
  <script type="module" src="${escapeHtml(jsUrl)}"></script>
</body>
</html>`,
    {
      headers: { "content-type": "text/html; charset=utf-8" },
    }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        return page(env);
      }
      if (request.method === "GET" && url.pathname === "/api/inspections") {
        return json({ inspections: await listInspections(env), counters: await counters(env) });
      }
      if (request.method === "POST" && url.pathname === "/api/inspections") {
        return createInspection(request, env);
      }
      if (request.method === "GET" && url.pathname.startsWith("/images/")) {
        return imageResponse(env, url.pathname.slice("/images/".length));
      }
      return new Response("not found", { status: 404 });
    } catch (err) {
      console.error("inspection-demo request failed", err);
      return json({ error: "internal error" }, { status: 500 });
    }
  },
};
