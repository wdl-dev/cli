import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { DEPLOY_JSON_BODY_MAX_BYTES, runDeployCommand, serializeDeployManifest } from "../../commands/deploy.js";
import { packWranglerProject } from "../../lib/wrangler-pack.js";
import { LONG_CONTROL_TIMEOUT_MS } from "../../lib/control-fetch.js";
import {
  assertWranglerVersionProbe,
  createDeployProject,
  deployPromoteFetch,
  fakeWranglerExecFile,
} from "./deploy-helpers.js";
import { ESC, assertNoRawTerminalControls, response } from "./helpers.js";

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

/** @typedef {import("./helpers.js").ControlCall} RecordedFetch */

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
test("runDeployCommand rejects a bare TOML datetime where a table belongs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-datetime-table-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      ['name = "api"', 'main = "src/index.js"', "assets = 2026-08-04"].join("\n")
    );

    let execCalled = false;
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          execFile: () => {
            execCalled = true;
            throw new Error("execFile should not be called");
          },
        }),
      /\[assets\] must be a table/
    );
    assert.equal(execCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects a bare TOML datetime where [vars] belongs", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-datetime-vars-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      ['name = "api"', 'main = "src/index.js"', "vars = 2026-08-04"].join("\n")
    );

    let execCalled = false;
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          execFile: () => {
            execCalled = true;
            throw new Error("execFile should not be called");
          },
        }),
      /\[vars\] must be an object/
    );
    assert.equal(execCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects unsupported event triggers before running Wrangler", async (t) => {
  const dir = createDeployProject(
    t,
    ['name = "api"', 'main = "src/index.js"', "", "[triggers]", "events = []"].join("\n"),
    "wdl-run-deploy-event-triggers-"
  );
  let execCalled = false;

  await assert.rejects(
    () =>
      runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        execFile: () => {
          execCalled = true;
          throw new Error("execFile should not be called");
        },
      }),
    /\[triggers\] contains unsupported field\(s\): events/
  );
  assert.equal(execCalled, false);
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
        "[ai]",
        'binding = "AI"',
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
        "[[services]]",
        'binding = "AUTH"',
        'service = "auth-worker"',
        'ns = "shared"',
        "",
        "[[exports]]",
        'entrypoint = "default"',
        'allowed_callers = ["acme"]',
        "",
        "[[platform_bindings]]",
        'binding = "PAYMENT"',
        'platform = "STRIPE"',
        "",
        "[[triggers.schedules]]",
        'cron = "0 9 * * 1-5"',
        'timezone = "Asia/Shanghai"',
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
    const { calls: fetchCalls, controlFetch } = deployPromoteFetch(
      { version: "v1", warnings: [] },
      { platformDomain: "workers.example" }
    );
    /** @type {string[]} */
    const lines = [];
    await runDeployCommand(["sub", "--control-url", "http://ctl.test"], {
      env: {
        ADMIN_TOKEN: "tok",
        CONTROL_CONNECT_HOST: "127.0.0.1:18080",
        WDL_NS: "demo space",
        CLOUDFLARE_API_TOKEN: "real-cf-token",
      },
      cwd: parent,
      stdout: (/** @type {string} */ line) => lines.push(/** @type {string} */ line),
      stderr: () => {},
      execFile: (
        /** @type {string} */ cmd,
        /** @type {readonly string[]} */ args,
        /** @type {ExecFileOpts} */ opts
      ) => {
        execCalls.push({ cmd, args, opts });
        if (args.includes("--version")) return "wrangler 4.94.0";
        const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice(
          "--outdir=".length
        );
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, "index.js"), 'export default { fetch() { return new Response("ok"); } };');
      },
      controlFetch,
    });

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
      AI: { type: "ai" },
      ROOMS: { type: "do", className: "Room" },
      AUTH: { type: "service", service: "auth-worker", ns: "shared" },
    });
    assert.deepEqual(manifest.vars, { HELLO: "world" });
    assert.deepEqual(manifest.workflows, [
      { name: "order-workflow", binding: "ORDER_WORKFLOW", className: "OrderWorkflow" },
    ]);
    assert.deepEqual(manifest.crons, [{ cron: "0 9 * * 1-5", timezone: "Asia/Shanghai" }]);
    assert.deepEqual(manifest.exports, [{ entrypoint: "default", allowedCallers: ["acme"] }]);
    assert.deepEqual(manifest.platformBindings, [{ binding: "PAYMENT", platform: "STRIPE" }]);
    assert.equal(manifest.compatibilityDate, "2026-06-17");

    assert.equal(fetchCalls[1].url, "http://ctl.test/ns/demo%20space/worker/api/promote");
    assert.equal(fetchCalls[1].init.method, "POST");
    assert.equal(fetchCalls[1].init.env?.CONTROL_CONNECT_HOST, "127.0.0.1:18080");
    assert.deepEqual(JSON.parse(/** @type {string} */ (fetchCalls[1].init.body)), {
      version: "v1",
    });
    assert.ok(lines.includes("  bundled by wrangler"));
    assert.ok(lines.includes("✓ demo space/api@v1 live"));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects unexpected positional arguments", async () => {
  await assert.rejects(
    () =>
      runDeployCommand([".", "extra", "--ns", "demo", "--control-url", "http://ctl.test"], {
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
    () =>
      runDeployCommand([".", bad, "--ns", "demo", "--control-url", "http://ctl.test"], {
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
    }
  );
});

test("runDeployCommand sanitizes wrangler.name via temp --config so mixed-case wdl names bundle", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-mixedcase-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, ".wrangler.wdl-tmp.json"), "user-owned");
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({
        name: "Mixed-Case-Worker",
        main: "src/index.js",
        vars: { GREETING: "hi" },
        exports: [{ entrypoint: "default", allowed_callers: ["*"] }],
        ai: { binding: "AI" },
      })
    );
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "old"\nmain = "old.js"\n');

    let tmpConfigSeen = null;
    let tmpConfigContentAtExec =
      /** @type {{ name?: string, main?: string, vars?: unknown, exports?: unknown, ai?: unknown } | null} */ (null);
    const { calls: fetchCalls, controlFetch } = deployPromoteFetch(
      { version: "v1", warnings: [] },
      { platformDomain: "workers.example" }
    );
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
        const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice(
          "--outdir=".length
        );
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, "index.js"), "export default {}");
      },
      controlFetch,
    });

    assert.ok(
      fetchCalls[0].url.endsWith("/worker/Mixed-Case-Worker/deploy"),
      `deploy URL must carry the original wdl name, got ${fetchCalls[0].url}`
    );
    assert.ok(tmpConfigContentAtExec);
    assert.equal(tmpConfigContentAtExec.name, "wdl-bundle-tmp");
    assert.equal(tmpConfigContentAtExec.main, "src/index.js");
    assert.deepEqual(tmpConfigContentAtExec.vars, { GREETING: "hi" });
    assert.equal(tmpConfigContentAtExec.exports, undefined);
    assert.deepEqual(tmpConfigContentAtExec.ai, { binding: "AI" });
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

test("runDeployCommand warns when a selected environment does not inherit top-level AI", async (t) => {
  const dir = createDeployProject(
    t,
    ['name = "api"', 'main = "src/index.js"', "[ai]", 'binding = "AI"', "[env.prod]"].join("\n"),
    "wdl-run-deploy-ai-env-warning-"
  );
  const { calls, controlFetch } = deployPromoteFetch(
    { version: "v1", warnings: [] },
    { platformDomain: "workers.example" }
  );
  /** @type {string[]} */
  const warnings = [];

  await runDeployCommand([dir, "--env", "prod", "--ns", "demo", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: () => {},
    stderr: (/** @type {string} */ line) => warnings.push(line),
    execFile: fakeWranglerExecFile,
    controlFetch,
  });

  assert.deepEqual(warnings, [
    "warning: wrangler.toml: top-level [ai] is not inherited into env.prod; " +
      "declare ai inside env.prod to bind AI in this environment",
  ]);
  const manifest = JSON.parse(/** @type {string} */ (calls[0].init.body));
  assert.equal(manifest.bindings, undefined);
});

test("runDeployCommand removes the sanitized temp config when wrangler exec fails", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-mixedcase-fail-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({
        name: "Mixed-Case-Worker",
        main: "src/index.js",
      })
    );

    let tmpConfigSeen = null;
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
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
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({
        name: "api",
        main: "src/index.js",
      })
    );

    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
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
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({
        name: "api",
        main: "src/index.js",
        kv_namespaces: [{ binding: "__proto__", id: "kv-id" }],
      })
    );

    const { calls: fetchCalls, controlFetch } = deployPromoteFetch(
      { version: "v1", warnings: [] },
      { platformDomain: "workers.example" }
    );
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: () => {},
      execFile: fakeWranglerExecFile,
      controlFetch,
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
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({
        name: "api",
        main: "src/index.js",
        assets: "public",
      })
    );

    let execCalled = false;
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
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

for (const { label, body } of [
  { label: "a null body", body: null },
  { label: "no version", body: { warnings: [] } },
  { label: "a non-string version", body: { version: 7 } },
]) {
  test(`runDeployCommand refuses to promote when the deploy response has ${label}`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-unnamed-version-"));
    try {
      mkdirSync(path.join(dir, "src"), { recursive: true });
      writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
      writeFileSync(path.join(dir, "wrangler.toml"), 'name = "api"\nmain = "src/index.js"\n');

      let calls = 0;
      await assert.rejects(
        () =>
          runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
            env: { ADMIN_TOKEN: "tok" },
            stdout: () => {},
            stderr: () => {},
            execFile: fakeWranglerExecFile,
            controlFetch: async () => {
              calls += 1;
              return response(body);
            },
          }),
        /deploy failed: control's response named no version/
      );
      assert.equal(calls, 1, "nothing may reach promote");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("runDeployCommand reports an unknown promotion the way it was requested", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-unknown-restart-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), RESTART_SESSION_POLICY_TOML);

    /** @type {string[]} */
    const stderrLines = [];
    /** @type {RecordedFetch[]} */
    const calls = [];
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          stdout: () => {},
          stderr: (/** @type {string} */ line) => stderrLines.push(line),
          execFile: fakeWranglerExecFile,
          controlFetch: async (
            /** @type {string} */ url,
            /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
          ) => {
            calls.push({ url, init });
            if (calls.length === 1) return response({ version: "v9", sessionPolicy: "restart" }, 201);
            throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
          },
        }),
      /socket hang up/
    );

    assert.equal(
      stderrLines.join(""),
      "note: the promotion outcome is unknown; control may have promoted this version already " +
        "and closed existing sessions."
    );
    assert.equal(calls.length, 2);
    assert.match(calls[1].url, /\/promote$/);
    // The promote leg carries the credentials the upload used.
    assert.deepEqual(calls[1].init.headers, calls[0].init.headers);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand escapes a control-supplied version in the promote confirmation error", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-confirm-escaping-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(path.join(dir, "wrangler.toml"), 'name = "api"\nmain = "src/index.js"\n');

    let calls = 0;
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          stdout: () => {},
          stderr: () => {},
          execFile: fakeWranglerExecFile,
          controlFetch: async () => {
            calls += 1;
            if (calls === 1) return response({ version: `v9${ESC}[2J` }, 201);
            return response({ active: true, version: "v8" }, 200);
          },
        }),
      (/** @type {Error} */ err) => {
        assertNoRawTerminalControls(err.message, "promote confirmation error");
        assert.match(err.message, /did not confirm v9\\u001b\[2J is active/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects a malformed [wdl] before bundling", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-session-policy-invalid-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({ name: "api", main: "src/index.js", wdl: { session_policy: "replace" } })
    );

    let execCalled = false;
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          execFile: () => {
            execCalled = true;
            throw new Error("execFile should not be called");
          },
        }),
      { message: 'wrangler.json: [wdl].session_policy must be "preserve" or "restart", got "replace"' }
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
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({
        name: "api",
        main: "src/index.js",
        vars: [],
      })
    );

    let execCalled = false;
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
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

test("runDeployCommand preserves the local control scheme and port in the Worker URL", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-localurl-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), 'export default { fetch() { return new Response("ok"); } };');
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      ['name = "api"', 'main = "src/index.js"', 'compatibility_date = "2026-06-17"'].join("\n")
    );

    /** @type {string[]} */
    const lines = [];
    let fetchCount = 0;
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "https://box.local:8443"], {
      env: { ADMIN_TOKEN: "tok", CONTROL_CONNECT_HOST: "127.0.0.1:18080" },
      stdout: (/** @type {string} */ line) => lines.push(/** @type {string} */ line),
      stderr: () => {},
      execFile: (/** @type {string} */ _cmd, /** @type {readonly string[]} */ args) => {
        if (args.includes("--version")) return "wrangler 4.94.0";
        const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice(
          "--outdir=".length
        );
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, "index.js"), 'export default { fetch() { return new Response("ok"); } };');
      },
      controlFetch: async () => {
        fetchCount += 1;
        return fetchCount === 1
          ? response({ version: "v1", warnings: [] })
          : response({
              active: true,
              version: "v1",
              platformDomain: "workers.local",
              workersDev: true,
              urls: {
                platform: "https://demo.workers.local/api/",
                routes: [],
              },
            });
      },
    });

    assert.ok(lines.includes("  https://demo.workers.local:8443/api/"));
    assert.equal(
      lines.some((line) => line.includes("curl -H")),
      false,
      "no curl hint"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand preserves canonical URL authorities and route-pattern suffixes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-route-urls-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      [
        'name = "api"',
        'main = "src/index.js"',
        'routes = ["api.example/apiv1/*", "api.example/mcp", "127.0.0.1/ip"]',
      ].join("\n")
    );

    /** @type {string[]} */
    const lines = [];
    let fetchCount = 0;
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "https://control.example"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (/** @type {string} */ line) => lines.push(/** @type {string} */ line),
      stderr: () => {},
      execFile: fakeWranglerExecFile,
      controlFetch: async () => {
        fetchCount += 1;
        return fetchCount === 1
          ? response({ version: "v1", warnings: [], workersDev: true })
          : response({
              active: true,
              version: "v1",
              platformDomain: "workers.example",
              workersDev: true,
              urls: {
                routes: ["https://api.example/apiv1/*", "https://api.example/mcp", "https://127.0.0.1/ip"],
              },
            });
      },
    });

    assert.ok(lines.includes("  https://demo.workers.example/api/"));
    assert.ok(lines.includes("  https://api.example/apiv1/*"));
    assert.ok(lines.includes("  https://api.example/mcp"));
    assert.ok(lines.includes("  https://127.0.0.1/ip"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand omits non-canonical URL hints without failing a promoted deploy", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-route-url-authority-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      ['name = "api"', 'main = "src/index.js"', 'route = "app.example/hello/*"'].join("\n")
    );

    const invalidRouteUrls = [
      "HTTPS://API.EXAMPLE:443/apiv1/*",
      "https://bücher.example/mcp",
      "https://app.example\\evil/hello/*",
      "https://user@app.example/hello/*",
      "https://app.example\t/hello/*",
      "https://127.1/hello/*",
      "https://2130706433/hello/*",
      "https://0x7f.0.0.1/hello/*",
      "https://①②⑦.⓪.⓪.①/hello/*",
    ];
    const invalidPlatformUrl = "HTTPS://DEMO.WORKERS.EXAMPLE:443/api/";
    /** @type {string[]} */
    const lines = [];
    /** @type {string[]} */
    const warnings = [];
    let fetchCount = 0;
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "https://control.example"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (/** @type {string} */ line) => lines.push(line),
      stderr: (/** @type {string} */ line) => warnings.push(line),
      execFile: fakeWranglerExecFile,
      controlFetch: async () => {
        fetchCount += 1;
        return fetchCount === 1
          ? response({ version: "v1", warnings: [], workersDev: true })
          : response({
              active: true,
              version: "v1",
              platformDomain: "workers.example",
              workersDev: true,
              urls: {
                platform: invalidPlatformUrl,
                routes: ["https://valid.example/ok/*", ...invalidRouteUrls, "https://valid.example/after/*"],
              },
            });
      },
    });

    assert.equal(fetchCount, 2);
    assert.ok(lines.includes("✓ demo/api@v1 live"));
    assert.deepEqual(
      lines.filter((line) => line.startsWith("  http")),
      ["  https://demo.workers.example/api/", "  https://valid.example/ok/*", "  https://valid.example/after/*"]
    );
    assert.equal(warnings.length, invalidRouteUrls.length + 1);
    for (const warning of warnings) {
      assert.match(warning, /warning: deployment succeeded, but control returned an invalid Worker URL hint/);
      assertNoRawTerminalControls(warning, "invalid Worker URL warning");
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand sends workers_dev opt-out and prints only route-pattern URL hints", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-workers-dev-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      ['name = "api"', 'main = "src/index.js"', "workers_dev = false", 'route = "app.example/a/../b/*"'].join("\n")
    );

    for (const { label, controlUrl, platformDomain } of [
      { label: "remote", controlUrl: "https://control.example", platformDomain: "workers.example" },
      { label: "local", controlUrl: "http://localhost:8443", platformDomain: "workers.local" },
    ]) {
      /** @type {string[]} */
      const lines = [];
      const { calls: fetchCalls, controlFetch } = deployPromoteFetch(
        { version: "v1", warnings: [], workersDev: false },
        {
          platformDomain,
          workersDev: false,
          urls: { routes: ["https://app.example/a/../b/*"] },
        }
      );
      await runDeployCommand([dir, "--ns", "demo", "--control-url", controlUrl], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: (/** @type {string} */ line) => lines.push(/** @type {string} */ line),
        stderr: () => {},
        execFile: fakeWranglerExecFile,
        controlFetch,
      });

      const manifest = JSON.parse(/** @type {string} */ (fetchCalls[0].init.body));
      assert.deepEqual(manifest.routes, ["app.example/a/../b/*"]);
      assert.equal(manifest.workersDev, false);
      assert.ok(lines.includes("✓ demo/api@v1 live"));
      assert.equal(
        lines.some((line) => line.includes(platformDomain)),
        false,
        `${label} platform URL`
      );
      assert.ok(
        lines.includes(label === "local" ? "  http://app.example:8443/a/../b/*" : "  https://app.example/a/../b/*")
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand does not promote when control omits the workers_dev opt-out acknowledgement", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-workers-dev-skew-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      ['name = "api"', 'main = "src/index.js"', "workers_dev = false", 'route = "app.example/*"'].join("\n")
    );

    /** @type {RecordedFetch[]} */
    const fetchCalls = [];
    await assert.rejects(
      runDeployCommand([dir, "--ns", "demo", "--control-url", "https://control.example"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: fakeWranglerExecFile,
        controlFetch: async (
          /** @type {string} */ url,
          /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
        ) => {
          fetchCalls.push({ url, init });
          return response({ version: "v1", warnings: [] });
        },
      }),
      (/** @type {Error} */ err) => {
        assert.match(err.message, /control did not confirm workers_dev = false, so nothing was promoted/);
        assert.match(err.message, /the uploaded version was retained/);
        return true;
      }
    );
    assert.equal(fetchCalls.length, 1);
    assert.match(fetchCalls[0].url, /\/deploy$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand fails when promote does not preserve the workers_dev opt-out", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-workers-dev-promote-skew-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      ['name = "api"', 'main = "src/index.js"', "workers_dev = false", 'route = "app.example/*"'].join("\n")
    );

    const { calls: fetchCalls, controlFetch } = deployPromoteFetch(
      { version: "v1", warnings: [], workersDev: false },
      {
        platformDomain: "workers.example",
        workersDev: true,
        urls: {
          platform: "https://demo.workers.example/api/",
          routes: ["https://app.example/*"],
        },
      }
    );
    await assert.rejects(
      runDeployCommand([dir, "--ns", "demo", "--control-url", "https://control.example"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: fakeWranglerExecFile,
        controlFetch,
      }),
      /control promoted the worker without preserving workers_dev = false/
    );
    assert.equal(fetchCalls.length, 2);
    assert.match(fetchCalls[1].url, /\/promote$/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand detects local control by hostname only", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-nonlocal-host-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), 'export default { fetch() { return new Response("ok"); } };');
    writeFileSync(path.join(dir, "wrangler.toml"), ['name = "api"', 'main = "src/index.js"'].join("\n"));

    /** @type {string[]} */
    const lines = [];
    let fetchCount = 0;
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "https://ctl.example/localhost"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (/** @type {string} */ line) => lines.push(/** @type {string} */ line),
      stderr: () => {},
      execFile: (/** @type {string} */ _cmd, /** @type {readonly string[]} */ args) => {
        if (args.includes("--version")) return "wrangler 4.94.0";
        const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice(
          "--outdir=".length
        );
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, "index.js"), 'export default { fetch() { return new Response("ok"); } };');
      },
      controlFetch: async () => {
        fetchCount += 1;
        return fetchCount === 1
          ? response({ version: "v1", warnings: [] })
          : response({ active: true, version: "v1", platformDomain: "workers.example" });
      },
    });

    assert.ok(lines.includes("  https://demo.workers.example/api/"));
    assert.equal(
      lines.some((line) => line.includes("curl -H")),
      false
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand uses the default port from a local control URL", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-test-host-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), 'export default { fetch() { return new Response("ok"); } };');
    writeFileSync(path.join(dir, "wrangler.toml"), ['name = "api"', 'main = "src/index.js"'].join("\n"));

    /** @type {string[]} */
    const lines = [];
    let fetchCount = 0;
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://admin.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (/** @type {string} */ line) => lines.push(/** @type {string} */ line),
      stderr: () => {},
      execFile: (/** @type {string} */ _cmd, /** @type {readonly string[]} */ args) => {
        if (args.includes("--version")) return "wrangler 4.94.0";
        const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice(
          "--outdir=".length
        );
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, "index.js"), 'export default { fetch() { return new Response("ok"); } };');
      },
      controlFetch: async () => {
        fetchCount += 1;
        return fetchCount === 1
          ? response({ version: "v1", warnings: [] })
          : response({ active: true, version: "v1", platformDomain: "workers.local" });
      },
    });

    assert.ok(
      lines.includes("  http://demo.workers.local/api/"),
      "a .test control host without an explicit port uses the http default"
    );
    assert.equal(
      lines.some((line) => line.startsWith("  https://")),
      false,
      "no production https URL for a local deploy"
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects non-scalar vars before bundling", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-vars-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({
        name: "api",
        main: "src/index.js",
        vars: {
          FOO: { nested: true },
        },
      })
    );

    let execCalled = false;
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
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
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({
        name: "api",
        main: "src/index.js",
        vars: {
          [bad]: { nested: true },
        },
      })
    );

    let execCalled = false;
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
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
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({
        name: "api",
        main: "src/index.js",
        vars: {
          __WDL_RESERVED__: "x",
        },
      })
    );

    let execCalled = false;
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
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
    writeFileSync(path.join(dir, "wrangler.json"), '{"name":"api","main":"src/index.js","vars":{"__proto__":"x"}}');

    let execCalled = false;
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
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
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({
        name: "api",
        main: "src/index.js",
        kv_namespaces: [{ binding: "CACHE", id: "kv-cache" }],
        vars: { CACHE: "shadow" },
      })
    );

    let execCalled = false;
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          stdout: () => {},
          stderr: () => {},
          execFile: () => {
            execCalled = true;
          },
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
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({
        name: "api",
        main: "src/index.js",
        assets: { directory: "public" },
        vars: { ASSETS: "shadow" },
      })
    );

    let fetched = false;
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          stdout: () => {},
          stderr: () => {},
          execFile: fakeWranglerExecFile,
          controlFetch: async () => {
            fetched = true;
            return response({ active: true, version: "v2" });
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
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({
        name: "api",
        main: "src/index.js",
        assets: { directory: "public" },
        kv_namespaces: [{ binding: "ASSETS", id: "kv-assets" }],
      })
    );

    let fetched = false;
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          stdout: () => {},
          stderr: () => {},
          execFile: fakeWranglerExecFile,
          controlFetch: async () => {
            fetched = true;
            return response({ active: true, version: "v2" });
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
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({
        name: "api",
        main: "src/index.js",
        assets: { directory: "public" },
      })
    );

    const { calls: fetchCalls, controlFetch } = deployPromoteFetch(
      { version: "v1", warnings: [] },
      { platformDomain: "wdl.sh" }
    );
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: () => {},
      execFile: fakeWranglerExecFile,
      controlFetch,
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
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({
        name: "api",
        main: "src/index.js",
        assets: { directory: "public" },
        vars: { ASSETS: "shadow" },
      })
    );

    let fetched = false;
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          stdout: () => {},
          stderr: () => {},
          execFile: fakeWranglerExecFile,
          controlFetch: async () => {
            fetched = true;
            return response({ active: true, version: "v2" });
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
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({
        name: "api",
        main: "src/index.js",
        env: { [badEnv]: {} },
      })
    );

    /** @type {string[]} */
    const stdoutLines = [];
    await packWranglerProject({
      cwd: root,
      projectDir,
      envName: badEnv,
      stdout: (line = "") => {
        stdoutLines.push(line);
      },
      execFile: /** @type {typeof import("node:child_process").execFileSync} */ (
        (/** @type {string} */ _cmd, /** @type {readonly string[]} */ args = []) => {
          if (args.includes("--version")) return "wrangler 4.94.0";
          const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice(
            "--outdir=".length
          );
          mkdirSync(outDir, { recursive: true });
          writeFileSync(path.join(outDir, "index.js"), "export default {}");
        }
      ),
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
    writeFileSync(
      path.join(dir, "wrangler.json"),
      JSON.stringify({
        name: "api",
        main: badMain,
      })
    );

    await assert.rejects(
      () =>
        packWranglerProject({
          cwd: dir,
          projectDir: ".",
          stdout: () => {},
          execFile: /** @type {typeof import("node:child_process").execFileSync} */ (
            (/** @type {string} */ _cmd, /** @type {readonly string[]} */ args = []) => {
              if (args.includes("--version")) return "wrangler 4.94.0";
              const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice(
                "--outdir=".length
              );
              mkdirSync(outDir, { recursive: true });
              writeFileSync(path.join(outDir, "other.js"), "export default {}");
            }
          ),
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
      execFile: (
        /** @type {string} */ cmd,
        /** @type {readonly string[]} */ args,
        /** @type {ExecFileOpts} */ opts
      ) => {
        execCalls.push({ cmd, args, opts });
        if (args.includes("--version")) return "wrangler 4.94.0";
        const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice(
          "--outdir=".length
        );
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, "index.js"), "export default {}");
      },
      controlFetch: async () => response({ active: true, version: "v1", warnings: [] }),
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
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          stdout: (/** @type {string} */ line) => lines.push(/** @type {string} */ line),
          stderr: () => {},
          execFile: (
            /** @type {string} */ cmd,
            /** @type {readonly string[]} */ args,
            /** @type {ExecFileOpts} */ opts
          ) => {
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
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
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
        return response({ active: true, version: "v2" });
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
      () =>
        runDeployCommand([dir, "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok", WDL_NS: badNs },
          stdout: () => {},
          stderr: (/** @type {string} */ line) => warnings.push(/** @type {string} */ line),
          execFile: fakeWranglerExecFile,
          controlFetch: async () =>
            response(
              {
                error: "deploy_failed",
                message: "missing caller secrets",
                warnings: [
                  {
                    binding: "PAYMENT",
                    platform: "STRIPE",
                    missingCallerSecrets: ["API_KEY"],
                    internalTaskId: "task-secret",
                  },
                ],
              },
              400
            ),
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
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          stdout: () => {},
          stderr: () => {},
          execFile: fakeWranglerExecFile,
          controlFetch: async () =>
            response(
              {
                error: "worker_env_too_large",
                message: "env too large",
                source_version: "v2",
              },
              400
            ),
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
    {
      error: "worker_code_too_large",
      status: 413,
      expected: /reduce generated Worker code size or split the worker/,
    },
    {
      error: "python_workers_unsupported",
      status: 400,
      expected: /Python Workers modules are not supported by WDL/,
    },
  ]) {
    const err = await rejectDeployWithControlBody(
      {
        error,
        message: "control rejected deploy",
      },
      status
    );
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
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          stdout: () => {},
          stderr: () => {},
          execFile: fakeWranglerExecFile,
          controlFetch: async () =>
            response(
              {
                error: "secret_encryption_unconfigured",
                message: "provider missing",
              },
              503
            ),
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
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          stdout: () => {},
          stderr: () => {},
          execFile: fakeWranglerExecFile,
          controlFetch: async () =>
            response(
              {
                error: "worker_code_invalid",
                message: "invalid generated module graph",
              },
              400
            ),
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
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          stdout: () => {},
          stderr: () => {},
          execFile: (/** @type {string} */ _cmd, /** @type {readonly string[]} */ args) => {
            if (args.includes("--version")) return "wrangler 4.94.0";
            const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice(
              "--outdir=".length
            );
            mkdirSync(outDir, { recursive: true });
            writeFileSync(path.join(outDir, "index.js"), "export default {}");
            writeFileSync(path.join(outDir, "_wdl-wrapper.js"), "export default {}");
          },
          controlFetch: async (
            /** @type {string} */ url,
            /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
          ) => {
            fetchCalls.push({ url, init });
            return response(
              {
                error: "worker_code_invalid",
                message: "reserved injected module name",
              },
              400
            );
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
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      ['name = "api"', 'main = "src/index.js"', 'compatibility_flags = ["experimental"]'].join("\n")
    );

    /** @type {RecordedFetch[]} */
    const fetchCalls = [];
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          stdout: () => {},
          stderr: () => {},
          execFile: fakeWranglerExecFile,
          controlFetch: async (
            /** @type {string} */ url,
            /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
          ) => {
            fetchCalls.push({ url, init });
            return response(
              {
                error: "experimental_compat_flag_unsupported",
                message: "unsupported workerd experimental compatibility flag",
              },
              400
            );
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

test("runDeployCommand explains control-rejected unsupported compatibility flags", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-unsupported-flag-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      ['name = "api"', 'main = "src/index.js"', 'compatibility_flags = ["legacy_error_serialization"]'].join("\n")
    );

    /** @type {RecordedFetch[]} */
    const fetchCalls = [];
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          stdout: () => {},
          stderr: () => {},
          execFile: fakeWranglerExecFile,
          controlFetch: async (
            /** @type {string} */ url,
            /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
          ) => {
            fetchCalls.push({ url, init });
            return response(
              {
                error: "compatibility_flag_unsupported",
                message: "unsupported compatibility flag: legacy_error_serialization",
              },
              400
            );
          },
        }),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assert.match(message, /compatibility_flag_unsupported/);
        assert.match(message, /remove the unsupported compatibility flag/);
        return true;
      }
    );

    assert.equal(fetchCalls.length, 1);
    const manifest = JSON.parse(/** @type {string} */ (fetchCalls[0].init.body));
    assert.deepEqual(manifest.compatibilityFlags, ["legacy_error_serialization"]);
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
            warnings: [
              {
                code: "unsupported_option",
                message: "ignored field",
                internalTaskId: "task-secret",
              },
            ],
          });
        }
        return response({ active: true, version: "v2" });
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

for (const { label, promote, rejected, expected } of [
  {
    label: "a 4xx rejection",
    promote: () => response({ error: "version_not_found" }, 404),
    rejected: true,
    expected: /promote failed: 404 version_not_found/,
  },
  {
    label: "an acknowledgement without active",
    promote: () => response({ version: "v9", platformDomain: "workers.example", urls: {} }, 200),
    rejected: false,
    expected: /promote failed: response did not confirm v9 is active/,
  },
  {
    label: "an acknowledgement for a different version",
    promote: () => response({ active: true, version: "v8", platformDomain: "workers.example", urls: {} }, 200),
    rejected: false,
    expected: /promote failed: response did not confirm v9 is active/,
  },
  {
    label: "a 3xx redirect",
    promote: () => response("", 302),
    rejected: false,
    expected: /promote failed: 302/,
  },
  {
    label: "a 2xx body that is not an object",
    promote: () => response(null, 200),
    rejected: false,
    expected: /promote failed: response did not confirm v9 is active/,
  },
  {
    label: "a 5xx response",
    promote: () => response({ error: "promote_failed", message: "routing unavailable" }, 503),
    rejected: false,
    expected: /promote failed: 503 promote_failed: routing unavailable/,
  },
  {
    label: "a transport failure",
    promote: () => {
      throw Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });
    },
    rejected: false,
    expected: /socket hang up/,
  },
  {
    label: "an unreadable 2xx body",
    promote: () => response("<html>truncated", 200),
    rejected: false,
    expected: /promote failed: response is not valid JSON/,
  },
]) {
  test(`runDeployCommand reports the promotion outcome after ${label}`, async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-promote-outcome-"));
    try {
      mkdirSync(path.join(dir, "src"), { recursive: true });
      writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
      writeFileSync(path.join(dir, "wrangler.toml"), 'name = "api"\nmain = "src/index.js"\n');

      /** @type {string[]} */
      const stderrLines = [];
      let fetchCount = 0;
      await assert.rejects(
        () =>
          runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
            env: { ADMIN_TOKEN: "tok" },
            stdout: () => {},
            stderr: (/** @type {string} */ line) => stderrLines.push(line),
            execFile: fakeWranglerExecFile,
            controlFetch: async () => {
              fetchCount += 1;
              if (fetchCount === 1) return response({ version: "v9", warnings: [] });
              return promote();
            },
          }),
        expected
      );

      assert.equal(fetchCount, 2);
      const note = stderrLines.join("");
      // The note states the outcome and nothing else: no command, no name the
      // CLI assembled, no advice.
      assert.equal(
        note,
        rejected
          ? "note: control rejected the promotion, so this version was not activated and traffic is unchanged; " +
              "it may still be retained."
          : "note: the promotion outcome is unknown; control may have promoted this version already."
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

const RESTART_SESSION_POLICY_TOML = [
  'name = "api"',
  'main = "src/index.js"',
  "[wdl]",
  'session_policy = "restart"',
].join("\n");

test("runDeployCommand sends the restart session policy", async (t) => {
  const dir = createDeployProject(t, RESTART_SESSION_POLICY_TOML, "wdl-run-deploy-session-policy-wire-");
  /** @type {string[]} */
  const lines = [];
  const { calls: fetchCalls, controlFetch } = deployPromoteFetch(
    { version: "v3", warnings: [], sessionPolicy: "restart" },
    {
      platformDomain: "workers.example",
      sessionPolicy: "restart",
      restartSequence: 7,
      urls: {},
    }
  );
  await runDeployCommand([dir, "--ns", "demo", "--control-url", "https://control.example"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: (/** @type {string} */ line) => lines.push(line),
    stderr: () => {},
    execFile: fakeWranglerExecFile,
    controlFetch,
  });

  const manifest = JSON.parse(/** @type {string} */ (fetchCalls[0].init.body));
  assert.equal(manifest.sessionPolicy, "restart");
  assert.match(fetchCalls[1].url, /\/promote$/);
  assert.ok(lines.includes("✓ demo/api@v3 live"));
});

test("runDeployCommand inherits a top-level [wdl] into an --env deploy", async (t) => {
  const dir = createDeployProject(
    t,
    [
      'name = "api"',
      'main = "src/index.js"',
      "[wdl]",
      'session_policy = "restart"',
      "[env.prod.vars]",
      'STAGE = "prod"',
    ].join("\n"),
    "wdl-run-deploy-session-policy-env-"
  );
  const { calls: fetchCalls, controlFetch } = deployPromoteFetch(
    { version: "v3", warnings: [], sessionPolicy: "restart" },
    {
      platformDomain: "workers.example",
      sessionPolicy: "restart",
      restartSequence: 3,
      urls: {},
    }
  );
  await runDeployCommand([dir, "--ns", "demo", "--env", "prod", "--control-url", "https://control.example"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: () => {},
    stderr: () => {},
    execFile: fakeWranglerExecFile,
    controlFetch,
  });

  // The env declares no [wdl] of its own, so the policy must survive env
  // resolution and reach the wire.
  const manifest = JSON.parse(/** @type {string} */ (fetchCalls[0].init.body));
  assert.equal(manifest.sessionPolicy, "restart");
  assert.match(fetchCalls[1].url, /\/promote$/);
});

test("runDeployCommand sends the env's own [wdl] instead of the top-level one", async (t) => {
  const dir = createDeployProject(
    t,
    [
      'name = "api"',
      'main = "src/index.js"',
      "[wdl]",
      'session_policy = "restart"',
      "[env.prod.wdl]",
      'session_policy = "preserve"',
    ].join("\n"),
    "wdl-run-deploy-session-policy-env-override-"
  );
  const { calls: fetchCalls, controlFetch } = deployPromoteFetch(
    { version: "v3", warnings: [] },
    { platformDomain: "workers.example", urls: {} }
  );
  await runDeployCommand([dir, "--ns", "demo", "--env", "prod", "--control-url", "https://control.example"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: () => {},
    stderr: () => {},
    execFile: fakeWranglerExecFile,
    controlFetch,
  });

  // The env overrides the top-level restart with preserve, so nothing about
  // the policy may reach the wire.
  const manifest = JSON.parse(/** @type {string} */ (fetchCalls[0].init.body));
  assert.equal(manifest.sessionPolicy, undefined);
  assert.match(fetchCalls[1].url, /\/promote$/);
});

test("runDeployCommand does not promote when control omits the restart session policy acknowledgement", async (t) => {
  const dir = createDeployProject(t, RESTART_SESSION_POLICY_TOML, "wdl-run-deploy-session-policy-skew-");
  /** @type {RecordedFetch[]} */
  const fetchCalls = [];
  await assert.rejects(
    runDeployCommand([dir, "--ns", "demo", "--control-url", "https://control.example"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: () => {},
      execFile: fakeWranglerExecFile,
      controlFetch: async (
        /** @type {string} */ url,
        /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
      ) => {
        fetchCalls.push({ url, init });
        return response({ version: "v3", warnings: [] });
      },
    }),
    (/** @type {Error} */ err) => {
      assert.match(err.message, /control did not confirm session_policy = restart, so nothing was promoted/);
      assert.match(err.message, /the uploaded version was retained/);
      return true;
    }
  );
  assert.equal(fetchCalls.length, 1);
  assert.match(fetchCalls[0].url, /\/deploy$/);
});

for (const { label, promoteBody } of [
  { label: "a non-positive sequence", promoteBody: { sessionPolicy: "restart", restartSequence: 0 } },
  { label: "no policy echo", promoteBody: { restartSequence: 7 } },
  { label: "no sequence", promoteBody: { sessionPolicy: "restart" } },
]) {
  test(`runDeployCommand fails when the promote response carries ${label}`, async (t) => {
    const dir = createDeployProject(t, RESTART_SESSION_POLICY_TOML, "wdl-run-deploy-session-policy-promote-skew-");
    const { calls: fetchCalls, controlFetch } = deployPromoteFetch(
      { version: "v3", warnings: [], sessionPolicy: "restart" },
      { platformDomain: "workers.example", urls: {}, ...promoteBody }
    );
    await assert.rejects(
      runDeployCommand([dir, "--ns", "demo", "--control-url", "https://control.example"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: fakeWranglerExecFile,
        controlFetch,
      }),
      /without confirming its restart session policy/
    );
    assert.equal(fetchCalls.length, 2);
    assert.match(fetchCalls[1].url, /\/promote$/);
  });
}

test("runDeployCommand keeps the default policy off the wire", async (t) => {
  const dir = createDeployProject(
    t,
    ['name = "api"', 'main = "src/index.js"'].join("\n"),
    "wdl-run-deploy-preserve-summary-"
  );
  /** @type {string[]} */
  const lines = [];
  const { calls: fetchCalls, controlFetch } = deployPromoteFetch(
    { version: "v4", warnings: [] },
    {
      platformDomain: "workers.example",
      sessionPolicy: "preserve",
      restartSequence: 5,
      urls: {},
    }
  );
  await runDeployCommand([dir, "--ns", "demo", "--control-url", "https://control.example"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: (/** @type {string} */ line) => lines.push(line),
    stderr: () => {},
    execFile: fakeWranglerExecFile,
    controlFetch,
  });

  const manifest = JSON.parse(/** @type {string} */ (fetchCalls[0].init.body));
  assert.equal(manifest.sessionPolicy, undefined, "the default policy must stay off the wire");
  assert.ok(lines.includes("✓ demo/api@v4 live"));
});

test("runDeployCommand warns that DO named entrypoints must be declared exports", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-do-warning-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export class Room {}; export default {}");
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      `
name = "chat"
main = "src/index.js"

[[durable_objects.bindings]]
name = "ROOMS"
class_name = "Room"

[[migrations]]
tag = "v1"
new_classes = ["Room"]
`
    );

    /** @type {string[]} */
    const warnings = [];
    let fetchCount = 0;
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: (/** @type {string} */ line) => warnings.push(/** @type {string} */ line),
      execFile: (/** @type {string} */ _cmd, /** @type {readonly string[]} */ args) => {
        if (args.includes("--version")) return "wrangler 4.94.0";
        const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice(
          "--outdir=".length
        );
        mkdirSync(outDir, { recursive: true });
        writeFileSync(path.join(outDir, "index.js"), "export class Room {}; export default {}");
      },
      controlFetch: async () => {
        fetchCount += 1;
        return fetchCount === 1 ? response({ version: "v1" }) : response({ active: true, version: "v1" });
      },
    });

    assert.equal(warnings.length, 1);
    assert.match(
      warnings[0],
      /Durable Object workers expose named WorkerEntrypoint classes only when listed in \[\[exports\]\]/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("runDeployCommand rejects workflow binding collisions before bundling", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-run-deploy-workflow-collision-"));
  try {
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      `
name = "api"
main = "src/index.js"

[[kv_namespaces]]
binding = "FLOW"
id = "sessions"

[[workflows]]
name = "flow"
binding = "FLOW"
class_name = "Flow"
`
    );
    let execCalled = false;
    await assert.rejects(
      runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: () => {
          execCalled = true;
        },
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
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      `
name = "api"
main = "src/index.js"

[[kv_namespaces]]
binding = "SHARED"
id = "sessions"

[[platform_bindings]]
binding = "SHARED"
`
    );
    let execCalled = false;
    await assert.rejects(
      runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        stderr: () => {},
        execFile: () => {
          execCalled = true;
        },
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

    const { calls: fetchCalls, controlFetch } = deployPromoteFetch(
      { version: "v1", warnings: [] },
      { platformDomain: "wdl.sh" }
    );
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: () => {},
      execFile: fakeWranglerExecFile,
      controlFetch,
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
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      'name = "api"\nmain = "src/index.js"\n\n[assets]\ndirectory = "./public"\n'
    );

    /** @type {string[]} */
    const stderrLines = [];
    const { calls: fetchCalls, controlFetch } = deployPromoteFetch(
      { version: "v1", warnings: [] },
      { platformDomain: "wdl.sh" }
    );
    await runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      stderr: (/** @type {string} */ line) => stderrLines.push(/** @type {string} */ line),
      execFile: fakeWranglerExecFile,
      controlFetch,
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
        return response({ active: true, version: "v1\u001b[2J", platformDomain: "wdl.sh" });
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
    writeFileSync(
      path.join(dir, "wrangler.toml"),
      'name = "api"\nmain = "src/index.js"\n\n[[kv_namespaces]]\nbinding = "bad-kv"\nid = "x"\n'
    );
    let execCalled = false;
    await assert.rejects(
      () =>
        runDeployCommand([dir, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          stdout: () => {},
          stderr: () => {},
          execFile: () => {
            execCalled = true;
          },
          controlFetch: async () => response({}),
        }),
      /\[\[kv_namespaces\]\] bad-kv: binding must match/
    );
    assert.equal(execCalled, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
