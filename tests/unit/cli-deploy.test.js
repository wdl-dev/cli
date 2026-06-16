import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  DEPLOY_JSON_BODY_MAX_BYTES,
  runDeployCommand,
  serializeDeployManifest,
} from "../../commands/deploy.js";
import {
  collectAssets,
  collectModules,
  loadWranglerConfig,
  MAX_ASSET_FILE_BYTES,
  parseD1DatabasesFromCfg,
  parseDurableObjectsFromCfg,
  parseExportsFromCfg,
  parseJsonc,
  parsePlatformBindingsFromCfg,
  parseQueues,
  parseR2BucketsFromCfg,
  parseServicesFromCfg,
  parseTriggers,
  parseWorkflowsFromCfg,
  parseWranglerMajorVersion,
  resolveAssetsDir,
  resolveWranglerCommand,
  resolveWranglerConfig,
  stripJsonComments,
  stripTrailingCommas,
  validateUnsupportedWranglerConfig,
  wranglerChildEnv,
} from "../../lib/wrangler-pack.js";
import { LONG_CONTROL_TIMEOUT_MS } from "../../lib/control-fetch.js";
import { response } from "./helpers.js";

// Shared happy-path execFile stub: answers the version probe and writes the
// bundled entry the deploy pipeline expects in --outdir.
function fakeWranglerExecFile(_cmd, args) {
  if (args.includes("--version")) return "wrangler 4.94.0";
  const outDir = args.find((arg) => arg.startsWith("--outdir=")).slice("--outdir=".length);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "index.js"), "export default {}");
}

function assertWranglerCommand(cmd) {
  assert.ok(
    cmd === "wrangler" || path.basename(cmd) === (process.platform === "win32" ? "wrangler.cmd" : "wrangler"),
    `expected wrangler command, got ${cmd}`
  );
}

test("stripJsonComments removes line and block comments", () => {
  const raw = `{
    // line
    "name": "demo", /* block */
    "value": "keep // inside string"
  }`;
  const out = stripJsonComments(raw);
  assert.ok(!out.includes("// line"));
  assert.ok(!out.includes("/* block */"));
  assert.ok(out.includes('"value": "keep // inside string"'));
});

test("stripTrailingCommas removes trailing commas outside strings", () => {
  const raw = `{
    "arr": [1, 2,],
    "obj": { "x": 1, },
    "literal": ",}"
  }`;
  const out = stripTrailingCommas(raw);
  assert.ok(out.includes('"literal": ",}"'));
  assert.ok(out.includes('"arr": [1, 2]'));
  assert.ok(out.includes('"obj": { "x": 1 }'));
});

test("stripTrailingCommas keeps escaped quotes and backslashes inside strings", () => {
  const raw = `{
    "quoted": "say \\"hi\\"",
    "path": "C:\\\\tmp\\\\,}",
    "arr": [1,],
  }`;
  const out = stripTrailingCommas(raw);
  assert.ok(out.includes('"quoted": "say \\"hi\\""'));
  assert.ok(out.includes('"path": "C:\\\\tmp\\\\,}"'));
  assert.ok(out.includes('"arr": [1]'));
});

test("parseJsonc accepts comments and trailing commas", () => {
  const cfg = parseJsonc(`{
    // hello
    "name": "demo",
    "vars": {
      "GREETING": "hi",
    },
  }`);
  assert.deepEqual(cfg, {
    name: "demo",
    vars: { GREETING: "hi" },
  });
});

test("parseTriggers: missing/empty yields []", () => {
  assert.deepEqual(parseTriggers(undefined), []);
  assert.deepEqual(parseTriggers(null), []);
  assert.deepEqual(parseTriggers({}), []);
  assert.deepEqual(parseTriggers({ crons: [] }), []);
});

test("parseTriggers: [triggers] crons defaults timezone to UTC", () => {
  assert.deepEqual(
    parseTriggers({ crons: ["*/5 * * * *", "0 0 * * *"] }),
    [
      { cron: "*/5 * * * *", timezone: "UTC" },
      { cron: "0 0 * * *", timezone: "UTC" },
    ]
  );
});

test("parseTriggers: [[triggers.schedules]] preserves timezone", () => {
  assert.deepEqual(
    parseTriggers({
      schedules: [
        { cron: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
        { cron: "0 0 * * *" },
      ],
    }),
    [
      { cron: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
      { cron: "0 0 * * *", timezone: "UTC" },
    ]
  );
});

test("parseTriggers: merges both forms in order (crons first, then schedules)", () => {
  assert.deepEqual(
    parseTriggers({
      crons: ["*/5 * * * *"],
      schedules: [{ cron: "0 9 * * *", timezone: "Asia/Shanghai" }],
    }),
    [
      { cron: "*/5 * * * *", timezone: "UTC" },
      { cron: "0 9 * * *", timezone: "Asia/Shanghai" },
    ]
  );
});

test("parseTriggers: rejects non-string cron entry", () => {
  assert.throws(() => parseTriggers({ crons: [42] }), /non-empty strings/);
  assert.throws(() => parseTriggers({ schedules: [{}] }), /cron is required/);
});

test("parseTriggers: rejects wrong shape", () => {
  assert.throws(() => parseTriggers([]), /must be a table/);
  assert.throws(() => parseTriggers({ crons: "*/5 * * * *" }), /must be an array/);
  assert.throws(() => parseTriggers({ schedules: {} }), /must be an array of tables/);
});

test("parseQueues: missing/empty yields empty producers and consumers", () => {
  assert.deepEqual(parseQueues(undefined), { producers: [], consumers: [] });
  assert.deepEqual(parseQueues(null), { producers: [], consumers: [] });
  assert.deepEqual(parseQueues({}), { producers: [], consumers: [] });
});

test("parseQueues: producers normalize delivery_delay", () => {
  assert.deepEqual(
    parseQueues({ producers: [{ binding: "MY_Q", queue: "orders", delivery_delay: 60 }] }),
    { producers: [{ binding: "MY_Q", queue: "orders", deliveryDelaySeconds: 60 }], consumers: [] }
  );
});

test("parseQueues: consumers normalize max_batch_timeout and retry_delay", () => {
  const out = parseQueues({
    consumers: [
      {
        queue: "orders",
        max_batch_size: 10,
        max_batch_timeout: 5,
        max_retries: 3,
        retry_delay: 30,
        dead_letter_queue: "orders-dlq",
      },
    ],
  });
  assert.deepEqual(out.consumers, [
    {
      queue: "orders",
      maxBatchSize: 10,
      maxBatchTimeoutMs: 5000,
      maxRetries: 3,
      retryDelaySeconds: 30,
      deadLetterQueue: "orders-dlq",
    },
  ]);
});

test("parseQueues: omits optional consumer fields when absent", () => {
  assert.deepEqual(
    parseQueues({ consumers: [{ queue: "orders" }] }),
    { producers: [], consumers: [{ queue: "orders" }] }
  );
});

test("parseQueues: validates delay fields and rejects unsupported concurrency loudly", () => {
  assert.throws(
    () => parseQueues({ producers: [{ binding: "Q", queue: "q", delivery_delay: 86_401 }] }),
    /delivery_delay/
  );
  assert.throws(
    () => parseQueues({ producers: [{ binding: "Q", queue: "q", delivery_delay: "30" }] }),
    /delivery_delay/
  );
  assert.throws(
    () => parseQueues({ consumers: [{ queue: "q", retry_delay: -1 }] }),
    /retry_delay/
  );
  assert.throws(
    () => parseQueues({ consumers: [{ queue: "q", retry_delay: true }] }),
    /retry_delay/
  );
  assert.throws(
    () => parseQueues({ consumers: [{ queue: "q", max_batch_timeout: "5" }] }),
    /max_batch_timeout/
  );
  assert.throws(
    () => parseQueues({ consumers: [{ queue: "q", max_batch_timeout: true }] }),
    /max_batch_timeout/
  );
  assert.throws(
    () => parseQueues({ consumers: [{ queue: "q", max_concurrency: 4 }] }),
    /max_concurrency not supported/
  );
});

test("parseQueues: rejects missing required fields", () => {
  assert.throws(() => parseQueues({ producers: [{ queue: "q" }] }), /binding is required/);
  assert.throws(() => parseQueues({ producers: [{ binding: "B" }] }), /queue is required/);
  assert.throws(() => parseQueues({ consumers: [{}] }), /queue is required/);
});

test("parseQueues: rejects wrong shape", () => {
  assert.throws(() => parseQueues([]), /must be a table/);
  assert.throws(() => parseQueues({ producers: {} }), /must be an array/);
  assert.throws(() => parseQueues({ consumers: "no" }), /must be an array/);
});

test("parseQueues: rejects runtime-internal producer binding names", () => {
  assert.throws(
    () => parseQueues({ producers: [{ binding: "__WDL_RESERVED__", queue: "q" }] }),
    /runtime-internal bindings/
  );
});

test("parseD1DatabasesFromCfg: absent yields empty and database_id wins", () => {
  assert.deepEqual(parseD1DatabasesFromCfg({}), []);
  assert.deepEqual(
    parseD1DatabasesFromCfg({
      d1_databases: [
        { binding: "DB", database_name: "main", database_id: "cf-id" },
        { binding: "REPORTS", database_id: "compat-main" },
      ],
    }),
    [
      { binding: "DB", databaseId: "cf-id" },
      { binding: "REPORTS", databaseId: "compat-main" },
    ]
  );
});

test("parseD1DatabasesFromCfg: rejects wrong shape and missing fields", () => {
  assert.throws(() => parseD1DatabasesFromCfg({ d1_databases: {} }), /must be an array/);
  assert.throws(() => parseD1DatabasesFromCfg({ d1_databases: [null] }), /entry must be a table/);
  assert.throws(() => parseD1DatabasesFromCfg({ d1_databases: [{ database_name: "main" }] }), /binding is required/);
  assert.throws(() => parseD1DatabasesFromCfg({ d1_databases: [{ binding: "DB" }] }), /database_name or database_id is required/);
  assert.throws(
    () => parseD1DatabasesFromCfg({ d1_databases: [{ binding: "DB", database_name: "main", databsae_id: "oops" }] }),
    /unknown field\(s\): databsae_id/
  );
});

test("parseD1DatabasesFromCfg: accepts recognized wrangler-only fields without using them for deploy binding resolution", () => {
  assert.deepEqual(
    parseD1DatabasesFromCfg({
      d1_databases: [{
        binding: "DB",
        database_name: "main",
        preview_database_id: "preview-main",
        migrations_dir: "schema",
        migrations_table: "_migrations",
      }],
    }),
    [{ binding: "DB", databaseId: "main" }]
  );
});

test("parseR2BucketsFromCfg: parses wrangler R2 bucket bindings", () => {
  assert.deepEqual(parseR2BucketsFromCfg({}), []);
  assert.deepEqual(
    parseR2BucketsFromCfg({
      r2_buckets: [
        { binding: "BUCKET", bucket_name: "uploads" },
      ],
    }),
    [{ binding: "BUCKET", bucketName: "uploads" }]
  );
  assert.throws(() => parseR2BucketsFromCfg({ r2_buckets: {} }), /must be an array/);
  assert.throws(() => parseR2BucketsFromCfg({ r2_buckets: [null] }), /entry must be a table/);
  assert.throws(() => parseR2BucketsFromCfg({ r2_buckets: [{ bucket_name: "uploads" }] }), /binding is required/);
  assert.throws(() => parseR2BucketsFromCfg({ r2_buckets: [{ binding: "BUCKET" }] }), /bucket_name is required/);
  assert.throws(
    () => parseR2BucketsFromCfg({ r2_buckets: [{ binding: "BUCKET", bucket_name: "Bad_Name" }] }),
    /bucket_name must match/
  );
  assert.throws(
    () => parseR2BucketsFromCfg({ r2_buckets: [{ binding: "BUCKET", bucket_name: "uploads", preview_bucket_name: "preview" }] }),
    /preview_bucket_name is not supported/
  );
  assert.throws(
    () => parseR2BucketsFromCfg({ r2_buckets: [{ binding: "BUCKET", bucket_name: "uploads", jurisdiction: "eu" }] }),
    /jurisdiction is not supported/
  );
});

test("parse resource bindings reject runtime-internal WDL names", () => {
  assert.throws(
    () => parseD1DatabasesFromCfg({
      d1_databases: [{ binding: "__WDL_RESERVED__", database_name: "main" }],
    }),
    /runtime-internal bindings/
  );
  assert.throws(
    () => parseR2BucketsFromCfg({
      r2_buckets: [{ binding: "__WDL_RESERVED__", bucket_name: "uploads" }],
    }),
    /runtime-internal bindings/
  );
  assert.throws(
    () => parseServicesFromCfg({
      services: [{ binding: "__WDL_RESERVED__", service: "target" }],
    }),
    /runtime-internal bindings/
  );
});

test("parseDurableObjectsFromCfg: parses local DO bindings with new_classes or new_sqlite_classes migrations", () => {
  assert.deepEqual(parseDurableObjectsFromCfg({}), []);
  assert.deepEqual(
    parseDurableObjectsFromCfg({
      durable_objects: {
        bindings: [{ name: "ROOMS", class_name: "Room" }],
      },
      migrations: [{ tag: "v1", new_classes: ["Room"] }],
    }),
    [{ binding: "ROOMS", className: "Room" }]
  );
  assert.deepEqual(
    parseDurableObjectsFromCfg({
      durable_objects: {
        bindings: [{ name: "ROOMS", class_name: "Room" }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
    }),
    [{ binding: "ROOMS", className: "Room" }]
  );
  assert.throws(() => parseDurableObjectsFromCfg({ durable_objects: [] }), /must be a table/);
  assert.throws(
    () => parseDurableObjectsFromCfg({ durable_objects: { bindings: {} } }),
    /must be an array/
  );
  assert.throws(
    () => parseDurableObjectsFromCfg({
      durable_objects: { bindings: [{ name: "ROOMS", class_name: "Room", script_name: "other" }] },
      migrations: [{ tag: "v1", new_classes: ["Room"] }],
    }),
    /script_name is not supported/
  );
  assert.throws(
    () => parseDurableObjectsFromCfg({
      durable_objects: { bindings: [{ name: "ROOMS", class_name: "Room" }] },
      migrations: [{ tag: "v1", new_classes: ["Other"] }],
    }),
    /must be listed in \[\[migrations\]\]\.new_classes or \[\[migrations\]\]\.new_sqlite_classes/
  );
  assert.throws(
    () => parseDurableObjectsFromCfg({
      durable_objects: { bindings: [{ name: "ROOMS", class_name: "Room" }] },
      migrations: [{ tag: "v1", new_sqlite_classes: [42] }],
    }),
    /new_sqlite_classes entries must be valid JS class declaration names/
  );
  assert.throws(
    () => parseDurableObjectsFromCfg({
      durable_objects: { bindings: [{ name: "ROOMS", class_name: "class" }] },
      migrations: [{ tag: "v1", new_classes: ["class"] }],
    }),
    /new_classes entries must be valid JS class declaration names/
  );
  assert.throws(
    () => parseDurableObjectsFromCfg({
      durable_objects: { bindings: [{ name: "ROOMS", class_name: "Room" }] },
      migrations: [{ tag: "v2", renamed_classes: [{ from: "Old", to: "Room" }] }],
    }),
    /renamed_classes is not supported/
  );
});

test("parseDurableObjectsFromCfg: rejects runtime-internal binding names", () => {
  assert.throws(
    () => parseDurableObjectsFromCfg({
      durable_objects: {
        bindings: [{ name: "__WDL_RESERVED__", class_name: "Room" }],
      },
      migrations: [{ tag: "v1", new_classes: ["Room"] }],
    }),
    /runtime-internal bindings/
  );
});

test("parseServicesFromCfg: parses wrangler [[services]] entries", () => {
  assert.deepEqual(parseServicesFromCfg({}), []);
  assert.deepEqual(parseServicesFromCfg({ services: [] }), []);
  assert.deepEqual(
    parseServicesFromCfg({
      services: [
        { binding: "AUTH", service: "auth-svc" },
        { binding: "BILLING", service: "billing-svc", entrypoint: "Api", ns: "shared" },
      ],
    }),
    [
      { binding: "AUTH", service: "auth-svc" },
      { binding: "BILLING", service: "billing-svc", entrypoint: "Api", ns: "shared" },
    ]
  );
  assert.throws(() => parseServicesFromCfg({ services: {} }), /must be an array/);
  assert.throws(() => parseServicesFromCfg({ services: [null] }), /entry must be a table/);
  assert.throws(
    () => parseServicesFromCfg({ services: [{ service: "x" }] }),
    /needs both 'binding' and 'service'/
  );
  assert.throws(
    () => parseServicesFromCfg({ services: [{ binding: "X" }] }),
    /needs both 'binding' and 'service'/
  );
  assert.throws(
    () => parseServicesFromCfg({ services: [{ binding: "X", service: "y", entrypoint: "1bad" }] }),
    /entrypoint must be a JS identifier/
  );
  assert.throws(
    () => parseServicesFromCfg({ services: [{ binding: "X", service: "y", ns: "BAD NS" }] }),
    /ns must match/
  );
  assert.deepEqual(
    parseServicesFromCfg({ services: [{ binding: "SYS", service: "dash", ns: "__reserved__" }] }),
    [{ binding: "SYS", service: "dash", ns: "__reserved__" }]
  );
  assert.throws(
    () => parseServicesFromCfg({ services: [{ binding: "X", service: "y", ns: "admin" }] }),
    /ns must match/
  );
});

test("parseServicesFromCfg: rejects runtime-reserved entrypoint names (__Wdl…__)", () => {
  // CLI fail-fast — the user sees the error before deploy fans out to a
  // round-trip with control. Server-side `validateBindings` +
  // `linkServiceBinding` are the real trust boundary; this is the
  // ergonomic mirror.
  for (const reserved of ["__WdlReserved__", "__WdlSomething__", "__Wdl__"]) {
    assert.throws(
      () =>
        parseServicesFromCfg({
          services: [{ binding: "X", service: "t", entrypoint: reserved }],
        }),
      /reserved for runtime-injected/,
      `expected reserved-entrypoint rejection for ${JSON.stringify(reserved)}`,
    );
  }
  // `__WdlNotReserved` lacks the trailing `__`, so it's user-controllable.
  // Defensive sanity that the regex is anchored on both ends.
  assert.doesNotThrow(() =>
    parseServicesFromCfg({
      services: [{ binding: "X", service: "t", entrypoint: "__WdlNotReserved" }],
    }),
  );
});

test("collectModules: drops only top-level README, keeps nested ones", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-collect-"));
  try {
    writeFileSync(path.join(dir, "index.js"), "export default {}");
    writeFileSync(path.join(dir, "README.md"), "wrangler explainer");
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "sub", "README.md"), "# real module");
    writeFileSync(path.join(dir, "sub", "index.js"), "export default 1");
    const out = collectModules(dir);
    assert.ok(out["index.js"], "top-level entry module kept");
    assert.ok(out["sub/index.js"], "nested module kept");
    assert.ok(out["sub/README.md"], "nested README kept");
    assert.strictEqual(out["README.md"], undefined, "top-level README dropped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectModules: preserves prototype-shaped module names as own manifest keys", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-collect-proto-"));
  try {
    writeFileSync(path.join(dir, "__proto__"), "opaque bytes");
    const out = collectModules(dir);
    assert.equal(Object.hasOwn(out, "__proto__"), true);
    assert.deepEqual(out["__proto__"], {
      data_b64: Buffer.from("opaque bytes").toString("base64"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectModules: refuses to follow a symlink in wrangler's outdir", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "wdl-mod-sym-"));
  const outdir = path.join(parent, "out");
  const outside = path.join(parent, "secret");
  try {
    mkdirSync(outdir, { recursive: true });
    writeFileSync(outside, "leak");
    symlinkSync(outside, path.join(outdir, "evil.js"));
    assert.throws(() => collectModules(outdir), /symlink/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("collectAssets: recurses and preserves dotfiles as base64", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-"));
  try {
    mkdirSync(path.join(dir, ".well-known"), { recursive: true });
    writeFileSync(path.join(dir, ".well-known", "security.txt"), "contact: ops@example.com");
    mkdirSync(path.join(dir, "img"));
    writeFileSync(path.join(dir, "img", "logo.bin"), Buffer.from([0, 1, 255]));

    const out = collectAssets(dir);
    assert.equal(
      out[".well-known/security.txt"],
      Buffer.from("contact: ops@example.com").toString("base64")
    );
    assert.equal(out["img/logo.bin"], Buffer.from([0, 1, 255]).toString("base64"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets: preserves prototype-shaped asset names as own manifest keys", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-proto-"));
  try {
    writeFileSync(path.join(dir, "__proto__"), "asset bytes");
    const out = collectAssets(dir);
    assert.equal(Object.hasOwn(out, "__proto__"), true);
    assert.equal(out["__proto__"], Buffer.from("asset bytes").toString("base64"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets: rejects a symlinked file inside the assets tree", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "wdl-assets-sym-"));
  const dir = path.join(parent, "public");
  const secret = path.join(parent, "secret.txt");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(secret, "PRIVATE_KEY_MATERIAL");
    symlinkSync(secret, path.join(dir, "safe.html"));
    assert.throws(() => collectAssets(dir), /symlink not allowed/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("collectAssets: rejects a symlinked subdirectory", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "wdl-assets-symdir-"));
  const dir = path.join(parent, "public");
  const outside = path.join(parent, "sshkeys");
  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(outside, "id_rsa"), "PRIVATE_KEY_MATERIAL");
    symlinkSync(outside, path.join(dir, "subdir"));
    assert.throws(() => collectAssets(dir), /symlink not allowed/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("collectAssets: rejects a file that exceeds the per-file cap", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-big-"));
  try {
    writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(MAX_ASSET_FILE_BYTES + 1));
    assert.throws(() => collectAssets(dir), /exceeds .* per-file cap/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets skips repo/tooling artifacts and .env files by default", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-ignore-"));
  try {
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    writeFileSync(path.join(dir, ".env"), "ADMIN_TOKEN=leak");
    writeFileSync(path.join(dir, ".env.production"), "ADMIN_TOKEN=leak");
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main");
    mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "pkg", "x.js"), "x");
    mkdirSync(path.join(dir, ".deploy-dist"), { recursive: true });
    writeFileSync(path.join(dir, ".deploy-dist", "index.js"), "bundled");
    mkdirSync(path.join(dir, ".wrangler"), { recursive: true });
    writeFileSync(path.join(dir, ".wrangler", "state.json"), "{}");
    mkdirSync(path.join(dir, "sub", "node_modules"), { recursive: true });
    writeFileSync(path.join(dir, "sub", "node_modules", "y.js"), "y");
    writeFileSync(path.join(dir, "sub", ".env"), "NESTED=leak");
    writeFileSync(path.join(dir, ".DS_Store"), "junk");

    const out = collectAssets(dir);
    assert.deepEqual(Object.keys(out).toSorted(), ["index.html"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets prunes an ignored symlink instead of rejecting it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-ignore-link-"));
  const target = mkdtempSync(path.join(tmpdir(), "wdl-assets-ignore-target-"));
  try {
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    symlinkSync(target, path.join(dir, "node_modules"));
    assert.deepEqual(Object.keys(collectAssets(dir)), ["index.html"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("collectAssets honors .assetsignore patterns, negation, and never ships the file itself", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assetsignore-"));
  try {
    writeFileSync(path.join(dir, ".assetsignore"), [
      "*.map",
      "drafts/",
      "!keep.map",
      "# comment",
      "",
      "!.env", // deliberate re-include of a default ignore
    ].join("\n"));
    writeFileSync(path.join(dir, "app.js"), "x");
    writeFileSync(path.join(dir, "app.js.map"), "m");
    writeFileSync(path.join(dir, "keep.map"), "m");
    writeFileSync(path.join(dir, ".env"), "OPT_IN=1");
    mkdirSync(path.join(dir, "drafts"), { recursive: true });
    writeFileSync(path.join(dir, "drafts", "wip.html"), "w");
    mkdirSync(path.join(dir, "nested"), { recursive: true });
    writeFileSync(path.join(dir, "nested", "deep.map"), "m");

    const out = collectAssets(dir);
    assert.deepEqual(Object.keys(out).toSorted(), [".env", "app.js", "keep.map"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets supports fnmatch character classes in .assetsignore", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-class-"));
  try {
    writeFileSync(path.join(dir, ".assetsignore"), "*.py[co]\nlog[0-9].txt\n");
    for (const name of ["a.py", "a.pyc", "a.pyo", "log1.txt", "logx.txt"]) {
      writeFileSync(path.join(dir, name), "x");
    }
    assert.deepEqual(Object.keys(collectAssets(dir)).toSorted(), ["a.py", "logx.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets treats mid-segment `**` as a single-segment `*` per gitignore", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-doublestar-"));
  try {
    writeFileSync(path.join(dir, ".assetsignore"), "a**b\n");
    writeFileSync(path.join(dir, "axxb"), "x");
    mkdirSync(path.join(dir, "art"), { recursive: true });
    writeFileSync(path.join(dir, "art", "web"), "x");
    // `a**b` must not cross the directory boundary: art/web ships, axxb doesn't.
    assert.deepEqual(Object.keys(collectAssets(dir)).toSorted(), ["art/web"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets character classes never match the path separator", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-class-sep-"));
  try {
    writeFileSync(path.join(dir, ".assetsignore"), "a[.-9]b\n[!-x]bc\n");
    mkdirSync(path.join(dir, "a"), { recursive: true });
    writeFileSync(path.join(dir, "a", "b"), "x");   // range .-9 spans "/" — must NOT match across segments
    writeFileSync(path.join(dir, "a.b"), "x");      // in-range, single segment — ignored
    writeFileSync(path.join(dir, "Abc"), "x");      // [!-x]: A is neither "-" nor "x" — ignored
    writeFileSync(path.join(dir, "-bc"), "x");      // literal "-" is in the negated set — kept
    writeFileSync(path.join(dir, "xbc"), "x");      // "x" is in the negated set — kept
    assert.deepEqual(Object.keys(collectAssets(dir)).toSorted(), ["-bc", "a/b", "xbc"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets skips crash-leftover wdl temp configs by default", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-tmpcfg-"));
  try {
    writeFileSync(path.join(dir, ".wrangler.wdl-tmp-1234.json"), "{\"vars\":{}}");
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    assert.deepEqual(Object.keys(collectAssets(dir)), ["index.html"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets reports ignored entries via onIgnore, excluding .assetsignore itself", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-onignore-"));
  try {
    writeFileSync(path.join(dir, ".assetsignore"), "*.map\n");
    writeFileSync(path.join(dir, "app.js"), "x");
    writeFileSync(path.join(dir, "app.js.map"), "m");
    mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "x.js"), "x");
    const skipped = [];
    collectAssets(dir, { onIgnore: (relPath, isDir) => skipped.push(isDir ? `${relPath}/` : relPath) });
    assert.deepEqual(skipped.toSorted(), ["app.js.map", "node_modules/"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAssetsDir: rejects assets.directory that escapes project root", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "wdl-assets-escape-"));
  const project = path.join(parent, "proj");
  try {
    mkdirSync(project, { recursive: true });
    mkdirSync(path.join(parent, "outside"));
    assert.throws(
      () => resolveAssetsDir(project, "../outside"),
      /outside the project root/
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("resolveAssetsDir: rejects an assets.directory that is itself a symlink", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "wdl-assets-dir-sym-"));
  const project = path.join(parent, "proj");
  try {
    mkdirSync(project, { recursive: true });
    mkdirSync(path.join(parent, "real"));
    symlinkSync(path.join(parent, "real"), path.join(project, "public"));
    assert.throws(
      () => resolveAssetsDir(project, "public"),
      /must not be a symlink/
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("resolveAssetsDir: accepts a directory that is inside project root", () => {
  const project = mkdtempSync(path.join(tmpdir(), "wdl-assets-ok-"));
  try {
    mkdirSync(path.join(project, "public"));
    const resolved = resolveAssetsDir(project, "public");
    assert.equal(resolved, path.join(project, "public"));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("loadWranglerConfig: prefers wrangler.toml when multiple config files exist", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-config-"));
  try {
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "toml-demo"\nmain = "src/index.js"\n');
    writeFileSync(
      path.join(dir, "wrangler.jsonc"),
      '{ "name": "jsonc-demo", "main": "src/index.js" }'
    );

    const loaded = loadWranglerConfig(dir);
    assert.equal(loaded.path, path.join(dir, "wrangler.toml"));
    assert.equal(loaded.cfg.name, "toml-demo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadWranglerConfig: parses JSONC when TOML is absent", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-config-jsonc-"));
  try {
    writeFileSync(
      path.join(dir, "wrangler.jsonc"),
      `{
        // comment
        "name": "jsonc-demo",
        "main": "src/index.js",
      }`
    );

    const loaded = loadWranglerConfig(dir);
    assert.equal(loaded.path, path.join(dir, "wrangler.jsonc"));
    assert.equal(loaded.cfg.name, "jsonc-demo");
    assert.equal(loaded.cfg.main, "src/index.js");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWranglerConfig: named environments require explicit selection", () => {
  assert.throws(
    () => resolveWranglerConfig({
      name: "demo",
      main: "src/index.js",
      env: { staging: {} },
    }, null, "wrangler.toml"),
    /named environments found \(staging\)/
  );
});

test("resolveWranglerConfig: selected environment inherits supported top-level keys", () => {
  const { cfg, envName } = resolveWranglerConfig({
    name: "demo",
    main: "src/index.js",
    compatibility_date: "2026-05-31",
    compatibility_flags: ["nodejs_compat"],
    route: "dev.example.com/*",
    triggers: { crons: ["*/5 * * * *"] },
    env: {
      staging: {
        compatibility_flags: ["nodejs_als"],
      },
    },
  }, "staging", "wrangler.toml");

  assert.equal(envName, "staging");
  assert.equal(cfg.name, "demo");
  assert.equal(cfg.main, "src/index.js");
  assert.equal(cfg.compatibility_date, "2026-05-31");
  assert.deepEqual(cfg.compatibility_flags, ["nodejs_als"]);
  assert.equal(cfg.route, "dev.example.com/*");
  assert.deepEqual(cfg.triggers, { crons: ["*/5 * * * *"] });
});

test("resolveWranglerConfig: worker name stays as top-level name regardless of env", () => {
  const { cfg } = resolveWranglerConfig({
    name: "demo",
    main: "src/index.js",
    env: {
      staging: {},
    },
  }, "staging", "wrangler.toml");

  assert.equal(cfg.name, "demo");
});

test("resolveWranglerConfig: non-inheritable keys are env-scoped while inheritable keys carry through", () => {
  const { cfg } = resolveWranglerConfig({
    name: "demo",
    main: "src/index.js",
    vars: { TOP: "1" },
    kv_namespaces: [{ binding: "KV", id: "top" }],
    services: [{ binding: "AUTH", service: "auth" }],
    queues: { producers: [{ binding: "Q", queue: "top-q" }] },
    assets: { directory: "./top-public" },
    env: {
      prod: {
        vars: { ENV: "prod" },
        kv_namespaces: [{ binding: "KV", id: "prod" }],
        queues: { consumers: [{ queue: "jobs" }] },
      },
    },
  }, "prod", "wrangler.jsonc");

  assert.deepEqual(cfg.vars, { ENV: "prod" });
  assert.deepEqual(cfg.kv_namespaces, [{ binding: "KV", id: "prod" }]);
  assert.deepEqual(cfg.queues, { consumers: [{ queue: "jobs" }] });
  assert.equal(cfg.services, undefined);
  assert.deepEqual(cfg.assets, { directory: "./top-public" });
});

test("resolveWranglerConfig: selected environment can override inherited assets", () => {
  const { cfg } = resolveWranglerConfig({
    name: "demo",
    main: "src/index.js",
    assets: { directory: "./top-public" },
    env: {
      prod: {
        assets: { directory: "./prod-public" },
      },
    },
  }, "prod", "wrangler.jsonc");

  assert.deepEqual(cfg.assets, { directory: "./prod-public" });
});

test("resolveWranglerConfig: rejects unknown environment names", () => {
  assert.throws(
    () => resolveWranglerConfig({
      name: "demo",
      main: "src/index.js",
      env: { staging: {} },
    }, "prod", "wrangler.toml"),
    /environment "prod" not found/
  );
});

test("resolveWranglerConfig: rejects top-level-only keys inside an environment", () => {
  assert.throws(
    () => resolveWranglerConfig({
      name: "demo",
      main: "src/index.js",
      env: {
        staging: {
          migrations: [],
        },
      },
    }, "staging", "wrangler.toml"),
    /env\.staging\.migrations is top-level only/
  );
});

test("resolveWranglerConfig: rejects env-specific name overrides", () => {
  assert.throws(
    () => resolveWranglerConfig({
      name: "demo",
      main: "src/index.js",
      env: {
        staging: {
          name: "foo",
        },
      },
    }, "staging", "wrangler.toml"),
    /env\.staging\.name is top-level only/
  );
});

test("resolveWranglerConfig drops __proto__ keys instead of rewriting the merged prototype", () => {
  const rawCfg = JSON.parse(
    '{"name":"demo","main":"src/index.js","__proto__":{"polluted":true},"env":{"prod":{"__proto__":{"polluted":true},"vars":{"A":"1"}}}}'
  );
  const { cfg } = resolveWranglerConfig(rawCfg, "prod", "wrangler.jsonc");
  assert.equal(Object.getPrototypeOf(cfg), Object.prototype);
  assert.equal(/** @type {any} */ (cfg).polluted, undefined);
  assert.deepEqual(cfg.vars, { A: "1" });
});

test("validateUnsupportedWranglerConfig: workflows are supported at top-level and selected env", () => {
  assert.doesNotThrow(() => validateUnsupportedWranglerConfig({
    name: "demo",
    main: "src/index.js",
    workflows: [{ binding: "WF" }],
    env: { staging: { workflows: [{ binding: "WF" }] } },
  }, "staging", "wrangler.toml"));
});

test("validateUnsupportedWranglerConfig: rejects unsupported top-level config even when env is selected", () => {
  assert.throws(
    () => validateUnsupportedWranglerConfig({
      name: "demo",
      main: "src/index.js",
      analytics_engine_datasets: [{ binding: "AE" }],
      env: { staging: {} },
    }, "staging", "wrangler.toml"),
    /\[analytics_engine_datasets\] — not supported/
  );
});

test("validateUnsupportedWranglerConfig: rejects unsupported config inside the selected environment", () => {
  assert.throws(
    () => validateUnsupportedWranglerConfig({
      name: "demo",
      main: "src/index.js",
      env: {
        staging: {
          analytics_engine_datasets: [{ binding: "AE" }],
        },
      },
    }, "staging", "wrangler.toml"),
    /env\.staging uses \[analytics_engine_datasets\] — not supported/
  );
});

test("validateUnsupportedWranglerConfig rejects unmapped wrangler binding sections", () => {
  for (const key of ["ai", "vectorize", "hyperdrive", "browser", "mtls_certificates"]) {
    assert.throws(
      () => validateUnsupportedWranglerConfig({
        name: "demo",
        main: "src/index.js",
        [key]: key === "ai" || key === "browser" ? { binding: "B" } : [{ binding: "B" }],
      }, null, "wrangler.toml"),
      new RegExp(`\\[${key}\\] — not supported`)
    );
  }
  // The rejection lists the actual supported surface.
  try {
    validateUnsupportedWranglerConfig(
      { name: "demo", main: "src/index.js", vectorize: [{ binding: "V" }] },
      null,
      "wrangler.toml"
    );
    assert.fail("expected vectorize rejection");
  } catch (err) {
    assert.match(err.message, /\[\[queues\.producers\]\]/);
    assert.match(err.message, /\[\[platform_bindings\]\]/);
    assert.match(err.message, /\[triggers\]/);
  }
});

test("validateUnsupportedWranglerConfig rejects module-binding and container sections", () => {
  assert.throws(
    () => validateUnsupportedWranglerConfig(
      { name: "demo", main: "src/index.js", wasm_modules: { MOD: "./m.wasm" } },
      null,
      "wrangler.toml"
    ),
    /\[wasm_modules\] — not supported/
  );
  assert.throws(
    () => validateUnsupportedWranglerConfig(
      { name: "demo", main: "src/index.js", containers: [{ class_name: "C" }] },
      null,
      "wrangler.toml"
    ),
    /\[containers\] — not supported/
  );
});

test("parseWorkflowsFromCfg: parses local workflow declarations", () => {
  assert.deepEqual(parseWorkflowsFromCfg({}), []);
  assert.deepEqual(parseWorkflowsFromCfg({
    workflows: [
      { name: "order-workflow", binding: "ORDER_WORKFLOW", class_name: "OrderWorkflow" },
      { name: "My_Workflow2", binding: "WF2", class_name: "MyWorkflow" },
    ],
  }), [
    { name: "order-workflow", binding: "ORDER_WORKFLOW", className: "OrderWorkflow" },
    { name: "My_Workflow2", binding: "WF2", className: "MyWorkflow" },
  ]);
});

test("parseWorkflowsFromCfg: rejects invalid names and unsupported script_name", () => {
  assert.throws(() => parseWorkflowsFromCfg({ workflows: {} }), /must be an array/);
  assert.throws(
    () => parseWorkflowsFromCfg({ workflows: [{ name: "bad:name", binding: "WF", class_name: "Flow" }] }),
    /name must match/
  );
  assert.throws(
    () => parseWorkflowsFromCfg({ workflows: [{ name: "constructor", binding: "WF", class_name: "Flow" }] }),
    /reserved Object\.prototype key/
  );
  assert.throws(
    () => parseWorkflowsFromCfg({ workflows: [{ name: "flow", binding: "bad-binding", class_name: "Flow" }] }),
    /binding must match/
  );
  assert.throws(
    () => parseWorkflowsFromCfg({ workflows: [{ name: "flow", binding: "__WDL_WORKFLOWS_BACKEND__", class_name: "Flow" }] }),
    /runtime-internal bindings/
  );
  assert.throws(
    () => parseWorkflowsFromCfg({ workflows: [{ name: "flow", binding: "WF", class_name: "not-valid" }] }),
    /class_name must be a valid JS class declaration name/
  );
  assert.throws(
    () => parseWorkflowsFromCfg({ workflows: [{ name: "flow", binding: "WF", class_name: "class" }] }),
    /class_name must be a valid JS class declaration name/
  );
  assert.throws(
    () => parseWorkflowsFromCfg({ workflows: [{ name: "flow", binding: "WF", class_name: "__WdlReserved__" }] }),
    /reserved for runtime-injected entrypoints/
  );
  assert.throws(
    () => parseWorkflowsFromCfg({ workflows: [{ name: "flow", binding: "WF", class_name: "Flow", script_name: "other" }] }),
    /script_name is not supported/
  );
});

test("parseExportsFromCfg: absent → empty; snake→camel translation", () => {
  assert.deepEqual(parseExportsFromCfg({}), []);
  const out = parseExportsFromCfg({
    exports: [
      {
        entrypoint: "Echo",
        as: "DEMO",
        allowed_callers: ["*"],
        required_caller_secrets: ["KEY_A"],
      },
    ],
  });
  assert.deepEqual(out, [
    {
      entrypoint: "Echo",
      allowedCallers: ["*"],
      as: "DEMO",
      requiredCallerSecrets: ["KEY_A"],
    },
  ]);
});

test("parseExportsFromCfg: missing allowed_callers rejected", () => {
  assert.throws(
    () => parseExportsFromCfg({ exports: [{ entrypoint: "Public" }] }),
    /allowed_callers must be an array of strings/
  );
});

test("parseExportsFromCfg: generated wrapper entrypoint names reject reserved words", () => {
  assert.throws(
    () => parseExportsFromCfg({ exports: [{ entrypoint: "class", allowed_callers: ["*"] }] }),
    /valid JS class declaration name or "default"/
  );
  assert.throws(
    () => parseExportsFromCfg({ exports: [{ entrypoint: "__WdlReserved__", allowed_callers: ["*"] }] }),
    /reserved for runtime-injected entrypoints/
  );
});

test("parseExportsFromCfg: allowed_callers stays tenant-facing", () => {
  assert.throws(
    () =>
      parseExportsFromCfg({
        exports: [{ entrypoint: "Public", allowed_callers: ["__reserved__"] }],
      }),
    /allowed_callers entries must be "\*" or match/
  );
});

test("parseExportsFromCfg: bad `as` grammar rejected", () => {
  assert.throws(
    () =>
      parseExportsFromCfg({
        exports: [{ entrypoint: "Echo", as: "lower-kebab", allowed_callers: ["*"] }],
      }),
    /as must match/
  );
});

test("parseExportsFromCfg: required_caller_secrets must be upper-snake", () => {
  assert.throws(
    () =>
      parseExportsFromCfg({
        exports: [
          {
            entrypoint: "Echo",
            as: "DEMO",
            allowed_callers: ["*"],
            required_caller_secrets: ["lowercase"],
          },
        ],
      }),
    /required_caller_secrets entries must match/
  );
});

test("parsePlatformBindingsFromCfg: absent → empty; default platform=binding", () => {
  assert.deepEqual(parsePlatformBindingsFromCfg({}), []);
  const out = parsePlatformBindingsFromCfg({
    platform_bindings: [{ binding: "DEMO" }, { binding: "PAYMENT", platform: "STRIPE" }],
  });
  assert.deepEqual(out, [
    { binding: "DEMO", platform: "DEMO" },
    { binding: "PAYMENT", platform: "STRIPE" },
  ]);
});

test("parsePlatformBindingsFromCfg: rejects non-upper-snake binding", () => {
  assert.throws(
    () => parsePlatformBindingsFromCfg({ platform_bindings: [{ binding: "lowercase" }] }),
    /binding must match/
  );
});

test("parsePlatformBindingsFromCfg: rejects runtime-internal binding names", () => {
  assert.throws(
    () => parsePlatformBindingsFromCfg({ platform_bindings: [{ binding: "__WDL_RESERVED__" }] }),
    /runtime-internal bindings/
  );
});

test("parseWranglerMajorVersion accepts common wrangler --version output", () => {
  assert.equal(parseWranglerMajorVersion("4.94.0"), 4);
  assert.equal(parseWranglerMajorVersion("wrangler 4.94.0"), 4);
  assert.equal(parseWranglerMajorVersion(" ⛅️ wrangler 4.94.0\n"), 4);
  assert.equal(parseWranglerMajorVersion("not a version"), null);
});

test("resolveWranglerCommand prefers explicit WDL_WRANGLER_BIN", () => {
  assert.deepEqual(
    resolveWranglerCommand({
      absProject: "/project",
      env: { WDL_WRANGLER_BIN: "/opt/wrangler" },
      packageDirs: [],
    }),
    { command: "/opt/wrangler", args: [], source: "WDL_WRANGLER_BIN" }
  );
});

test("resolveWranglerCommand prefers project-local wrangler without npx", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-wrangler-bin-"));
  try {
    const binDir = path.join(dir, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, process.platform === "win32" ? "wrangler.cmd" : "wrangler");
    writeFileSync(bin, "");

    assert.deepEqual(
      resolveWranglerCommand({
        absProject: dir,
        env: { WDL_ALLOW_NPX_WRANGLER: "1" },
        packageDirs: [],
      }),
      { command: bin, args: [], source: "local" }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWranglerCommand uses PATH wrangler by default", () => {
  assert.deepEqual(
    resolveWranglerCommand({
      absProject: "/project",
      env: {},
      packageDirs: [],
    }),
    { command: "wrangler", args: [], source: "path" }
  );
});

test("resolveWranglerCommand prefers PATH wrangler before npx", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-wrangler-path-"));
  try {
    const bin = path.join(dir, process.platform === "win32" ? "wrangler.cmd" : "wrangler");
    writeFileSync(bin, "");

    assert.deepEqual(
      resolveWranglerCommand({
        absProject: "/project",
        env: { PATH: dir, WDL_ALLOW_NPX_WRANGLER: "1" },
        packageDirs: [],
      }),
      { command: bin, args: [], source: "path" }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWranglerCommand only uses npx when explicitly allowed", () => {
  assert.deepEqual(
    resolveWranglerCommand({
      absProject: "/project",
      env: { WDL_ALLOW_NPX_WRANGLER: "1" },
      packageDirs: [],
    }),
    { command: "npx", args: ["--yes", "wrangler"], source: "npx" }
  );
});

test("resolveWranglerCommand ignores unrelated cwd local wrangler", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "wdl-wrangler-cwd-"));
  const packageDir = mkdtempSync(path.join(tmpdir(), "wdl-wrangler-package-"));
  const originalCwd = process.cwd();
  try {
    const cwdBinDir = path.join(cwd, "node_modules", ".bin");
    mkdirSync(cwdBinDir, { recursive: true });
    writeFileSync(path.join(cwdBinDir, process.platform === "win32" ? "wrangler.cmd" : "wrangler"), "");
    process.chdir(cwd);

    const packageBinDir = path.join(packageDir, "node_modules", ".bin");
    mkdirSync(packageBinDir, { recursive: true });
    const packageBin = path.join(packageBinDir, process.platform === "win32" ? "wrangler.cmd" : "wrangler");
    writeFileSync(packageBin, "");

    assert.deepEqual(
      resolveWranglerCommand({
        absProject: "/trusted/project",
        env: {},
        packageDirs: [packageDir],
      }),
      { command: packageBin, args: [], source: "local" }
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("resolveWranglerCommand on win32 runs the wrangler JS entry via node instead of the .cmd shim", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-wrangler-win32-"));
  try {
    const pkgBin = path.join(dir, "node_modules", "wrangler", "bin");
    mkdirSync(pkgBin, { recursive: true });
    const script = path.join(pkgBin, "wrangler.js");
    writeFileSync(script, "");
    const shimDir = path.join(dir, "node_modules", ".bin");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(path.join(shimDir, "wrangler.cmd"), "");

    assert.deepEqual(
      resolveWranglerCommand({ absProject: dir, env: {}, packageDirs: [], platform: "win32" }),
      { command: process.execPath, args: [script], source: "local" }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWranglerCommand on win32 prefers the package script next to a PATH .cmd shim", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-wrangler-win32-path-"));
  try {
    writeFileSync(path.join(dir, "wrangler.cmd"), "");
    const pkgBin = path.join(dir, "node_modules", "wrangler", "bin");
    mkdirSync(pkgBin, { recursive: true });
    const script = path.join(pkgBin, "wrangler.js");
    writeFileSync(script, "");

    assert.deepEqual(
      resolveWranglerCommand({ absProject: "/project", env: { PATH: dir }, packageDirs: [], platform: "win32" }),
      { command: process.execPath, args: [script], source: "path" }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWranglerCommand on win32 fails loudly when only a bare PATH .cmd shim exists", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-wrangler-win32-bare-shim-"));
  try {
    writeFileSync(path.join(dir, "wrangler.cmd"), "");
    // A bare "wrangler" fallback would resolve back to the unrunnable shim
    // (or ENOENT); the resolver must refuse with an actionable error instead.
    assert.throws(
      () => resolveWranglerCommand({ absProject: "/project", env: { PATH: dir }, packageDirs: [], platform: "win32" }),
      /No runnable wrangler found/
    );
    // The npx opt-in still provides a working escape hatch.
    assert.deepEqual(
      resolveWranglerCommand({
        absProject: "/project",
        env: { PATH: dir, WDL_ALLOW_NPX_WRANGLER: "1" },
        packageDirs: [],
        platform: "win32",
      }),
      { command: "npx", args: ["--yes", "wrangler"], source: "npx" }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wranglerChildEnv strips WDL control-plane environment", () => {
  assert.deepEqual(
    wranglerChildEnv({
      ADMIN_TOKEN: "secret",
      CONTROL_CONNECT_HOST: "ctl.connect.example",
      CONTROL_URL: "https://ctl.example",
      WDL_NS: "tenant",
      // Legacy alias the CLI no longer reads, but must still scrub so a stale
      // export does not leak the control endpoint into the bundler.
      ADMIN_URL: "https://legacy-admin.example",
      CLOUDFLARE_API_TOKEN: "real-cloudflare-token",
      PATH: "/bin",
      KEEP_ME: "ok",
    }),
    {
      CLOUDFLARE_API_TOKEN: "dry-run-dummy",
      PATH: "/bin",
      KEEP_ME: "ok",
    }
  );
});

test("runDeployCommand resolves cwd-relative project dir and WDL_NS fallback", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-"));
  const dir = path.join(parent, "sub");
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      [
        'name = "api"',
        'main = "src/index.js"',
        'compatibility_date = "2026-05-31"',
        "",
        "[[d1_databases]]",
        'binding = "DB"',
        'database_name = "main"',
        'database_id = "cf-id"',
        "",
        "[[r2_buckets]]",
        'binding = "BUCKET"',
        'bucket_name = "uploads"',
        "",
        "[[durable_objects.bindings]]",
        'name = "ROOMS"',
        'class_name = "Room"',
        "",
        "[[workflows]]",
        'name = "order-workflow"',
        'binding = "ORDER_WORKFLOW"',
        'class_name = "OrderWorkflow"',
        "",
        "[[migrations]]",
        'tag = "v1"',
        'new_classes = ["Room"]',
        "",
        "[vars]",
        'HELLO = "world"',
        "",
      ].join("\n")
    );

    const execCalls = [];
    const fetchCalls = [];
    const lines = [];
    await runDeployCommand(
      ["sub", "--control-url", "http://ctl.test"],
      {
        env: {
          ADMIN_TOKEN: "tok",
          WDL_NS: "demo space",
          CLOUDFLARE_API_TOKEN: "real-cf-token",
        },
        cwd: parent,
        stdout: (line) => lines.push(line),
        stderr: () => {},
        execFile: (cmd, args, opts) => {
          execCalls.push({ cmd, args, opts });
          if (args.includes("--version")) return "wrangler 4.94.0";
          const outDir = args.find((arg) => arg.startsWith("--outdir=")).slice("--outdir=".length);
          mkdirSync(outDir, { recursive: true });
          writeFileSync(
            path.join(outDir, "index.js"),
            'export default { fetch() { return new Response("ok"); } };'
          );
        },
        controlFetch: async (url, init = {}) => {
          fetchCalls.push({ url, init });
          if (fetchCalls.length === 1) {
            return response({ version: "v1", warnings: [] });
          }
          return response({ platformDomain: "workers.example" });
        },
      }
    );

    assert.equal(execCalls.length, 2);
    assertWranglerCommand(execCalls[0].cmd);
    assert.deepEqual(execCalls[0].args, ["--version"]);
    assert.equal(execCalls[0].opts.cwd, dir);
    assert.deepEqual(execCalls[0].opts.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(execCalls[0].opts.encoding, "utf8");
    assert.equal(execCalls[0].opts.env.CLOUDFLARE_API_TOKEN, "dry-run-dummy");
    assert.ok(execCalls[1].args.includes("deploy"));
    assert.ok(execCalls[1].args.includes("--dry-run"));
    assert.equal(execCalls[1].opts.cwd, dir);
    assert.deepEqual(execCalls[1].opts.stdio, ["ignore", "pipe", "pipe"]);
    assert.equal(execCalls[1].opts.encoding, "utf8");
    assert.equal(execCalls[1].opts.maxBuffer, 10 * 1024 * 1024);
    assert.equal(execCalls[1].opts.env.CLOUDFLARE_API_TOKEN, "dry-run-dummy");

    assert.equal(fetchCalls.length, 2);
    assert.equal(fetchCalls[0].url, "http://ctl.test/ns/demo%20space/worker/api/deploy");
    assert.equal(fetchCalls[0].init.method, "POST");
    assert.equal(fetchCalls[0].init.timeoutMs, LONG_CONTROL_TIMEOUT_MS);
    assert.deepEqual(fetchCalls[0].init.headers, {
      "content-type": "application/json",
      "x-admin-token": "tok",
    });
    const manifest = JSON.parse(fetchCalls[0].init.body);
    assert.equal(manifest.mainModule, "index.js");
    assert.equal(manifest.modules["index.js"], 'export default { fetch() { return new Response("ok"); } };');
    assert.deepEqual(manifest.bindings, {
      DB: { type: "d1", databaseId: "cf-id" },
      BUCKET: { type: "r2", bucketName: "uploads" },
      ROOMS: { type: "do", className: "Room" },
    });
    assert.deepEqual(manifest.vars, { HELLO: "world" });
    assert.deepEqual(manifest.workflows, [
      { name: "order-workflow", binding: "ORDER_WORKFLOW", className: "OrderWorkflow" },
    ]);
    assert.equal(manifest.compatibilityDate, "2026-05-31");

    assert.equal(fetchCalls[1].url, "http://ctl.test/ns/demo%20space/worker/api/promote");
    assert.equal(fetchCalls[1].init.method, "POST");
    assert.deepEqual(JSON.parse(fetchCalls[1].init.body), { version: "v1" });
    assert.ok(lines.includes("  bundled by wrangler"));
    assert.ok(lines.includes("✓ demo space/api@v1 live"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("runDeployCommand sanitizes wrangler.name via temp --config so mixed-case wdl names bundle", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-mixedcase-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, ".wrangler.wdl-tmp.json"), "user-owned");
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({
      name: "Mixed-Case-Worker",
      main: "src/index.js",
      vars: { GREETING: "hi" },
    }));

    let tmpConfigSeen = null;
    let tmpConfigContentAtExec = /** @type {{ name?: string, main?: string, vars?: unknown } | null} */ (null);
    const fetchCalls = [];
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: () => {},
      execFile: (_cmd, args) => {
        if (args.includes("--version")) return "wrangler 4.94.0";
        const cfgIdx = args.indexOf("--config");
        assert.notEqual(cfgIdx, -1, "wrangler bundle args must include --config");
        tmpConfigSeen = args[cfgIdx + 1];
        assert.ok(existsSync(tmpConfigSeen), "temp config must exist when wrangler runs");
        tmpConfigContentAtExec = JSON.parse(readFileSync(tmpConfigSeen, "utf8"));
        const outDir = args.find((arg) => arg.startsWith("--outdir=")).slice("--outdir=".length);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, "index.js"), "export default {}");
      },
      controlFetch: async (url, init = {}) => {
        fetchCalls.push({ url, init });
        if (fetchCalls.length === 1) return response({ version: "v1", warnings: [] });
        return response({ platformDomain: "workers.example" });
      },
    });

    assert.ok(
      fetchCalls[0].url.endsWith("/worker/Mixed-Case-Worker/deploy"),
      `deploy URL must carry the original wdl name, got ${fetchCalls[0].url}`
    );
    assert.ok(tmpConfigContentAtExec);
    assert.equal(tmpConfigContentAtExec.name, "wdl-bundle-tmp");
    assert.equal(tmpConfigContentAtExec.main, "src/index.js");
    assert.deepEqual(tmpConfigContentAtExec.vars, { GREETING: "hi" });
    assert.ok(tmpConfigSeen);
    assert.match(path.basename(tmpConfigSeen), /^\.wrangler\.wdl-tmp-[a-f0-9-]+\.json$/);
    assert.notEqual(tmpConfigSeen, path.join(dir, ".wrangler.wdl-tmp.json"));
    assert.equal(existsSync(tmpConfigSeen), false, "temp config should be removed after a successful bundle");
    assert.equal(readFileSync(path.join(dir, ".wrangler.wdl-tmp.json"), "utf8"), "user-owned");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand removes the sanitized temp config when wrangler exec fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-mixedcase-fail-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({
      name: "Mixed-Case-Worker",
      main: "src/index.js",
    }));

    let tmpConfigSeen = null;
    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: (_cmd, args) => {
          if (args.includes("--version")) return "wrangler 4.94.0";
          const cfgIdx = args.indexOf("--config");
          tmpConfigSeen = args[cfgIdx + 1];
          assert.ok(existsSync(tmpConfigSeen), "temp config must exist when wrangler runs");
          throw Object.assign(new Error("wrangler boom"), {
            status: 1,
            stderr: "fake wrangler failure",
          });
        },
        controlFetch: async () => {
          throw new Error("control should not be hit when bundling fails");
        },
      }),
      /wrangler build failed/
    );

    assert.ok(tmpConfigSeen, "wrangler stub should have observed the --config path");
    assert.equal(existsSync(tmpConfigSeen), false, "temp config should be removed even when wrangler fails");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand preserves prototype-shaped binding keys for control validation", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-proto-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({
      name: "api",
      main: "src/index.js",
      kv_namespaces: [{ binding: "__proto__", id: "kv-id" }],
    }));

    const fetchCalls = [];
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: () => {},
      execFile: fakeWranglerExecFile,
      controlFetch: async (url, init = {}) => {
        fetchCalls.push({ url, init });
        if (fetchCalls.length === 1) return response({ version: "v1", warnings: [] });
        return response({ platformDomain: "workers.example" });
      },
    });

    const manifest = JSON.parse(fetchCalls[0].init.body);
    assert.equal(Object.hasOwn(manifest.bindings, "__proto__"), true);
    assert.deepEqual(manifest.bindings["__proto__"], { type: "kv", id: "kv-id" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects non-object vars before bundling", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-vars-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({
      name: "api",
      main: "src/index.js",
      vars: [],
    }));

    let execCalled = false;
    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        execFile: () => {
          execCalled = true;
          throw new Error("execFile should not be called");
        },
      }),
      { message: "[vars] must be an object" }
    );
    assert.equal(execCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand shell-quotes and terminal-escapes local curl hint host", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-curl-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), 'export default { fetch() { return new Response("ok"); } };');
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      [
        'name = "api"',
        'main = "src/index.js"',
        'compatibility_date = "2026-05-31"',
      ].join("\n")
    );

    const lines = [];
    let fetchCount = 0;
    await runDeployCommand(
      [dir, "--ns", "demo", "--control-url", "http://localhost:8080"],
      {
        env: { ADMIN_TOKEN: "tok" },
        stdout: (line) => lines.push(line),
        stderr: () => {},
        execFile: (_cmd, args) => {
          if (args.includes("--version")) return "wrangler 4.94.0";
          const outDir = args.find((arg) => arg.startsWith("--outdir=")).slice("--outdir=".length);
          mkdirSync(outDir, { recursive: true });
          writeFileSync(path.join(outDir, "index.js"), 'export default { fetch() { return new Response("ok"); } };');
        },
        controlFetch: async () => {
          fetchCount += 1;
          return fetchCount === 1
            ? response({ version: "v1", warnings: [] })
            : response({ platformDomain: "workers.example'; echo pwn #\u001b]0;x\u0007" });
        },
      }
    );

    const curlLine = lines.find((line) => line.startsWith("  curl -H 'Host: "));
    assert.ok(curlLine, "expected curl hint line to be emitted");
    assert.ok(curlLine.includes("  curl -H 'Host: demo.workers.example"), "expected host prefix in curl hint");
    assert.ok(curlLine.includes("'\\''; echo pwn #"), "expected shell-escaped single quote in host");
    assert.ok(curlLine.includes("\\u001b]0;x\\u0007"), "expected terminal control chars to be unicode-escaped");
    assert.ok(curlLine.endsWith("' http://localhost:8080/api/"), "expected curl hint URL suffix");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand detects local control by hostname only", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-nonlocal-host-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), 'export default { fetch() { return new Response("ok"); } };');
    writeFileSync(path.join(dir, "wrangler.toml"), [
      'name = "api"',
      'main = "src/index.js"',
    ].join("\n"));

    const lines = [];
    let fetchCount = 0;
    await runDeployCommand(
      [dir, "--ns", "demo", "--control-url", "https://ctl.example/localhost"],
      {
        env: { ADMIN_TOKEN: "tok" },
        stdout: (line) => lines.push(line),
        stderr: () => {},
        execFile: (_cmd, args) => {
          if (args.includes("--version")) return "wrangler 4.94.0";
          const outDir = args.find((arg) => arg.startsWith("--outdir=")).slice("--outdir=".length);
          mkdirSync(outDir, { recursive: true });
          writeFileSync(path.join(outDir, "index.js"), 'export default { fetch() { return new Response("ok"); } };');
        },
        controlFetch: async () => {
          fetchCount += 1;
          return fetchCount === 1
            ? response({ version: "v1", warnings: [] })
            : response({ platformDomain: "workers.example" });
        },
      }
    );

    assert.ok(lines.includes("  https://demo.workers.example/api/"));
    assert.equal(lines.some((line) => line.includes("curl -H")), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects non-scalar vars before bundling", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-vars-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({
      name: "api",
      main: "src/index.js",
      vars: {
        FOO: { nested: true },
      },
    }));

    let execCalled = false;
    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        execFile: () => {
          execCalled = true;
          throw new Error("execFile should not be called");
        },
      }),
      { message: "[vars] FOO: only string/number/boolean values are supported" }
    );
    assert.equal(execCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects runtime-internal vars before bundling", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-vars-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({
      name: "api",
      main: "src/index.js",
      vars: {
        __WDL_RESERVED__: "x",
      },
    }));

    let execCalled = false;
    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        execFile: () => {
          execCalled = true;
          throw new Error("execFile should not be called");
        },
      }),
      { message: "[vars] __WDL_RESERVED__: name is reserved for runtime-internal bindings" }
    );
    assert.equal(execCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects Object.prototype-shaped vars before bundling", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-vars-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(
      path.join(dir, "wrangler.json"),
      '{"name":"api","main":"src/index.js","vars":{"__proto__":"x"}}'
    );

    let execCalled = false;
    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        execFile: () => {
          execCalled = true;
          throw new Error("execFile should not be called");
        },
      }),
      { message: "[vars] __proto__: name is a reserved Object.prototype key" }
    );
    assert.equal(execCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand passes through wrangler output in verbose mode", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-verbose-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "api"\nmain = "src/index.js"\n');

    const execCalls = [];
    await runDeployCommand([dir, "--ns", "demo", "--verbose"], {
      env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
      stdout: () => {},
      stderr: () => {},
      execFile: (cmd, args, opts) => {
        execCalls.push({ cmd, args, opts });
        if (args.includes("--version")) return "wrangler 4.94.0";
        const outDir = args.find((arg) => arg.startsWith("--outdir=")).slice("--outdir=".length);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, "index.js"), "export default {}");
      },
      controlFetch: async () => response({ version: "v1", warnings: [] }),
    });

    assert.equal(execCalls.length, 2);
    assertWranglerCommand(execCalls[0].cmd);
    assert.deepEqual(execCalls[0].args, ["--version"]);
    assert.equal(execCalls[1].opts.stdio, "inherit");
    assert.equal(Object.hasOwn(execCalls[1].opts, "encoding"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects wrangler v3 before dry-run", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-v3-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "api"\nmain = "src/index.js"\n');

    const execCalls = [];
    const lines = [];
    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: (line) => lines.push(line),
        stderr: () => {},
        execFile: (cmd, args, opts) => {
          execCalls.push({ cmd, args, opts });
          return "wrangler 3.114.0";
        },
        controlFetch: async () => response({}),
      }),
      /requires Wrangler v4 \(wrangler@\^4\); found v3/
    );
    assert.equal(execCalls.length, 1);
    assertWranglerCommand(execCalls[0].cmd);
    assert.deepEqual(execCalls[0].args, ["--version"]);
    assert.deepEqual(lines, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand reports captured wrangler output only when dry-run fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-fail-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "api"\nmain = "src/index.js"\n');

    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: (_cmd, args) => {
          if (args.includes("--version")) return "wrangler 4.94.0";
          throw Object.assign(new Error("Command failed"), {
            status: 1,
            stdout: "wrangler stdout",
            stderr: "wrangler stderr",
          });
        },
        controlFetch: async () => response({}),
      }),
      /wrangler build failed \(1\)\nwrangler stdout\nwrangler stderr/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand warns with wdl secret hints for missing caller secrets", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-warning-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "api"\nmain = "src/index.js"\n');

    const warnings = [];
    let fetchCount = 0;
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: (line) => warnings.push(line),
      execFile: fakeWranglerExecFile,
      controlFetch: async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return response({
            version: "v2",
            warnings: [
              {
                binding: "PAYMENT",
                platform: "STRIPE",
                missingCallerSecrets: ["API_KEY"],
              },
            ],
          });
        }
        return response({});
      },
    });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /wdl secret put --ns demo --scope ns <KEY>/);
    assert.match(warnings[0], /wdl secret put --ns demo --worker api <KEY>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand projects unknown deploy warnings before printing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-warning-project-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "api"\nmain = "src/index.js"\n');

    const warnings = [];
    let fetchCount = 0;
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: (line) => warnings.push(line),
      execFile: fakeWranglerExecFile,
      controlFetch: async () => {
        fetchCount += 1;
        if (fetchCount === 1) {
          return response({
            version: "v2",
            warnings: [{
              code: "unsupported_option",
              message: "ignored field",
              internalTaskId: "task-secret",
            }],
          });
        }
        return response({});
      },
    });

    assert.deepEqual(warnings, ['warning: {"code":"unsupported_option","message":"ignored field"}']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("serializeDeployManifest enforces the control request body cap", () => {
  assert.equal(DEPLOY_JSON_BODY_MAX_BYTES, 32 * 1024 * 1024);
  assert.equal(serializeDeployManifest({ modules: { "index.js": "x" } }, 64), '{"modules":{"index.js":"x"}}');
  assert.throws(
    () => serializeDeployManifest({ modules: { "index.js": "x".repeat(80) } }, 64),
    /deploy manifest is \d+ bytes, exceeds 64 byte control-plane request cap/
  );
});

test("runDeployCommand warns that DO named entrypoints must be declared exports", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-do-warning-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export class Room {}; export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), `
name = "chat"
main = "src/index.js"

[[durable_objects.bindings]]
name = "ROOMS"
class_name = "Room"

[[migrations]]
tag = "v1"
new_classes = ["Room"]
`);

    const warnings = [];
    let fetchCount = 0;
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: (line) => warnings.push(line),
      execFile: (_cmd, args) => {
        if (args.includes("--version")) return "wrangler 4.94.0";
        const outDir = args.find((arg) => arg.startsWith("--outdir=")).slice("--outdir=".length);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, "index.js"), "export class Room {}; export default {}");
      },
      controlFetch: async () => {
        fetchCount += 1;
        return fetchCount === 1 ? response({ version: "v1" }) : response({});
      },
    });

    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /Durable Object workers expose named WorkerEntrypoint classes only when listed in \[\[exports\]\]/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects workflow binding collisions before bundling", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-workflow-collision-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), `
name = "api"
main = "src/index.js"

[[kv_namespaces]]
binding = "FLOW"
id = "sessions"

[[workflows]]
name = "flow"
binding = "FLOW"
class_name = "Flow"
`);
    let execCalled = false;
    await assert.rejects(
      runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: () => { execCalled = true; },
        controlFetch: async () => response({}),
      }),
      /binding name collision: FLOW/
    );
    assert.equal(execCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects platform binding collisions wrangler cannot see", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-platform-collision-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), `
name = "api"
main = "src/index.js"

[[kv_namespaces]]
binding = "SHARED"
id = "sessions"

[[platform_bindings]]
binding = "SHARED"
`);
    let execCalled = false;
    await assert.rejects(
      runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: () => { execCalled = true; },
        controlFetch: async () => response({}),
      }),
      /binding name collision: SHARED/
    );
    assert.equal(execCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand maps a .mts main to the bundled .js entry", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-mts-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.mts"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "api"\nmain = "src/index.mts"\n');

    const fetchCalls = [];
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: () => {},
      execFile: fakeWranglerExecFile,
      controlFetch: async (url, init = {}) => {
        fetchCalls.push({ url, init });
        if (fetchCalls.length === 1) return response({ version: "v1", warnings: [] });
        return response({ platformDomain: "wdl.sh" });
      },
    });

    const manifest = JSON.parse(fetchCalls[0].init.body);
    assert.equal(manifest.mainModule, "index.js");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand notes skipped asset entries on stderr", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-skip-note-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    mkdirSync(path.join(dir, "public", "node_modules"), { recursive: true });
    writeFileSync(path.join(dir, "public", "index.html"), "<html></html>");
    writeFileSync(path.join(dir, "public", "node_modules", "x.js"), "x");
    writeFileSync(path.join(dir, "wrangler.toml"),
      'name = "api"\nmain = "src/index.js"\n\n[assets]\ndirectory = "./public"\n');

    const stderrLines = [];
    const fetchCalls = [];
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: (line) => stderrLines.push(line),
      execFile: fakeWranglerExecFile,
      controlFetch: async (url, init = {}) => {
        fetchCalls.push({ url, init });
        if (fetchCalls.length === 1) return response({ version: "v1", warnings: [] });
        return response({ platformDomain: "wdl.sh" });
      },
    });

    const note = stderrLines.find((line) => line.startsWith("note: assets: skipped"));
    assert.ok(note, `expected a skipped-assets note, got ${JSON.stringify(stderrLines)}`);
    assert.match(note, /skipped 1 ignored entry \(node_modules\/; a trailing \/ is a whole subtree\)/);
    const manifest = JSON.parse(fetchCalls[0].init.body);
    assert.deepEqual(Object.keys(manifest.assets), ["index.html"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand escapes a control-supplied version before printing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-version-escape-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "api"\nmain = "src/index.js"\n');

    const stdoutLines = [];
    let fetchCount = 0;
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (line) => stdoutLines.push(line),
      stderr: () => {},
      execFile: fakeWranglerExecFile,
      controlFetch: async () => {
        fetchCount += 1;
        if (fetchCount === 1) return response({ version: "v1\u001b[2J", warnings: [] });
        return response({ platformDomain: "wdl.sh" });
      },
    });

    const out = stdoutLines.join("\n");
    assert.ok(!out.includes("\u001b"), "raw ESC byte must not reach stdout");
    assert.ok(out.includes("promoting v1\\u001b[2J"));
    assert.ok(out.includes("@v1\\u001b[2J live"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects a KV binding name that isn't a JS identifier", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-kv-name-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"),
      'name = "api"\nmain = "src/index.js"\n\n[[kv_namespaces]]\nbinding = "bad-kv"\nid = "x"\n');
    let execCalled = false;
    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: () => { execCalled = true; },
        controlFetch: async () => response({}),
      }),
      /\[\[kv_namespaces\]\] bad-kv: binding must match/
    );
    assert.equal(execCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
