import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
  collectRoutes,
  formatWranglerConfigShadowWarning,
  installTempFileCleanup,
  loadWranglerConfig,
  MAX_ASSET_FILE_BYTES,
  parseD1DatabasesFromCfg,
  parseDurableObjectsFromCfg,
  parseExportsFromCfg,
  parseJsonc,
  parseKvNamespacesFromCfg,
  packWranglerProject,
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
  validateUnsupportedWranglerConfig,
  wranglerChildEnv,
} from "../../lib/wrangler-pack.js";
import { LONG_CONTROL_TIMEOUT_MS } from "../../lib/control-fetch.js";
import { checkWranglerVersion, formatWranglerFailure } from "../../lib/wrangler/command.js";
import { ESC, assertNoRawTerminalControls, response } from "./helpers.js";

/**
 * @param {() => unknown} fn
 * @param {RegExp} expected
 * @param {string} target
 */
function assertThrowsNoRawTerminalControls(fn, expected, target) {
  assert.throws(
    fn,
    (err) => {
      const message = /** @type {Error} */ (err).message;
      assertNoRawTerminalControls(message, target);
      assert.match(message, expected);
      return true;
    }
  );
}

/**
 * The options bag the deploy pipeline passes to its injected execFile dep. The
 * fakes record whichever subset each test asserts on; every field the deploy
 * pipeline sets is present, so reads here are unconditional.
 * @typedef {object} ExecFileOpts
 * @property {string} [cwd]
 * @property {"inherit" | readonly ("ignore" | "pipe")[]} [stdio]
 * @property {string} [encoding]
 * @property {number} [maxBuffer]
 * @property {NodeJS.ProcessEnv} env
 */

/**
 * A recorded execFile invocation captured by a fake.
 * @typedef {object} RecordedExec
 * @property {string} cmd
 * @property {readonly string[]} args
 * @property {ExecFileOpts} opts
 */

/**
 * A recorded controlFetch invocation captured by a fake.
 * @typedef {object} RecordedFetch
 * @property {string} url
 * @property {import("../../lib/control-fetch.js").ControlFetchInit} init
 */

// Shared happy-path execFile stub: answers the version probe and writes the
// bundled entry the deploy pipeline expects in --outdir.
/**
 * @param {string} _cmd
 * @param {readonly string[]} args
 */
function fakeWranglerExecFile(_cmd, args) {
  if (args.includes("--version")) return "wrangler 4.94.0";
  const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice("--outdir=".length);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "index.js"), "export default {}");
}

/**
 * @param {unknown} body
 * @param {number} [status]
 * @returns {Promise<Error>}
 */
async function rejectDeployWithControlBody(body, status = 400) {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-control-error-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "api"\nmain = "src/index.js"\n');
    /** @type {unknown} */
    let rejected;
    try {
      await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: fakeWranglerExecFile,
        controlFetch: async () => response(body, status),
      });
    } catch (err) {
      rejected = err;
    }
    assert(rejected instanceof Error);
    return rejected;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string} cmd
 */
function assertWranglerCommand(cmd) {
  assert.ok(
    cmd === "wrangler" ||
      cmd === process.execPath ||
      path.basename(cmd) === (process.platform === "win32" ? "wrangler.cmd" : "wrangler"),
    `expected wrangler command, got ${cmd}`
  );
}

/**
 * @param {{ cmd: string, args: readonly string[] }} call
 */
function assertWranglerVersionProbe(call) {
  assertWranglerCommand(call.cmd);
  if (call.cmd === process.execPath) {
    assert.match(call.args[0] || "", /wrangler[\\/]bin[\\/]wrangler\.js$/);
    assert.deepEqual(call.args.slice(1), ["--version"]);
    return;
  }
  assert.deepEqual(call.args, ["--version"]);
}

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

test("parseJsonc matches Wrangler handling of BOM and CR-only comments", () => {
  const cfg = parseJsonc('\ufeff{\r// comment\r"name": "demo",\r}\r');
  assert.deepEqual(cfg, { name: "demo" });
});

test("parseJsonc rejects comments that splice JSON tokens", () => {
  assert.throws(() => parseJsonc('{"value": 1/* comment */2}'), /CommaExpected/);
});

test("parseJsonc rejects unterminated block comments", () => {
  assert.throws(() => parseJsonc('{"name": "demo"} /*'), /UnexpectedEndOfComment/);
});

test("parseJsonc preserves reserved keys without changing object prototypes", () => {
  const cfg = parseJsonc('{"__proto__": {"polluted": true}, "name": "demo"}');
  assert.ok(cfg && typeof cfg === "object" && !Array.isArray(cfg));
  assert.equal(Object.getPrototypeOf(cfg), Object.prototype);
  assert.equal(Object.hasOwn(cfg, "__proto__"), true);
  assert.equal(/** @type {Record<string, unknown>} */ (cfg).polluted, undefined);
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

test("parseQueues: forwards platform-range batch timeouts for control-side validation", () => {
  assert.deepEqual(
    parseQueues({ consumers: [{ queue: "orders", max_batch_timeout: 61 }] }).consumers,
    [{ queue: "orders", maxBatchTimeoutMs: 61_000 }]
  );
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

test("collectRoutes: accepts strings and { pattern } tables, rejects non-arrays", () => {
  assert.deepEqual(collectRoutes({}, "wrangler.toml"), []);
  assert.deepEqual(collectRoutes({ route: "dev.example.com/*" }, "wrangler.toml"), ["dev.example.com/*"]);
  assert.deepEqual(
    collectRoutes({ routes: ["a.example.com/*", { pattern: "b.example.com/*" }] }, "wrangler.toml"),
    ["a.example.com/*", "b.example.com/*"]
  );
  // A non-array `routes` must fail fast, not be silently dropped.
  assert.throws(
    () => collectRoutes({ routes: "a.example.com/*" }, "wrangler.toml"),
    /"routes" must be an array/
  );
  assert.throws(
    () => collectRoutes({ routes: { pattern: "a.example.com/*" } }, "wrangler.toml"),
    /"routes" must be an array/
  );
  assert.throws(
    () => collectRoutes({ route: "a", routes: ["b"] }, "wrangler.toml"),
    /specify either "route" or "routes"/
  );
  assertThrowsNoRawTerminalControls(
    () => collectRoutes({ route: "a", routes: ["b"] }, `wrangler${ESC}[2J\nFORGED\rBAD.toml`),
    /specify either "route" or "routes"/,
    "route config label"
  );
  assert.throws(
    () => collectRoutes({ routes: [{ bad: `x${ESC}[2J\nFORGED\rBAD` }] }, "wrangler.toml"),
    (err) => {
      const message = /** @type {Error} */ (err).message;
      assert.match(message, /unsupported routes entry/);
      assertNoRawTerminalControls(message, "route errors");
      return true;
    }
  );
});

test("parseKvNamespacesFromCfg: validates shape and non-empty string binding/id", () => {
  assert.deepEqual(parseKvNamespacesFromCfg({}), []);
  assert.deepEqual(parseKvNamespacesFromCfg({ kv_namespaces: [] }), []);
  assert.deepEqual(
    parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "KV", id: "abc" }] }),
    [{ binding: "KV", id: "abc" }]
  );
  assert.deepEqual(
    // KV ids are control-plane resource ids, not runtime binding names; keep
    // the long-standing whitespace trim explicit and intentional.
    parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "KV", id: "abc " }] }),
    [{ binding: "KV", id: "abc" }]
  );
  assert.throws(() => parseKvNamespacesFromCfg({ kv_namespaces: {} }), /must be an array/);
  assert.throws(() => parseKvNamespacesFromCfg({ kv_namespaces: [null] }), /entry must be a table/);
  assert.throws(() => parseKvNamespacesFromCfg({ kv_namespaces: [{ id: "x" }] }), /needs a non-empty string 'binding'/);
  assert.throws(() => parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "", id: "x" }] }), /needs a non-empty string 'binding'/);
  assert.throws(() => parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: ["KV"], id: "x" }] }), /needs a non-empty string 'binding'/);
  assert.throws(() => parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "KV" }] }), /'id' must be a non-empty string/);
  assert.throws(() => parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "KV", id: 123 }] }), /'id' must be a non-empty string/);
  // binding name grammar still enforced
  assert.throws(() => parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "bad-kv", id: "x" }] }), /binding must match/);
  // unknown keys (typos) are rejected, like the d1/r2 parsers
  assert.throws(
    () => parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "KV", id: "x", bindng: "typo" }] }),
    /unknown field\(s\): bindng/
  );
  // Wrangler's local-dev keys (preview_id, remote) are allowed but ignored
  assert.deepEqual(
    parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "KV", id: "x", preview_id: "p" }] }),
    [{ binding: "KV", id: "x" }]
  );
  assert.deepEqual(
    parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "KV", id: "x", remote: true }] }),
    [{ binding: "KV", id: "x" }]
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
  // A present-but-empty value gets the specific non-empty-string error, not "needs both".
  assert.throws(
    () => parseServicesFromCfg({ services: [{ binding: "", service: "y" }] }),
    /binding must be a non-empty string/
  );
  assert.throws(
    () => parseServicesFromCfg({ services: [{ binding: "X", service: "" }] }),
    /service must be a non-empty string/
  );
  // A non-string truthy `service` must be rejected, not passed into the manifest.
  assert.throws(
    () => parseServicesFromCfg({ services: [{ binding: "X", service: 123 }] }),
    /service must be a non-empty string/
  );
  // A non-string `binding` (truthy array) must not be String()-coerced past the
  // binding-name regex.
  assert.throws(
    () => parseServicesFromCfg({ services: [{ binding: ["AB"], service: "y" }] }),
    /binding must be a non-empty string/
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

test("wrangler binding parser diagnostics escape terminal controls", () => {
  const bad = `bad${ESC}[2J\nFORGED\rBAD`;
  const badConfigRel = `wrangler${ESC}[2J\nFORGED\rBAD.json`;
  assertThrowsNoRawTerminalControls(
    () => parseQueues({ consumers: [{ queue: "jobs", max_concurrency: 4 }] }, badConfigRel),
    /wrangler\\u001b\[2J\\nFORGED\\rBAD\.json/,
    "config path diagnostics"
  );
  assertThrowsNoRawTerminalControls(
    () => parseQueues({ consumers: [{ queue: bad, max_concurrency: 4 }] }),
    /max_concurrency not supported/,
    "queue diagnostics"
  );
  assertThrowsNoRawTerminalControls(
    () => parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "KV", id: "x", [bad]: true }] }),
    /unknown field\(s\): bad\\u001b\[2J\\nFORGED\\rBAD/,
    "KV diagnostics"
  );
  assertThrowsNoRawTerminalControls(
    () => parseServicesFromCfg({ services: [{ binding: bad, service: 123 }] }),
    /service must be a non-empty string/,
    "service diagnostics"
  );
  assertThrowsNoRawTerminalControls(
    () => parseDurableObjectsFromCfg({
      durable_objects: { bindings: [{ name: bad, class_name: "Room", script_name: "other" }] },
      migrations: [{ tag: "v1", new_classes: ["Room"] }],
    }),
    /script_name is not supported/,
    "Durable Object diagnostics"
  );
  assertThrowsNoRawTerminalControls(
    () => parseWorkflowsFromCfg({ workflows: [{ name: bad, binding: "WF", class_name: "Flow", script_name: "other" }] }),
    /script_name is not supported/,
    "workflow diagnostics"
  );
  assertThrowsNoRawTerminalControls(
    () => parseExportsFromCfg({ exports: [{ entrypoint: "Public", allowed_callers: [bad] }] }),
    /allowed_callers entries must be/,
    "export diagnostics"
  );
  assertThrowsNoRawTerminalControls(
    () => parsePlatformBindingsFromCfg({ platform_bindings: [{ binding: "PAYMENT", platform: bad }] }),
    /platform must match/,
    "platform binding diagnostics"
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
  const bad = `evil${ESC}[2J\nFORGED\rBAD.js`;
  try {
    mkdirSync(outdir, { recursive: true });
    writeFileSync(outside, "leak");
    symlinkSync(outside, path.join(outdir, bad));
    assert.throws(
      () => collectModules(outdir),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assertNoRawTerminalControls(message, "module symlink diagnostics");
        assert.match(message, /evil\\u001b\[2J\\nFORGED\\rBAD\.js/);
        return true;
      }
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("collectModules: rejects Python Workers modules before upload", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-collect-py-"));
  try {
    writeFileSync(path.join(dir, "index.py"), "export default {}");
    assert.throws(
      () => collectModules(dir),
      /Python Workers modules are not supported by WDL \(index\.py\)/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
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

test("collectAssets reports invalid .assetsignore patterns with context", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assetsignore-invalid-"));
  try {
    writeFileSync(path.join(dir, ".assetsignore"), "bad[z-a]\n");
    assert.throws(() => collectAssets(dir), /invalid \.assetsignore pattern "bad\[z-a\]"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets escapes terminal controls in asset diagnostics", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-diagnostic-escape-"));
  const bad = `bad${ESC}[2J\nFORGED\rBAD`;
  const badPattern = `bad${ESC}[2J\u009b\rBAD`;
  try {
    writeFileSync(path.join(dir, ".assetsignore"), `${badPattern}[z-a]\n`);
    assert.throws(
      () => collectAssets(dir),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assertNoRawTerminalControls(message, "asset ignore diagnostics");
        assert.match(message, /bad\\u001b\[2J\\u009b\\rBAD/);
        return true;
      }
    );

    writeFileSync(path.join(dir, ".assetsignore"), "");
    writeFileSync(path.join(dir, "real.txt"), "x");
    symlinkSync(path.join(dir, "real.txt"), path.join(dir, bad));
    assert.throws(
      () => collectAssets(dir),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assertNoRawTerminalControls(message, "asset path diagnostics");
        assert.match(message, /bad\\u001b\[2J\\nFORGED\\rBAD/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets wraps native filesystem errors with escaped asset paths", { skip: process.platform === "win32" }, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-fs-escape-"));
  const bad = `blocked${ESC}[2J\nFORGED\rBAD.txt`;
  const file = path.join(dir, bad);
  try {
    writeFileSync(file, "secret");
    chmodSync(file, 0);
    assert.throws(
      () => collectAssets(dir),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assertNoRawTerminalControls(message, "asset filesystem diagnostics");
        assert.match(message, /failed to read/);
        assert.match(message, /blocked\\u001b\[2J\\nFORGED\\rBAD\.txt/);
        return true;
      }
    );
  } finally {
    if (existsSync(file)) chmodSync(file, 0o600);
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
    /** @type {string[]} */
    const skipped = [];
    collectAssets(dir, { onIgnore: (/** @type {string} */ relPath, /** @type {boolean} */ isDir) => skipped.push(isDir ? `${relPath}/` : relPath) });
    assert.deepEqual(skipped.toSorted(), ["app.js.map", "node_modules/"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAssetsDir: rejects a missing, empty, or non-string assets.directory", () => {
  const project = mkdtempSync(path.join(tmpdir(), "wdl-assets-dir-type-"));
  try {
    for (const bad of ["", "   ", 123, true, ["public"], { directory: "public" }, null, undefined]) {
      assert.throws(
        () => resolveAssetsDir(project, bad),
        /assets\.directory must be a non-empty string/
      );
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("resolveAssetsDir: escapes terminal controls in diagnostics", () => {
  const project = mkdtempSync(path.join(tmpdir(), "wdl-assets-dir-escape-"));
  const bad = `missing${ESC}[2J\nFORGED\rBAD`;
  const badConfigRel = `wrangler${ESC}[2J\nFORGED\rBAD.json`;
  try {
    assert.throws(
      () => resolveAssetsDir(project, bad, badConfigRel),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assertNoRawTerminalControls(message, "assets.directory diagnostics");
        assert.match(message, /wrangler\\u001b\[2J\\nFORGED\\rBAD\.json/);
        assert.match(message, /missing\\u001b\[2J\\nFORGED\\rBAD/);
        return true;
      }
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
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

test("loadWranglerConfig: prefers wrangler.json when multiple config files exist", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-config-"));
  try {
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "toml-demo"\nmain = "src/index.js"\n');
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({
      name: "json-demo",
      main: "src/index.js",
    }));
    writeFileSync(
      path.join(dir, "wrangler.jsonc"),
      '{ "name": "jsonc-demo", "main": "src/index.js" }'
    );

    const loaded = loadWranglerConfig(dir);
    const cfg = /** @type {{ name?: string, main?: string }} */ (loaded.cfg);
    assert.equal(loaded.path, path.join(dir, "wrangler.json"));
    assert.equal(cfg.name, "json-demo");
    assert.deepEqual(loaded.shadowed, ["wrangler.jsonc", "wrangler.toml"]);
    assert.equal(
      formatWranglerConfigShadowWarning(loaded),
      "multiple Wrangler config files found; using wrangler.json and ignoring wrangler.jsonc, wrangler.toml"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadWranglerConfig: parses JSONC syntax in JSON config formats", () => {
  for (const name of ["wrangler.json", "wrangler.jsonc"]) {
    const dir = mkdtempSync(path.join(tmpdir(), "wdl-config-jsonc-"));
    try {
      writeFileSync(
        path.join(dir, name),
        `{
          // comment
          "name": "jsonc-demo",
          "main": "src/index.js",
        }`
      );

      const loaded = loadWranglerConfig(dir);
      const cfg = /** @type {{ name?: string, main?: string }} */ (loaded.cfg);
      assert.equal(loaded.path, path.join(dir, name));
      assert.equal(cfg.name, "jsonc-demo");
      assert.equal(cfg.main, "src/index.js");
      assert.deepEqual(loaded.shadowed, []);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test("loadWranglerConfig: rejects invalid JSONC in JSON config formats", () => {
  const invalidCases = [
    ['{"value": 1/* comment */2}', "CommaExpected"],
    ['{"name": "demo"} /*', "UnexpectedEndOfComment"],
  ];
  for (const name of ["wrangler.json", "wrangler.jsonc"]) {
    for (const [source, expected] of invalidCases) {
      const dir = mkdtempSync(path.join(tmpdir(), "wdl-config-jsonc-invalid-"));
      try {
        writeFileSync(path.join(dir, name), source);
        assert.throws(
          () => loadWranglerConfig(dir),
          new RegExp(`failed to parse ${name.replace(".", "\\.")}: ${expected}`)
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }
});

test("loadWranglerConfig: escapes parser diagnostics from config files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-config-bad-"));
  try {
    writeFileSync(path.join(dir, "wrangler.toml"), `name = "bad${ESC}[2J\nFORGED\rBAD"\nmain =\n`);
    assert.throws(
      () => loadWranglerConfig(dir),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assert.match(message, /failed to parse wrangler\.toml/);
        assertNoRawTerminalControls(message, "config parse errors");
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadWranglerConfig: escapes config read errors", () => {
  const root = mkdtempSync(path.join(tmpdir(), "wdl-config-read-"));
  const dir = path.join(root, `bad${ESC}[2J\nFORGED\rBAD`);
  try {
    mkdirSync(dir);
    mkdirSync(path.join(dir, "wrangler.json"));
    assert.throws(
      () => loadWranglerConfig(dir),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assert.match(message, /failed to read wrangler\.json/);
        assertNoRawTerminalControls(message, "config read errors");
        return true;
      }
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("installTempFileCleanup removes temp files on process exit and signals", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-temp-cleanup-"));
  try {
    const processLike = /** @type {EventEmitter & { off(event: string, listener: () => void): EventEmitter }} */ (new EventEmitter());
    /** @type {string[]} */
    const terminated = [];
    const sigintFile = path.join(dir, "sigint.json");
    writeFileSync(sigintFile, "{}");
    installTempFileCleanup(sigintFile, processLike, (signal) => terminated.push(signal));
    processLike.emit("SIGINT");
    assert.equal(existsSync(sigintFile), false);
    assert.deepEqual(terminated, ["SIGINT"]);

    const exitFile = path.join(dir, "exit.json");
    writeFileSync(exitFile, "{}");
    const cleanup = installTempFileCleanup(exitFile, processLike, (signal) => terminated.push(signal));
    processLike.emit("exit");
    assert.equal(existsSync(exitFile), false);
    cleanup();
    assert.deepEqual(terminated, ["SIGINT"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("installTempFileCleanup only swallows cleanup errors when explicitly requested or during process handlers", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-temp-cleanup-error-"));
  try {
    const exitProcess = /** @type {EventEmitter & { off(event: string, listener: () => void): EventEmitter }} */ (new EventEmitter());
    installTempFileCleanup(dir, exitProcess);
    assert.doesNotThrow(() => exitProcess.emit("exit"));

    const cleanupProcess = /** @type {EventEmitter & { off(event: string, listener: () => void): EventEmitter }} */ (new EventEmitter());
    const cleanup = installTempFileCleanup(dir, cleanupProcess);
    assert.throws(() => cleanup(), /EISDIR|directory/i);
    assert.doesNotThrow(() => cleanup({ ignoreErrors: true }));
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
    compatibility_date: "2026-06-17",
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
  assert.equal(cfg.compatibility_date, "2026-06-17");
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

test("resolveWranglerConfig: selected environment can override durable object migrations", () => {
  const { cfg } = resolveWranglerConfig({
    name: "demo",
    main: "src/index.js",
    migrations: [{ tag: "v1", new_classes: ["TopObject"] }],
    env: {
      prod: {
        migrations: [{ tag: "v2", new_sqlite_classes: ["ProdObject"] }],
      },
    },
  }, "prod", "wrangler.jsonc");

  assert.deepEqual(cfg.migrations, [{ tag: "v2", new_sqlite_classes: ["ProdObject"] }]);
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
          keep_vars: true,
        },
      },
    }, "staging", "wrangler.toml"),
    /env\.staging\.keep_vars is top-level only/
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
  assert.equal(/** @type {Record<string, unknown>} */ (cfg).polluted, undefined);
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
    /unsupported Wrangler field "analytics_engine_datasets"/
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
    /env\.staging uses unsupported Wrangler field "analytics_engine_datasets"/
  );
});

test("validateUnsupportedWranglerConfig: top-level allowed_callers is rejected with the [[exports]] migration path", () => {
  assert.throws(
    () => validateUnsupportedWranglerConfig({
      name: "demo",
      main: "src/index.js",
      allowed_callers: ["acme"],
    }, null, "wrangler.toml"),
    /top-level allowed_callers — removed.*\[\[exports\]\]/
  );
});

test("validateUnsupportedWranglerConfig: empty top-level allowed_callers is still rejected by presence", () => {
  for (const value of [[], null, false, ""]) {
    assert.throws(
      () => validateUnsupportedWranglerConfig({
        name: "demo",
        main: "src/index.js",
        allowed_callers: value,
      }, null, "wrangler.toml"),
      /top-level allowed_callers — removed/
    );
  }
});

test("validateUnsupportedWranglerConfig: env-scoped allowed_callers is rejected too", () => {
  assert.throws(
    () => validateUnsupportedWranglerConfig({
      name: "demo",
      main: "src/index.js",
      env: { staging: { allowed_callers: ["acme"] } },
    }, "staging", "wrangler.toml"),
    /env\.staging uses top-level allowed_callers — removed/
  );
});

test("validateUnsupportedWranglerConfig: empty env-scoped allowed_callers is still rejected by presence", () => {
  for (const value of [[], null, false, ""]) {
    assert.throws(
      () => validateUnsupportedWranglerConfig({
        name: "demo",
        main: "src/index.js",
        env: { staging: { allowed_callers: value } },
      }, "staging", "wrangler.toml"),
      /env\.staging uses top-level allowed_callers — removed/
    );
  }
});

test("validateUnsupportedWranglerConfig rejects unmapped wrangler runtime/deploy keys", () => {
  const objectShapeKeys = new Set([
    "ai",
    "browser",
    "cache",
    "limits",
    "observability",
    "placement",
    "previews",
    "python_modules",
    "site",
    "unsafe_hello_world",
  ]);
  const booleanShapeKeys = new Set([
    "first_party_worker",
    "legacy_env",
    "preview_urls",
    "upload_source_maps",
    "workers_dev",
  ]);
  for (const key of [
    "agent_memory",
    "ai",
    "artifacts",
    "browser",
    "cache",
    "cloudchamber",
    "compliance_region",
    "hyperdrive",
    "first_party_worker",
    "flagship",
    "legacy_env",
    "limits",
    "logpush",
    "media",
    "mtls_certificates",
    "observability",
    "pages_build_output_dir",
    "placement",
    "preview_urls",
    "previews",
    "ratelimits",
    "python_modules",
    "site",
    "stream",
    "streaming_tail_consumers",
    "unsafe_hello_world",
    "upload_source_maps",
    "vectorize",
    "vpc_networks",
    "vpc_services",
    "websearch",
    "worker_loaders",
    "workers_dev",
  ]) {
    assert.throws(
      () => validateUnsupportedWranglerConfig({
        name: "demo",
        main: "src/index.js",
        [key]: unsupportedWranglerFixtureValue(key, objectShapeKeys, booleanShapeKeys),
      }, null, "wrangler.toml"),
      new RegExp(`unsupported Wrangler field "${key}"`)
    );
  }

  assert.throws(
    () => validateUnsupportedWranglerConfig({
      name: "demo",
      main: "src/index.js",
      workers_dev: false,
    }, null, "wrangler.toml"),
    /unsupported Wrangler field "workers_dev"/
  );

  assert.throws(
    () => validateUnsupportedWranglerConfig({
      name: "demo",
      main: "src/index.js",
      vectorize: [],
    }, null, "wrangler.toml"),
    /unsupported Wrangler field "vectorize"/
  );

  assert.throws(
    () => validateUnsupportedWranglerConfig({
      name: "demo",
      main: "src/index.js",
      env: {
        staging: {
          preview_urls: false,
        },
      },
    }, "staging", "wrangler.toml"),
    /env\.staging uses unsupported Wrangler field "preview_urls"/
  );

  // The rejection lists the actual supported surface.
  try {
    validateUnsupportedWranglerConfig(
      { name: "demo", main: "src/index.js", vectorize: [{ binding: "V" }] },
      null,
      "wrangler.toml"
    );
    assert.fail("expected vectorize rejection");
  } catch (err) {
    const { message } = /** @type {Error} */ (err);
    assert.match(message, /\[\[queues\.producers\]\]/);
    assert.match(message, /\[\[platform_bindings\]\]/);
    assert.match(message, /\[triggers\]/);
  }
});

/**
 * @param {string} key
 * @param {Set<string>} objectShapeKeys
 * @param {Set<string>} booleanShapeKeys
 * @returns {unknown}
 */
function unsupportedWranglerFixtureValue(key, objectShapeKeys, booleanShapeKeys) {
  if (objectShapeKeys.has(key)) return { binding: "B" };
  if (booleanShapeKeys.has(key)) return true;
  if (key === "compliance_region") return "eu";
  if (key === "pages_build_output_dir") return "dist";
  return [{ binding: "B" }];
}

test("validateUnsupportedWranglerConfig rejects module-binding and container sections", () => {
  assert.throws(
    () => validateUnsupportedWranglerConfig(
      { name: "demo", main: "src/index.js", wasm_modules: { MOD: "./m.wasm" } },
      null,
      "wrangler.toml"
    ),
    /unsupported Wrangler field "wasm_modules"/
  );
  assert.throws(
    () => validateUnsupportedWranglerConfig(
      { name: "demo", main: "src/index.js", containers: [{ class_name: "C" }] },
      null,
      "wrangler.toml"
    ),
    /unsupported Wrangler field "containers"/
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

test("checkWranglerVersion escapes unparsable version diagnostics", () => {
  const execFile = /** @type {typeof import("node:child_process").execFileSync} */ (
    /** @type {unknown} */ (() => `bad\u009b31m\nFORGED\rBAD`)
  );
  assertThrowsNoRawTerminalControls(
    () => checkWranglerVersion({
      execFile,
      cwd: "/tmp/project",
      env: {},
      wrangler: { command: "wrangler", args: [] },
    }),
    /could not parse version/,
    "wrangler version parse"
  );
});

test("checkWranglerVersion escapes failed version probe diagnostics", () => {
  const execFile = /** @type {typeof import("node:child_process").execFileSync} */ (
    /** @type {unknown} */ (() => {
      const err = new Error(`boom${ESC}[2J\nFORGED\rBAD\u009b`);
      Object.assign(err, {
        stdout: `out${ESC}[2J\nline\rBAD`,
        stderr: "err\u009b31m",
      });
      throw err;
    })
  );
  assert.throws(
    () => checkWranglerVersion({
      execFile,
      cwd: "/tmp/project",
      env: {},
      wrangler: { command: "wrangler", args: [] },
    }),
    (err) => {
      const message = /** @type {Error} */ (err).message;
      assertNoRawTerminalControls(message, "wrangler version failure");
      assert.match(message, /boom\\u001b\[2J\\nFORGED\\rBAD\\u009b/);
      assert.match(message, /out\\u001b\[2J\nline\\rBAD\nerr\\u009b31m/);
      return true;
    }
  );
});

test("checkWranglerVersion ENOENT hint mentions the npx opt-in", () => {
  const execFile = /** @type {typeof import("node:child_process").execFileSync} */ (
    /** @type {unknown} */ (() => {
      const err = new Error("spawn wrangler ENOENT");
      Object.assign(err, { code: "ENOENT" });
      throw err;
    })
  );
  assert.throws(
    () => checkWranglerVersion({
      execFile,
      cwd: "/tmp/project",
      env: {},
      wrangler: { command: "wrangler", args: [] },
    }),
    /WDL_ALLOW_NPX_WRANGLER=1/
  );
});

test("formatWranglerFailure escapes captured dry-run diagnostics", () => {
  const message = formatWranglerFailure(Object.assign(new Error(`boom${ESC}[2J\nFORGED\rBAD\u009b`), {
    stdout: `out${ESC}[2J\nline\rBAD`,
    stderr: "err\u009b31m",
  }));
  assertNoRawTerminalControls(message, "wrangler build failure");
  assert.match(message, /boom\\u001b\[2J\\nFORGED\\rBAD\\u009b/);
  assert.match(message, /out\\u001b\[2J\nline\\rBAD\nerr\\u009b31m/);
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
      { command: bin, args: [], source: "project" }
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

test("resolveWranglerCommand labels the CLI package wrangler as package", () => {
  const resolved = resolveWranglerCommand({
    absProject: "/project",
    env: { PATH: "" },
  });
  assert.equal(resolved.source, "package");
  assert.ok(
    resolved.command.includes("node") || resolved.command.includes("wrangler"),
    "package resolver should return a runnable wrangler command"
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
      { command: packageBin, args: [], source: "package" }
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
      { command: process.execPath, args: [script], source: "project" }
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
        'compatibility_date = "2026-06-17"',
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

    /** @type {RecordedExec[]} */
    const execCalls = [];
    /** @type {RecordedFetch[]} */
    const fetchCalls = [];
    /** @type {string[]} */
    const lines = [];
    await runDeployCommand(
      ["sub", "--control-url", "http://ctl.test"],
      {
        env: {
          ADMIN_TOKEN: "tok",
          CONTROL_CONNECT_HOST: "127.0.0.1:18080",
          WDL_NS: "demo space",
          CLOUDFLARE_API_TOKEN: "real-cf-token",
        },
        cwd: parent,
        stdout: (/** @type {string} */ line) => lines.push(/** @type {string} */ line),
        stderr: () => {},
        execFile: (/** @type {string} */ cmd, /** @type {readonly string[]} */ args, /** @type {ExecFileOpts} */ opts) => {
          execCalls.push({ cmd, args, opts });
          if (args.includes("--version")) return "wrangler 4.94.0";
          const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice("--outdir=".length);
          mkdirSync(outDir, { recursive: true });
          writeFileSync(
            path.join(outDir, "index.js"),
            'export default { fetch() { return new Response("ok"); } };'
          );
        },
        controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
          fetchCalls.push({ url, init });
          if (fetchCalls.length === 1) {
            return response({ version: "v1", warnings: [] });
          }
          return response({ platformDomain: "workers.example" });
        },
      }
    );

    assert.equal(execCalls.length, 2);
    assertWranglerVersionProbe(execCalls[0]);
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
    assert.equal(fetchCalls[0].init.env?.CONTROL_CONNECT_HOST, "127.0.0.1:18080");
    assert.deepEqual(fetchCalls[0].init.headers, {
      "content-type": "application/json",
      "x-admin-token": "tok",
    });
    const manifest = JSON.parse(/** @type {string} */ (fetchCalls[0].init.body));
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
    assert.equal(manifest.compatibilityDate, "2026-06-17");

    assert.equal(fetchCalls[1].url, "http://ctl.test/ns/demo%20space/worker/api/promote");
    assert.equal(fetchCalls[1].init.method, "POST");
    assert.equal(fetchCalls[1].init.env?.CONTROL_CONNECT_HOST, "127.0.0.1:18080");
    assert.deepEqual(JSON.parse(/** @type {string} */ (fetchCalls[1].init.body)), { version: "v1" });
    assert.ok(lines.includes("  bundled by wrangler"));
    assert.ok(lines.includes("✓ demo space/api@v1 live"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects unexpected positional arguments", async () => {
  await assert.rejects(
    () => runDeployCommand([".", "extra", "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      execFile: () => {
        throw new Error("execFile should not be called");
      },
    }),
    /deploy received unexpected argument: extra/
  );
});

test("runDeployCommand escapes terminal controls in unexpected positional errors", async () => {
  const bad = `bad${ESC}[2J\nFORGED\rBAD`;
  await assert.rejects(
    () => runDeployCommand([".", bad, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      execFile: () => {
        throw new Error("execFile should not be called");
      },
    }),
    (err) => {
      const message = /** @type {Error} */ (err).message;
      assertNoRawTerminalControls(message, "deploy positional errors");
      assert.match(message, /bad\\u001b\[2J\\nFORGED\\rBAD/);
      return true;
    },
  );
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
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "old"\nmain = "old.js"\n');

    let tmpConfigSeen = null;
    let tmpConfigContentAtExec = /** @type {{ name?: string, main?: string, vars?: unknown } | null} */ (null);
    /** @type {RecordedFetch[]} */
    const fetchCalls = [];
    /** @type {string[]} */
    const warnings = [];
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: (/** @type {string} */ line) => warnings.push(line),
      execFile: (/** @type {string} */ _cmd, /** @type {readonly string[]} */ args) => {
        if (args.includes("--version")) return "wrangler 4.94.0";
        const cfgIdx = args.indexOf("--config");
        assert.notEqual(cfgIdx, -1, "wrangler bundle args must include --config");
        tmpConfigSeen = args[cfgIdx + 1];
        assert.ok(existsSync(tmpConfigSeen), "temp config must exist when wrangler runs");
        tmpConfigContentAtExec = JSON.parse(readFileSync(tmpConfigSeen, "utf8"));
        const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice("--outdir=".length);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, "index.js"), "export default {}");
      },
      controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
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
    assert.ok(warnings.some((line) => /using wrangler\.json and ignoring wrangler\.toml/.test(line)));
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
        execFile: (/** @type {string} */ _cmd, /** @type {readonly string[]} */ args) => {
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

test("runDeployCommand does not mask a wrangler failure when temp config cleanup fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-cleanup-mask-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({
      name: "api",
      main: "src/index.js",
    }));

    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: (/** @type {string} */ _cmd, /** @type {readonly string[]} */ args) => {
          if (args.includes("--version")) return "wrangler 4.94.0";
          const cfgIdx = args.indexOf("--config");
          rmSync(/** @type {string} */ (args[cfgIdx + 1]), { force: true });
          mkdirSync(/** @type {string} */ (args[cfgIdx + 1]));
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

    /** @type {RecordedFetch[]} */
    const fetchCalls = [];
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: () => {},
      execFile: fakeWranglerExecFile,
      controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
        fetchCalls.push({ url, init });
        if (fetchCalls.length === 1) return response({ version: "v1", warnings: [] });
        return response({ platformDomain: "workers.example" });
      },
    });

    const manifest = JSON.parse(/** @type {string} */ (fetchCalls[0].init.body));
    assert.equal(Object.hasOwn(manifest.bindings, "__proto__"), true);
    assert.deepEqual(manifest.bindings["__proto__"], { type: "kv", id: "kv-id" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects a non-table [assets] before bundling", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-assets-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({
      name: "api",
      main: "src/index.js",
      assets: "public",
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
      { message: "wrangler.json: [assets] must be a table" }
    );
    assert.equal(execCalled, false);
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

test("runDeployCommand prints a direct http URL for a local deploy", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-localurl-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), 'export default { fetch() { return new Response("ok"); } };');
    writeFileSync(path.join(dir, "wrangler.toml"), ['name = "api"', 'main = "src/index.js"', 'compatibility_date = "2026-06-17"'].join("\n"));

    /** @type {string[]} */
    const lines = [];
    let fetchCount = 0;
    await runDeployCommand(
      [dir, "--ns", "demo", "--control-url", "http://localhost:8080"],
      {
        env: { ADMIN_TOKEN: "tok" },
        stdout: (/** @type {string} */ line) => lines.push(/** @type {string} */ line),
        stderr: () => {},
        execFile: (/** @type {string} */ _cmd, /** @type {readonly string[]} */ args) => {
          if (args.includes("--version")) return "wrangler 4.94.0";
          const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice("--outdir=".length);
          mkdirSync(outDir, { recursive: true });
          writeFileSync(path.join(outDir, "index.js"), 'export default { fetch() { return new Response("ok"); } };');
        },
        controlFetch: async () => {
          fetchCount += 1;
          return fetchCount === 1
            ? response({ version: "v1", warnings: [] })
            : response({ platformDomain: "workers.local" });
        },
      }
    );

    assert.ok(lines.includes("  http://demo.workers.local:8080/api/"), "local deploy prints a direct http URL with the gateway port");
    assert.equal(lines.some((line) => line.includes("curl -H")), false, "no curl hint");
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

    /** @type {string[]} */
    const lines = [];
    let fetchCount = 0;
    await runDeployCommand(
      [dir, "--ns", "demo", "--control-url", "https://ctl.example/localhost"],
      {
        env: { ADMIN_TOKEN: "tok" },
        stdout: (/** @type {string} */ line) => lines.push(/** @type {string} */ line),
        stderr: () => {},
        execFile: (/** @type {string} */ _cmd, /** @type {readonly string[]} */ args) => {
          if (args.includes("--version")) return "wrangler 4.94.0";
          const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice("--outdir=".length);
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

test("runDeployCommand treats a .test control host as local (http URL, not https)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-test-host-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), 'export default { fetch() { return new Response("ok"); } };');
    writeFileSync(path.join(dir, "wrangler.toml"), ['name = "api"', 'main = "src/index.js"'].join("\n"));

    /** @type {string[]} */
    const lines = [];
    let fetchCount = 0;
    await runDeployCommand(
      [dir, "--ns", "demo", "--control-url", "http://admin.test"],
      {
        env: { ADMIN_TOKEN: "tok" },
        stdout: (/** @type {string} */ line) => lines.push(/** @type {string} */ line),
        stderr: () => {},
        execFile: (/** @type {string} */ _cmd, /** @type {readonly string[]} */ args) => {
          if (args.includes("--version")) return "wrangler 4.94.0";
          const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice("--outdir=".length);
          mkdirSync(outDir, { recursive: true });
          writeFileSync(path.join(outDir, "index.js"), 'export default { fetch() { return new Response("ok"); } };');
        },
        controlFetch: async () => {
          fetchCount += 1;
          return fetchCount === 1
            ? response({ version: "v1", warnings: [] })
            : response({ platformDomain: "workers.local" });
        },
      }
    );

    assert.ok(
      lines.includes("  http://demo.workers.local:8080/api/"),
      "a .test control host prints the local http URL"
    );
    assert.equal(lines.some((line) => line.startsWith("  https://")), false, "no production https URL for a local deploy");
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

test("runDeployCommand escapes terminal controls in [vars] diagnostics", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-vars-escape-"));
  const bad = `BAD${ESC}[2J\nFORGED\rBAD`;
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({
      name: "api",
      main: "src/index.js",
      vars: {
        [bad]: { nested: true },
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
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assertNoRawTerminalControls(message, "[vars] diagnostics");
        assert.match(message, /BAD\\u001b\[2J\\nFORGED\\rBAD/);
        return true;
      }
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

test("runDeployCommand rejects vars that collide with bindings before bundling", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-vars-binding-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({
      name: "api",
      main: "src/index.js",
      kv_namespaces: [{ binding: "CACHE", id: "kv-cache" }],
      vars: { CACHE: "shadow" },
    }));

    let execCalled = false;
    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: () => { execCalled = true; },
        controlFetch: async () => response({}),
      }),
      /binding name collision: CACHE/
    );
    assert.equal(execCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects vars that collide with the implicit assets binding", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-assets-var-collision-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    mkdirSync(path.join(dir, "public"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "public", "index.html"), "<html></html>");
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({
      name: "api",
      main: "src/index.js",
      assets: { directory: "public" },
      vars: { ASSETS: "shadow" },
    }));

    let fetched = false;
    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: fakeWranglerExecFile,
        controlFetch: async () => {
          fetched = true;
          return response({});
        },
      }),
      /binding name collision: ASSETS/
    );
    assert.equal(fetched, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects explicit bindings that collide with the implicit assets binding", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-assets-binding-collision-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    mkdirSync(path.join(dir, "public"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "public", "index.html"), "<html></html>");
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({
      name: "api",
      main: "src/index.js",
      assets: { directory: "public" },
      kv_namespaces: [{ binding: "ASSETS", id: "kv-assets" }],
    }));

    let fetched = false;
    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: fakeWranglerExecFile,
        controlFetch: async () => {
          fetched = true;
          return response({});
        },
      }),
      /binding name collision: ASSETS/
    );
    assert.equal(fetched, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand treats an empty assets directory as an implicit ASSETS binding", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-empty-assets-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    mkdirSync(path.join(dir, "public"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({
      name: "api",
      main: "src/index.js",
      assets: { directory: "public" },
    }));

    /** @type {RecordedFetch[]} */
    const fetchCalls = [];
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: () => {},
      execFile: fakeWranglerExecFile,
      controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
        fetchCalls.push({ url, init });
        if (fetchCalls.length === 1) return response({ version: "v1", warnings: [] });
        return response({ platformDomain: "wdl.sh" });
      },
    });

    const manifest = JSON.parse(/** @type {string} */ (fetchCalls[0].init.body));
    assert.deepEqual(manifest.assets, {});
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects vars that collide with empty declared assets", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-empty-assets-var-collision-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    mkdirSync(path.join(dir, "public"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({
      name: "api",
      main: "src/index.js",
      assets: { directory: "public" },
      vars: { ASSETS: "shadow" },
    }));

    let fetched = false;
    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: fakeWranglerExecFile,
        controlFetch: async () => {
          fetched = true;
          return response({});
        },
      }),
      /binding name collision: ASSETS/
    );
    assert.equal(fetched, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("packWranglerProject escapes progress output fields", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "wdl-pack-progress-escape-"));
  const badEnv = `prod${ESC}[2J\nFORGED\rBAD`;
  const projectDir = `app${ESC}[2J\nFORGED\rBAD`;
  const dir = path.join(root, projectDir);
  try {
    mkdirSync(dir);
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({
      name: "api",
      main: "src/index.js",
      env: { [badEnv]: {} },
    }));

    /** @type {string[]} */
    const stdoutLines = [];
    await packWranglerProject({
      cwd: root,
      projectDir,
      envName: badEnv,
      stdout: (line = "") => {
        stdoutLines.push(line);
      },
      execFile: /** @type {typeof import("node:child_process").execFileSync} */ ((/** @type {string} */ _cmd, /** @type {readonly string[]} */ args = []) => {
        if (args.includes("--version")) return "wrangler 4.94.0";
        const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice("--outdir=".length);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, "index.js"), "export default {}");
      }),
    });

    const progress = stdoutLines.find((line) => line.includes("bundling via wrangler"));
    assert.ok(progress);
    assertNoRawTerminalControls(progress, "wrangler progress output");
    assert.match(progress, /env=prod\\u001b\[2J\\nFORGED\\rBAD/);
    assert.match(progress, /app\\u001b\[2J\\nFORGED\\rBAD/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("packWranglerProject escapes missing entry diagnostics", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-pack-entry-escape-"));
  const badMain = `src/bad${ESC}[2J\nFORGED\rBAD.ts`;
  try {
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({
      name: "api",
      main: badMain,
    }));

    await assert.rejects(
      () => packWranglerProject({
        cwd: dir,
        projectDir: ".",
        stdout: () => {},
        execFile: /** @type {typeof import("node:child_process").execFileSync} */ ((/** @type {string} */ _cmd, /** @type {readonly string[]} */ args = []) => {
          if (args.includes("--version")) return "wrangler 4.94.0";
          const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice("--outdir=".length);
          mkdirSync(outDir, { recursive: true });
          writeFileSync(path.join(outDir, "other.js"), "export default {}");
        }),
      }),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assertNoRawTerminalControls(message, "missing entry diagnostics");
        assert.match(message, /bad\\u001b\[2J\\nFORGED\\rBAD/);
        return true;
      }
    );
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

    /** @type {RecordedExec[]} */
    const execCalls = [];
    await runDeployCommand([dir, "--ns", "demo", "--verbose"], {
      env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
      stdout: () => {},
      stderr: () => {},
      execFile: (/** @type {string} */ cmd, /** @type {readonly string[]} */ args, /** @type {ExecFileOpts} */ opts) => {
        execCalls.push({ cmd, args, opts });
        if (args.includes("--version")) return "wrangler 4.94.0";
        const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice("--outdir=".length);
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, "index.js"), "export default {}");
      },
      controlFetch: async () => response({ version: "v1", warnings: [] }),
    });

    assert.equal(execCalls.length, 2);
    assertWranglerVersionProbe(execCalls[0]);
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

    /** @type {RecordedExec[]} */
    const execCalls = [];
    /** @type {string[]} */
    const lines = [];
    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: (/** @type {string} */ line) => lines.push(/** @type {string} */ line),
        stderr: () => {},
        execFile: (/** @type {string} */ cmd, /** @type {readonly string[]} */ args, /** @type {ExecFileOpts} */ opts) => {
          execCalls.push({ cmd, args, opts });
          return "wrangler 3.114.0";
        },
        controlFetch: async () => response({}),
      }),
      /requires Wrangler v4 \(wrangler@\^4\); found v3/
    );
    assert.equal(execCalls.length, 1);
    assertWranglerVersionProbe(execCalls[0]);
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
        execFile: (/** @type {string} */ _cmd, /** @type {readonly string[]} */ args) => {
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
  const badNs = `demo${ESC}[2J\nFORGED\rBAD`;
  const badWorker = `api${ESC}[2J\nFORGED\rBAD`;
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({ name: badWorker, main: "src/index.js" }));

    /** @type {string[]} */
    const warnings = [];
    let fetchCount = 0;
    await runDeployCommand([dir, "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok", WDL_NS: badNs },
      stdout: () => {},
      stderr: (/** @type {string} */ line) => warnings.push(/** @type {string} */ line),
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
    assertNoRawTerminalControls(warnings[0], "deploy warnings");
    assert.match(warnings[0], /wdl secret put --ns 'demo\\u001b\[2J\\nFORGED\\rBAD' --scope ns <KEY>/);
    assert.match(warnings[0], /--worker 'api\\u001b\[2J\\nFORGED\\rBAD' <KEY>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand renders deploy warnings from error responses", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-error-warning-"));
  const badNs = `demo${ESC}[2J\nFORGED\rBAD`;
  const badWorker = `api${ESC}[2J\nFORGED\rBAD`;
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.json"), JSON.stringify({ name: badWorker, main: "src/index.js" }));

    /** @type {string[]} */
    const warnings = [];
    await assert.rejects(
      () => runDeployCommand([dir, "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok", WDL_NS: badNs },
        stdout: () => {},
        stderr: (/** @type {string} */ line) => warnings.push(/** @type {string} */ line),
        execFile: fakeWranglerExecFile,
        controlFetch: async () => response({
          error: "deploy_failed",
          message: "missing caller secrets",
          warnings: [{
            binding: "PAYMENT",
            platform: "STRIPE",
            missingCallerSecrets: ["API_KEY"],
            internalTaskId: "task-secret",
          }],
        }, 400),
      }),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assert.match(message, /deploy failed: 400 deploy_failed: missing caller secrets/);
        assert.doesNotMatch(message, /warnings=/);
        assert.doesNotMatch(message, /task-secret/);
        return true;
      }
    );

    assert.equal(warnings.length, 1);
    assertNoRawTerminalControls(warnings[0], "deploy error warnings");
    assert.doesNotMatch(warnings[0], /task-secret/);
    assert.match(warnings[0], /wdl secret put --ns 'demo\\u001b\[2J\\nFORGED\\rBAD' --scope ns <KEY>/);
    assert.match(warnings[0], /--worker 'api\\u001b\[2J\\nFORGED\\rBAD' <KEY>/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand explains deploy env-budget failures at the command layer", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-env-budget-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "api"\nmain = "src/index.js"\n');

    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: fakeWranglerExecFile,
        controlFetch: async () => response({
          error: "worker_env_too_large",
          message: "env too large",
          source_version: "v2",
        }, 400),
      }),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assert.match(message, /worker_env_too_large/);
        assert.match(message, /source_version=v2/);
        assert.match(message, /reduce \[vars\], secrets, or binding metadata/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand explains worker code size and Python module failures", async () => {
  for (const { error, status, expected } of [
    { error: "worker_code_too_large", status: 413, expected: /reduce generated Worker code size or split the worker/ },
    { error: "python_workers_unsupported", status: 400, expected: /Python Workers modules are not supported by WDL/ },
  ]) {
    const err = await rejectDeployWithControlBody({
      error,
      message: "control rejected deploy",
    }, status);
    assert.match(err.message, new RegExp(error));
    assert.match(err.message, expected);
  }
});

test("runDeployCommand explains secret-envelope deploy failures at the command layer", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-secret-envelope-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "api"\nmain = "src/index.js"\n');

    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: fakeWranglerExecFile,
        controlFetch: async () => response({
          error: "secret_encryption_unconfigured",
          message: "provider missing",
        }, 503),
      }),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assert.match(message, /secret_encryption_unconfigured/);
        assert.match(message, /Secret-envelope configuration or stored secret data needs operator repair/i);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand keeps worker_code_invalid hints generic", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-code-invalid-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "api"\nmain = "src/index.js"\n');

    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: fakeWranglerExecFile,
        controlFetch: async () => response({
          error: "worker_code_invalid",
          message: "invalid generated module graph",
        }, 400),
      }),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assert.match(message, /worker_code_invalid/);
        assert.match(message, /fix the Worker bundle shape reported by the control plane/);
        assert.doesNotMatch(message, /_wdl-\*\.js/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand leaves reserved module-shape rejection to control", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-reserved-module-control-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "api"\nmain = "src/index.js"\n');

    /** @type {RecordedFetch[]} */
    const fetchCalls = [];
    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: (/** @type {string} */ _cmd, /** @type {readonly string[]} */ args) => {
          if (args.includes("--version")) return "wrangler 4.94.0";
          const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice("--outdir=".length);
          mkdirSync(outDir, { recursive: true });
          writeFileSync(path.join(outDir, "index.js"), "export default {}");
          writeFileSync(path.join(outDir, "_wdl-wrapper.js"), "export default {}");
        },
        controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
          fetchCalls.push({ url, init });
          return response({
            error: "worker_code_invalid",
            message: "reserved injected module name",
          }, 400);
        },
      }),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assert.match(message, /worker_code_invalid/);
        assert.match(message, /fix the Worker bundle shape reported by the control plane/);
        assert.doesNotMatch(message, /rename modules that collide/);
        return true;
      }
    );

    assert.equal(fetchCalls.length, 1);
    const manifest = JSON.parse(/** @type {string} */ (fetchCalls[0].init.body));
    assert.equal(Object.hasOwn(manifest.modules, "_wdl-wrapper.js"), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand explains control-rejected experimental compatibility flags", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-experimental-flag-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), [
      'name = "api"',
      'main = "src/index.js"',
      'compatibility_flags = ["experimental"]',
    ].join("\n"));

    /** @type {RecordedFetch[]} */
    const fetchCalls = [];
    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: fakeWranglerExecFile,
        controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
          fetchCalls.push({ url, init });
          return response({
            error: "experimental_compat_flag_unsupported",
            message: "unsupported workerd experimental compatibility flag",
          }, 400);
        },
      }),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assert.match(message, /experimental_compat_flag_unsupported/);
        assert.match(message, /remove the unsupported workerd experimental compatibility flag/);
        return true;
      }
    );

    assert.equal(fetchCalls.length, 1);
    const manifest = JSON.parse(/** @type {string} */ (fetchCalls[0].init.body));
    assert.deepEqual(manifest.compatibilityFlags, ["experimental"]);
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

    /** @type {string[]} */
    const warnings = [];
    let fetchCount = 0;
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: (/** @type {string} */ line) => warnings.push(/** @type {string} */ line),
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

test("runDeployCommand explains a failed promote after upload", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-promote-fail-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "api"\nmain = "src/index.js"\n');

    /** @type {string[]} */
    const stderrLines = [];
    let fetchCount = 0;
    await assert.rejects(
      () => runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: (/** @type {string} */ line) => stderrLines.push(/** @type {string} */ line),
        execFile: fakeWranglerExecFile,
        controlFetch: async () => {
          fetchCount += 1;
          if (fetchCount === 1) return response({ version: "v9", warnings: [] });
          return response({ error: "promote_failed", message: "routing unavailable" }, 503);
        },
      }),
      /promote failed: 503 promote_failed: routing unavailable/
    );

    assert.equal(fetchCount, 2);
    assert.ok(stderrLines.some((line) =>
      /version v9 was uploaded and retained but NOT promoted/.test(line)
    ));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
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

    /** @type {string[]} */
    const warnings = [];
    let fetchCount = 0;
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: (/** @type {string} */ line) => warnings.push(/** @type {string} */ line),
      execFile: (/** @type {string} */ _cmd, /** @type {readonly string[]} */ args) => {
        if (args.includes("--version")) return "wrangler 4.94.0";
        const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice("--outdir=".length);
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

    /** @type {RecordedFetch[]} */
    const fetchCalls = [];
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: () => {},
      execFile: fakeWranglerExecFile,
      controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
        fetchCalls.push({ url, init });
        if (fetchCalls.length === 1) return response({ version: "v1", warnings: [] });
        return response({ platformDomain: "wdl.sh" });
      },
    });

    const manifest = JSON.parse(/** @type {string} */ (fetchCalls[0].init.body));
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

    /** @type {string[]} */
    const stderrLines = [];
    /** @type {RecordedFetch[]} */
    const fetchCalls = [];
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: (/** @type {string} */ line) => stderrLines.push(/** @type {string} */ line),
      execFile: fakeWranglerExecFile,
      controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
        fetchCalls.push({ url, init });
        if (fetchCalls.length === 1) return response({ version: "v1", warnings: [] });
        return response({ platformDomain: "wdl.sh" });
      },
    });

    const note = stderrLines.find((line) => line.startsWith("note: assets: skipped"));
    assert.ok(note, `expected a skipped-assets note, got ${JSON.stringify(stderrLines)}`);
    assert.match(note, /skipped 1 ignored entry \(node_modules\/; a trailing \/ is a whole subtree\)/);
    const manifest = JSON.parse(/** @type {string} */ (fetchCalls[0].init.body));
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

    /** @type {string[]} */
    const stdoutLines = [];
    let fetchCount = 0;
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (/** @type {string} */ line) => stdoutLines.push(/** @type {string} */ line),
      stderr: () => {},
      execFile: fakeWranglerExecFile,
      controlFetch: async () => {
        fetchCount += 1;
        if (fetchCount === 1) return response({ version: "v1\u001b[2J", warnings: [] });
        return response({ platformDomain: "wdl.sh" });
      },
    });

    const out = stdoutLines.join("\n");
    assertNoRawTerminalControls(out, "deploy success output");
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
