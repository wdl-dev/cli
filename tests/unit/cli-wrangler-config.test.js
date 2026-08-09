import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { parseDurableObjectsFromCfg, parseTriggers } from "../../lib/wrangler/bindings.js";
import {
  collectRoutes,
  createWranglerBundleConfig,
  formatWranglerConfigShadowWarning,
  loadWranglerConfig,
  parseJsonc,
  parseSessionPolicy,
  parseWorkersDev,
  resolveWranglerConfig,
  validateUnsupportedWranglerConfig,
} from "../../lib/wrangler/config.js";
import { installTempFileCleanup } from "../../lib/wrangler-pack.js";
import { ESC, assertNoRawTerminalControls } from "./helpers.js";

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

test("loadWranglerConfig: prefers wrangler.json when multiple config files exist", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-config-"));
  try {
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "toml-demo"\nmain = "src/index.js"\n');
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({
        name: "json-demo",
        main: "src/index.js",
      })
    );
    writeFileSync(path.join(dir, "wrangler.jsonc"), '{ "name": "jsonc-demo", "main": "src/index.js" }');

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
    const processLike = /** @type {EventEmitter & { off(event: string, listener: () => void): EventEmitter }} */ (
      new EventEmitter()
    );
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
    const exitProcess = /** @type {EventEmitter & { off(event: string, listener: () => void): EventEmitter }} */ (
      new EventEmitter()
    );
    installTempFileCleanup(dir, exitProcess);
    assert.doesNotThrow(() => exitProcess.emit("exit"));

    const cleanupProcess = /** @type {EventEmitter & { off(event: string, listener: () => void): EventEmitter }} */ (
      new EventEmitter()
    );
    const cleanup = installTempFileCleanup(dir, cleanupProcess);
    assert.throws(() => cleanup(), /EISDIR|directory/i);
    assert.doesNotThrow(() => cleanup({ ignoreErrors: true }));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWranglerConfig: named environments require explicit selection", () => {
  assert.throws(
    () =>
      resolveWranglerConfig(
        {
          name: "demo",
          main: "src/index.js",
          env: { staging: {} },
        },
        null,
        "wrangler.toml"
      ),
    /named environments found \(staging\)/
  );
});

test("resolveWranglerConfig: selected environment inherits supported top-level keys", () => {
  const { cfg, envName } = resolveWranglerConfig(
    {
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
    },
    "staging",
    "wrangler.toml"
  );

  assert.equal(envName, "staging");
  assert.equal(cfg.name, "demo");
  assert.equal(cfg.main, "src/index.js");
  assert.equal(cfg.compatibility_date, "2026-06-17");
  assert.deepEqual(cfg.compatibility_flags, ["nodejs_als"]);
  assert.equal(cfg.route, "dev.example.com/*");
  assert.deepEqual(cfg.triggers, { crons: ["*/5 * * * *"] });
});

test("resolveWranglerConfig: worker name stays as top-level name regardless of env", () => {
  const { cfg } = resolveWranglerConfig(
    {
      name: "demo",
      main: "src/index.js",
      env: {
        staging: {},
      },
    },
    "staging",
    "wrangler.toml"
  );

  assert.equal(cfg.name, "demo");
});

test("resolveWranglerConfig: non-inheritable keys are env-scoped while inheritable keys carry through", () => {
  const { cfg } = resolveWranglerConfig(
    {
      name: "demo",
      main: "src/index.js",
      vars: { TOP: "1" },
      kv_namespaces: [{ binding: "KV", id: "top" }],
      services: [{ binding: "AUTH", service: "auth" }],
      queues: { producers: [{ binding: "Q", queue: "top-q" }] },
      assets: { directory: "./top-public" },
      route: "api.example/*",
      workers_dev: false,
      env: {
        prod: {
          vars: { ENV: "prod" },
          kv_namespaces: [{ binding: "KV", id: "prod" }],
          queues: { consumers: [{ queue: "jobs" }] },
        },
      },
    },
    "prod",
    "wrangler.jsonc"
  );

  assert.deepEqual(cfg.vars, { ENV: "prod" });
  assert.deepEqual(cfg.kv_namespaces, [{ binding: "KV", id: "prod" }]);
  assert.deepEqual(cfg.queues, { consumers: [{ queue: "jobs" }] });
  assert.equal(cfg.services, undefined);
  assert.deepEqual(cfg.assets, { directory: "./top-public" });
  assert.equal(cfg.route, "api.example/*");
  assert.equal(cfg.workers_dev, false);
});

test("resolveWranglerConfig: selected environment can override inherited assets", () => {
  const { cfg } = resolveWranglerConfig(
    {
      name: "demo",
      main: "src/index.js",
      assets: { directory: "./top-public" },
      env: {
        prod: {
          assets: { directory: "./prod-public" },
        },
      },
    },
    "prod",
    "wrangler.jsonc"
  );

  assert.deepEqual(cfg.assets, { directory: "./prod-public" });
});

test("resolveWranglerConfig: selected environment can override inherited workers_dev", () => {
  const { cfg } = resolveWranglerConfig(
    {
      name: "demo",
      main: "src/index.js",
      workers_dev: true,
      env: {
        prod: {
          workers_dev: false,
        },
      },
    },
    "prod",
    "wrangler.jsonc"
  );

  assert.equal(cfg.workers_dev, false);
});

test("resolveWranglerConfig: selected environment can override durable object migrations", () => {
  const { cfg } = resolveWranglerConfig(
    {
      name: "demo",
      main: "src/index.js",
      migrations: [{ tag: "v1", new_classes: ["TopObject"] }],
      env: {
        prod: {
          migrations: [{ tag: "v2", new_sqlite_classes: ["ProdObject"] }],
        },
      },
    },
    "prod",
    "wrangler.jsonc"
  );

  assert.deepEqual(cfg.migrations, [{ tag: "v2", new_sqlite_classes: ["ProdObject"] }]);
});

test("resolveWranglerConfig: rejects unknown environment names", () => {
  assert.throws(
    () =>
      resolveWranglerConfig(
        {
          name: "demo",
          main: "src/index.js",
          env: { staging: {} },
        },
        "prod",
        "wrangler.toml"
      ),
    /environment "prod" not found/
  );
});

test("resolveWranglerConfig: rejects top-level-only keys inside an environment", () => {
  assert.throws(
    () =>
      resolveWranglerConfig(
        {
          name: "demo",
          main: "src/index.js",
          env: {
            staging: {
              keep_vars: true,
            },
          },
        },
        "staging",
        "wrangler.toml"
      ),
    /env\.staging\.keep_vars is top-level only/
  );
});

test("resolveWranglerConfig: rejects env-specific name overrides", () => {
  assert.throws(
    () =>
      resolveWranglerConfig(
        {
          name: "demo",
          main: "src/index.js",
          env: {
            staging: {
              name: "foo",
            },
          },
        },
        "staging",
        "wrangler.toml"
      ),
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

test("createWranglerBundleConfig projects WDL extensions without mutating source config", () => {
  const rawCfg = {
    name: "demo",
    main: "src/index.js",
    build: { command: "npm run build" },
    vars: { MODE: "top" },
    triggers: {
      crons: ["*/5 * * * *"],
      schedules: [{ cron: "0 9 * * 1-5", timezone: "Asia/Shanghai" }],
    },
    services: [
      {
        binding: "AUTH",
        service: "auth-worker",
        entrypoint: "Auth",
        ns: "shared",
        props: { role: "caller" },
        remote: true,
      },
    ],
    exports: [{ entrypoint: "Auth", allowed_callers: ["acme"] }],
    platform_bindings: [{ binding: "PAYMENT", platform: "STRIPE" }],
    wdl: { session_policy: "restart" },
    env: {
      staging: {
        define: { BUILD_ENV: '"staging"' },
        triggers: {
          crons: ["0 * * * *"],
          schedules: [{ cron: "0 8 * * *", timezone: "Europe/London" }],
        },
        services: [{ binding: "API", service: "api-worker", ns: "backend", remote: false }],
        exports: [{ entrypoint: "default", allowed_callers: ["*"] }],
        platform_bindings: [{ binding: "SEARCH", platform: "SEARCH" }],
        wdl: { session_policy: "preserve" },
      },
    },
  };
  const original = structuredClone(rawCfg);

  const projected = createWranglerBundleConfig(rawCfg);

  assert.deepEqual(rawCfg, original);
  assert.equal(projected.name, "wdl-bundle-tmp");
  assert.equal(projected.exports, undefined);
  assert.equal(projected.platform_bindings, undefined);
  assert.equal(projected.wdl, undefined);
  assert.deepEqual(projected.build, { command: "npm run build" });
  assert.deepEqual(projected.vars, { MODE: "top" });
  assert.deepEqual(projected.triggers, { crons: ["*/5 * * * *"] });
  assert.deepEqual(projected.services, [
    {
      binding: "AUTH",
      service: "auth-worker",
      entrypoint: "Auth",
      props: { role: "caller" },
      remote: true,
    },
  ]);
  const projectedEnv = /** @type {Record<string, Record<string, unknown>>} */ (projected.env);
  assert.deepEqual(projectedEnv.staging.define, { BUILD_ENV: '"staging"' });
  assert.deepEqual(projectedEnv.staging.triggers, { crons: ["0 * * * *"] });
  assert.deepEqual(projectedEnv.staging.services, [{ binding: "API", service: "api-worker", remote: false }]);
  assert.equal(projectedEnv.staging.exports, undefined);
  assert.equal(projectedEnv.staging.platform_bindings, undefined);
  assert.equal(projectedEnv.staging.wdl, undefined);
});

test("parseSessionPolicy validates the [wdl] session policy", () => {
  assert.equal(parseSessionPolicy({}), "preserve");
  assert.equal(parseSessionPolicy({ wdl: {} }), "preserve");
  assert.equal(parseSessionPolicy({ wdl: { session_policy: "restart" } }), "restart");
  assert.throws(() => parseSessionPolicy({ wdl: [] }), /\[wdl\] must be a table/);
  assert.throws(() => parseSessionPolicy({ wdl: { session_policy: "replace" } }), /must be "preserve" or "restart"/);
  assert.throws(
    () => parseSessionPolicy({ wdl: { session_policy: "restart", typo: true, other: 1 } }),
    /\[wdl\] contains unknown field\(s\): typo, other/
  );
  // An explicit null is rejected at the field and at the table boundary.
  assert.throws(() => parseSessionPolicy({ wdl: { session_policy: null } }), /must be "preserve" or "restart"/);
  assert.throws(() => parseSessionPolicy({ wdl: null }), /\[wdl\] must be a table/);
  assert.throws(() => parseSessionPolicy({ wdl: { session_policy: Number.NaN } }), /got NaN/);
  // smol-toml parses bare dates into TomlDate, an object with no own keys: it
  // is neither a table nor a string value.
  const tomlDate = parseToml("v = 2026-08-04").v;
  assert.throws(() => parseSessionPolicy({ wdl: tomlDate }), /\[wdl\] must be a table/);
  assert.throws(() => parseSessionPolicy({ wdl: { session_policy: tomlDate } }), /got datetime 2026-08-04/);
  const hostile = `bad${ESC}[2J\nFORGED\rBAD`;
  assert.throws(
    () => parseSessionPolicy({ wdl: { [hostile]: true } }, `wrangler-${hostile}.toml`),
    (err) => {
      const message = /** @type {Error} */ (err).message;
      assert.match(message, /\[wdl\] contains unknown field\(s\)/);
      assertNoRawTerminalControls(message, "session policy diagnostics");
      return true;
    }
  );
});

test("collectRoutes: accepts strings and { pattern } tables, rejects non-arrays", () => {
  assert.deepEqual(collectRoutes({}, "wrangler.toml"), []);
  assert.deepEqual(collectRoutes({ route: "dev.example.com/*" }, "wrangler.toml"), ["dev.example.com/*"]);
  assert.deepEqual(collectRoutes({ routes: ["a.example.com/*", { pattern: "b.example.com/*" }] }, "wrangler.toml"), [
    "a.example.com/*",
    "b.example.com/*",
  ]);
  assert.throws(() => collectRoutes({ routes: "a.example.com/*" }, "wrangler.toml"), /"routes" must be an array/);
  assert.throws(
    () => collectRoutes({ routes: { pattern: "a.example.com/*" } }, "wrangler.toml"),
    /"routes" must be an array/
  );
  assert.throws(
    () => collectRoutes({ route: "a", routes: ["b"] }, "wrangler.toml"),
    /specify either "route" or "routes"/
  );
  const hostile = `bad${ESC}[2J\nFORGED\rBAD`;
  assert.throws(
    () => collectRoutes({ route: "a", routes: ["b"] }, `wrangler-${hostile}.toml`),
    (err) => {
      const message = /** @type {Error} */ (err).message;
      assert.match(message, /specify either "route" or "routes"/);
      assertNoRawTerminalControls(message, "route config diagnostics");
      return true;
    }
  );
  assert.throws(
    () => collectRoutes({ routes: [{ bad: hostile }] }, "wrangler.toml"),
    (err) => {
      const message = /** @type {Error} */ (err).message;
      assert.match(message, /unsupported routes entry/);
      assertNoRawTerminalControls(message, "route entry diagnostics");
      return true;
    }
  );
});

test("parseWorkersDev requires an explicit boolean and a route for opt-out", () => {
  assert.equal(parseWorkersDev({}, [], "wrangler.toml"), true);
  assert.equal(parseWorkersDev({ workers_dev: true }, [], "wrangler.toml"), true);
  assert.equal(parseWorkersDev({ workers_dev: false }, ["app.example/*"], "wrangler.toml"), false);
  assert.throws(
    () => parseWorkersDev({ workers_dev: "false" }, ["app.example/*"], "wrangler.toml"),
    /"workers_dev" must be a boolean/
  );
  assert.throws(
    () => parseWorkersDev({ workers_dev: false }, [], "wrangler.toml"),
    /requires at least one route pattern/
  );
});

test("a bare TOML datetime is never mistaken for a table", () => {
  const tomlDate = parseToml("v = 2026-08-04").v;
  assert.throws(() => parseTriggers(tomlDate), /\[triggers\] must be a table/);
  assert.throws(() => parseDurableObjectsFromCfg({ durable_objects: tomlDate }), /\[durable_objects\] must be a table/);
  assert.throws(
    () => resolveWranglerConfig({ name: "a", main: "i.js", env: { prod: tomlDate } }, "prod"),
    /env\.prod must be an object/
  );
});

test("validateUnsupportedWranglerConfig: rejects session_policy hoisted out of [wdl]", () => {
  assert.throws(
    () =>
      validateUnsupportedWranglerConfig(
        { name: "demo", main: "src/index.js", session_policy: "restart" },
        null,
        "wrangler.toml"
      ),
    /top-level session_policy.*\[wdl\]/
  );
  assert.throws(
    () =>
      validateUnsupportedWranglerConfig(
        { name: "demo", main: "src/index.js", env: { prod: { session_policy: "restart" } } },
        "prod",
        "wrangler.toml"
      ),
    /env\.prod uses top-level session_policy/
  );
});

test("[wdl] resolves per environment like the policies beside it", () => {
  const topLevelWdl = {
    name: "demo",
    main: "src/index.js",
    wdl: { session_policy: "restart" },
    durable_objects: { bindings: [{ name: "ROOMS", class_name: "Room" }] },
    env: { prod: { vars: { STAGE: "prod" } } },
  };
  // Inherited when the env declares none, unlike the bindings beside it.
  const inherited = resolveWranglerConfig(topLevelWdl, "prod", "wrangler.toml").cfg;
  assert.equal(parseSessionPolicy(inherited), "restart");
  assert.equal(inherited.durable_objects, undefined);
  // An env-level table replaces the top-level one whole, contents and all.
  const overridden = resolveWranglerConfig(
    { ...topLevelWdl, wdl: { typo: 1 }, env: { prod: { wdl: { session_policy: "preserve" } } } },
    "prod",
    "wrangler.toml"
  ).cfg;
  assert.equal(parseSessionPolicy(overridden), "preserve");
});

test("validateUnsupportedWranglerConfig: workflows are supported at top-level and selected env", () => {
  assert.doesNotThrow(() =>
    validateUnsupportedWranglerConfig(
      {
        name: "demo",
        main: "src/index.js",
        workflows: [{ binding: "WF" }],
        env: { staging: { workflows: [{ binding: "WF" }] } },
      },
      "staging",
      "wrangler.toml"
    )
  );
});

test("validateUnsupportedWranglerConfig: rejects unsupported top-level config even when env is selected", () => {
  assert.throws(
    () =>
      validateUnsupportedWranglerConfig(
        {
          name: "demo",
          main: "src/index.js",
          analytics_engine_datasets: [{ binding: "AE" }],
          env: { staging: {} },
        },
        "staging",
        "wrangler.toml"
      ),
    /unsupported Wrangler field "analytics_engine_datasets"/
  );
});

test("validateUnsupportedWranglerConfig: rejects unsupported config inside the selected environment", () => {
  assert.throws(
    () =>
      validateUnsupportedWranglerConfig(
        {
          name: "demo",
          main: "src/index.js",
          env: {
            staging: {
              analytics_engine_datasets: [{ binding: "AE" }],
            },
          },
        },
        "staging",
        "wrangler.toml"
      ),
    /env\.staging uses unsupported Wrangler field "analytics_engine_datasets"/
  );
});

test("validateUnsupportedWranglerConfig: top-level allowed_callers is rejected with the [[exports]] migration path", () => {
  assert.throws(
    () =>
      validateUnsupportedWranglerConfig(
        {
          name: "demo",
          main: "src/index.js",
          allowed_callers: ["acme"],
        },
        null,
        "wrangler.toml"
      ),
    /top-level allowed_callers — removed.*\[\[exports\]\]/
  );
});

test("validateUnsupportedWranglerConfig: empty top-level allowed_callers is still rejected by presence", () => {
  for (const value of [[], null, false, ""]) {
    assert.throws(
      () =>
        validateUnsupportedWranglerConfig(
          {
            name: "demo",
            main: "src/index.js",
            allowed_callers: value,
          },
          null,
          "wrangler.toml"
        ),
      /top-level allowed_callers — removed/
    );
  }
});

test("validateUnsupportedWranglerConfig: env-scoped allowed_callers is rejected too", () => {
  assert.throws(
    () =>
      validateUnsupportedWranglerConfig(
        {
          name: "demo",
          main: "src/index.js",
          env: { staging: { allowed_callers: ["acme"] } },
        },
        "staging",
        "wrangler.toml"
      ),
    /env\.staging uses top-level allowed_callers — removed/
  );
});

test("validateUnsupportedWranglerConfig: empty env-scoped allowed_callers is still rejected by presence", () => {
  for (const value of [[], null, false, ""]) {
    assert.throws(
      () =>
        validateUnsupportedWranglerConfig(
          {
            name: "demo",
            main: "src/index.js",
            env: { staging: { allowed_callers: value } },
          },
          "staging",
          "wrangler.toml"
        ),
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
  const booleanShapeKeys = new Set(["first_party_worker", "legacy_env", "preview_urls", "upload_source_maps"]);
  for (const key of [
    "addresses",
    "agent_memory",
    "ai",
    "artifacts",
    "browser",
    "cache",
    "cloudchamber",
    "compliance_region",
    "dependencies_instrumentation",
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
  ]) {
    assert.throws(
      () =>
        validateUnsupportedWranglerConfig(
          {
            name: "demo",
            main: "src/index.js",
            [key]: unsupportedWranglerFixtureValue(key, objectShapeKeys, booleanShapeKeys),
          },
          null,
          "wrangler.toml"
        ),
      new RegExp(`unsupported Wrangler field "${key}"`)
    );
  }

  assert.throws(
    () =>
      validateUnsupportedWranglerConfig(
        {
          name: "demo",
          main: "src/index.js",
          vectorize: [],
        },
        null,
        "wrangler.toml"
      ),
    /unsupported Wrangler field "vectorize"/
  );

  for (const [key, value] of /** @type {Array<[string, unknown]>} */ ([
    ["addresses", []],
    ["dependencies_instrumentation", null],
  ])) {
    assert.throws(
      () =>
        validateUnsupportedWranglerConfig(
          {
            name: "demo",
            main: "src/index.js",
            [key]: value,
          },
          null,
          "wrangler.toml"
        ),
      new RegExp(`unsupported Wrangler field "${key}"`)
    );
  }

  assert.throws(
    () =>
      validateUnsupportedWranglerConfig(
        {
          name: "demo",
          main: "src/index.js",
          env: {
            staging: {
              preview_urls: false,
            },
          },
        },
        "staging",
        "wrangler.toml"
      ),
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
  if (key === "dependencies_instrumentation") return { enabled: false };
  if (objectShapeKeys.has(key)) return { binding: "B" };
  if (booleanShapeKeys.has(key)) return true;
  if (key === "addresses") return ["support@example.com"];
  if (key === "compliance_region") return "eu";
  if (key === "pages_build_output_dir") return "dist";
  return [{ binding: "B" }];
}

test("validateUnsupportedWranglerConfig rejects module-binding and container sections", () => {
  assert.throws(
    () =>
      validateUnsupportedWranglerConfig(
        { name: "demo", main: "src/index.js", wasm_modules: { MOD: "./m.wasm" } },
        null,
        "wrangler.toml"
      ),
    /unsupported Wrangler field "wasm_modules"/
  );
  assert.throws(
    () =>
      validateUnsupportedWranglerConfig(
        { name: "demo", main: "src/index.js", containers: [{ class_name: "C" }] },
        null,
        "wrangler.toml"
      ),
    /unsupported Wrangler field "containers"/
  );
});
