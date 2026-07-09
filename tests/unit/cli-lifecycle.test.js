import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runDeleteCommand } from "../../commands/delete.js";
import { runR2Command } from "../../commands/r2.js";
import { runSecretCommand } from "../../commands/secret.js";
import { SSE_MAX_LINE_CHARS, SseParser, runTailCommand } from "../../commands/tail.js";
import { runWorkersCommand, formatWorkersList } from "../../commands/workers.js";
import { runWorkflowsCommand } from "../../commands/workflows.js";
import { main as wdlMain } from "../../bin/wdl.js";
import { CliError, readJsonOrFail } from "../../lib/common.js";
import {
  LONG_CONTROL_TIMEOUT_MS,
  UNLIMITED_CONTROL_BODY_BYTES,
} from "../../lib/control-fetch.js";
import { ESC, assertNoRawTerminalControls, mockDeps, response } from "./helpers.js";

/** @typedef {import("./helpers.js").ControlCall} ControlCall */

/** @param {unknown} err */
function assertEscapedBadArg(err) {
  const message = /** @type {Error} */ (err).message;
  assertNoRawTerminalControls(message, "CLI errors");
  assert.match(message, /bad\\u001b\[2J\\nFORGED\\rBAD/);
  return true;
}

/**
 * The options bag the dispatcher passes to an injected `loadEnv`. Matches the
 * third parameter of `loadCliDotEnv`.
 * @typedef {NonNullable<Parameters<typeof import("../../lib/credentials.js").loadCliDotEnv>[2]>} LoadEnvOptions
 */

/**
 * The `loadEnv` override shape accepted by `wdlMain`. The test fakes record the
 * options and otherwise ignore the contract return value.
 * @typedef {typeof import("../../lib/credentials.js").loadCliDotEnv} LoadEnvFn
 */

/** @param {string} value */
function stdinFrom(value) {
  const stdin = Object.assign(new EventEmitter(), {
    /** @param {string} _encoding */
    setEncoding(_encoding) {},
  });
  queueMicrotask(() => {
    stdin.emit("data", value);
    stdin.emit("end");
  });
  return stdin;
}

/** @param {string} value */
function ttyStdinLine(value) {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    paused: false,
    /** @param {string} _encoding */
    setEncoding(_encoding) {},
    /** @param {boolean} _mode */
    setRawMode(_mode) {}, // a real TTY has this; hidden input requires it
    pause() {
      this.paused = true;
    },
  });
  queueMicrotask(() => {
    stdin.emit("data", value);
  });
  return stdin;
}

test("readJsonOrFail compacts structured control errors", async () => {
  const errBody = {
    error: "d1_database_initialize_failed",
    namespace: "demo",
    databaseId: "d1_test",
    message: "D1 backend is unavailable: internal error; reference = ref-1",
    upstreamCode: "backend-unavailable",
    upstreamCategory: "internal",
    upstreamRetryable: true,
    upstreamStatus: 503,
    detail: {
      success: false,
      error: "backend-unavailable",
      message: "D1 backend is unavailable: internal error; reference = ref-1",
      category: "internal",
      retryable: true,
    },
  };

  await assert.rejects(
    () => readJsonOrFail(response(errBody, 503), "create d1 database"),
    {
      message: "create d1 database failed: 503 d1_database_initialize_failed: D1 backend is unavailable: internal error; reference = ref-1 namespace=demo databaseId=d1_test upstreamCode=backend-unavailable upstreamCategory=internal upstreamRetryable=true upstreamStatus=503",
    }
  );
});

test("readJsonOrFail keeps diagnostic blockers in compact errors", async () => {
  const blockers = [{
    version: "v2",
    referrers: [{
      callerNs: "foo",
      callerWorker: "caller",
      callerVersion: "v1",
      binding: "API",
    }],
  }];

  await assert.rejects(
    () => readJsonOrFail(response({
      error: "version_referenced",
      namespace: "foo",
      name: "bar",
      blockers,
    }, 409), "delete worker"),
    {
      message: `delete worker failed: 409 version_referenced namespace=foo name=bar blockers=${JSON.stringify(blockers)}`,
    }
  );
});

test("readJsonOrFail formats control error-code plus message convention", async () => {
  await assert.rejects(
    () => readJsonOrFail(response({
      error: "invalid_request",
      message: "Body must be { value: string }",
    }, 400), "put secret"),
    {
      message: "put secret failed: 400 invalid_request: Body must be { value: string }",
    }
  );
});

test("readJsonOrFail avoids duplicate context when structured error has no summary field", async () => {
  await assert.rejects(
    () => readJsonOrFail(response({ host: "demo.workers.example", slot: "/" }, 409), "promote"),
    { message: 'promote failed: 409 {"host":"demo.workers.example","slot":"/"}' }
  );
});

test("readJsonOrFail quotes context values containing whitespace", async () => {
  await assert.rejects(
    () => readJsonOrFail(response({
      error: "bad_trace",
      traceId: "abc def ghi",
    }, 400), "deploy"),
    { message: 'deploy failed: 400 bad_trace traceId="abc def ghi"' }
  );
});

test("readJsonOrFail escapes decoded terminal control bytes in structured errors", async () => {
  await assert.rejects(
    () => readJsonOrFail(response({
      error: "bad\u001b[31m",
      message: "line1\nline2",
      traceId: "osc\u001b]0;pwn\u0007",
    }, 400), "deploy"),
    {
      message: "deploy failed: 400 bad\\u001b[31m: line1\\nline2 traceId=osc\\u001b]0;pwn\\u0007",
    }
  );
});

test("readJsonOrFail preserves non-json response bodies", async () => {
  await assert.rejects(
    () => readJsonOrFail({
      status: 502,
      ok: false,
      text: async () => "bad gateway",
    }, "deploy"),
    { message: "deploy failed: 502 bad gateway" }
  );
});

test("readJsonOrFail includes redirect locations in HTTP errors", async () => {
  await assert.rejects(
    () => readJsonOrFail({
      status: 302,
      ok: false,
      headers: { location: "https://login.example/\u001b[31m" },
      text: async () => "",
    }, "whoami"),
    { message: "whoami failed: 302 location=https://login.example/\\u001b[31m" }
  );
});

test("readJsonOrFail wraps invalid JSON from successful responses", async () => {
  await assert.rejects(
    () => readJsonOrFail(response("not-json"), "deploy"),
    /deploy failed: response is not valid JSON/
  );
});

test("nsUrl rejects dot path segments before calling control", async () => {
  await assert.rejects(
    () => runSecretCommand(["list", "--ns", ".", "--scope", "ns", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      controlFetch: async () => {
        throw new Error("controlFetch should not be called");
      },
    }),
    /invalid URL path segment: "\."/
  );
});

test("readJsonOrFail surfaces warnings arrays attached to error bodies", async () => {
  const warnings = [{ code: "assets_cleanup_task_failed", message: "queue full" }];

  await assert.rejects(
    () => readJsonOrFail(response({
      error: "asset_upload_failed",
      message: "Asset upload failed for logo.png",
      warnings,
    }, 502), "deploy"),
    {
      message: `deploy failed: 502 asset_upload_failed: Asset upload failed for logo.png warnings=${JSON.stringify(warnings)}`,
    }
  );
});

test("commands warn when the admin token would travel over plain http to a non-local host", async () => {
  /** @type {string[]} */
  const warnings = [];
  await runWorkersCommand(["--ns", "demo", "--control-url", "http://ctl.prod.example"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: () => {},
    warn: (/** @type {string} */ line) => warnings.push(line),
    controlFetch: async () => response({ workers: [] }),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /plain http on a non-local host/);

  /** @type {string[]} */
  const quiet = [];
  await runWorkersCommand(["--ns", "demo", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: () => {},
    warn: (/** @type {string} */ line) => quiet.push(line),
    controlFetch: async () => response({ workers: [] }),
  });
  assert.deepEqual(quiet, []);

  /** @type {string[]} */
  const connectWarnings = [];
  await runWorkersCommand(["--ns", "demo", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok", CONTROL_CONNECT_HOST: "control.prod.example" },
    stdout: () => {},
    warn: (/** @type {string} */ line) => connectWarnings.push(line),
    controlFetch: async () => response({ workers: [] }),
  });
  assert.equal(connectWarnings.length, 1);
  assert.match(connectWarnings[0], /CONTROL_CONNECT_HOST=control\.prod\.example is non-local/);
});

test("workers command lists namespace worker state", async () => {
  const body = {
    namespace: "demo",
    workers: [
      { name: "api", activeVersion: "v2", versions: ["v1", "v2"], hasSecrets: true },
    ],
  };
  const { calls, lines, deps } = mockDeps(body);

  await runWorkersCommand(["--ns", "demo", "--control-url", "http://ctl.test"], deps);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/workers");
  assert.deepEqual(/** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ (calls[0].init).headers, { "x-admin-token": "tok" });
  assert.deepEqual(lines, ["api\tactive=v2\tversions=v1,v2\tsecrets=yes"]);
});

test("workers command does not double-slash paths when CONTROL_URL has a trailing slash", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  await runWorkersCommand(["--ns", "demo"], {
    env: {
      ADMIN_TOKEN: "tok",
      CONTROL_URL: "http://ctl.test/",
    },
    stdout: () => {},
    controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
      calls.push({ url, init });
      return response({ namespace: "demo", workers: [] });
    },
  });

  assert.equal(calls[0].url, "http://ctl.test/ns/demo/workers");
});

test("workers command rejects unexpected positional arguments", async () => {
  await assert.rejects(
    () => runWorkersCommand(["demo"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      controlFetch: async () => response({ namespace: "demo", workers: [] }),
    }),
    /Usage:/
  );
});

test("wdl workers escapes control sequences from the control plane but keeps tab columns", async () => {
  /** @type {string[]} */
  const lines = [];
  await runWorkersCommand(["--ns", "demo", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: (/** @type {string} */ line) => lines.push(line),
    controlFetch: async () => response({
      workers: [{ name: "ev\u001bil", activeVersion: "v1", versions: ["v1"], hasSecrets: false }],
    }),
  });
  const out = lines.join("\n");
  assert.ok(!out.includes("\u001b"), "raw ESC must not reach the terminal");
  assert.ok(out.includes("ev\\u001bil"), "worker name must be escaped");
  assert.ok(out.includes("\t"), "tab column separators must be preserved");
});

test("formatWorkersList handles empty and deploy-only entries", () => {
  assert.deepEqual(formatWorkersList({ workers: [] }), ["(no workers)"]);
  // NOTE: lib/workers-format.js types `activeVersion` as `string | undefined`,
  // but the control plane (and this test) sends `null` for an undeployed
  // worker. `formatWorkersList` handles it (`w.activeVersion || "-"`); the
  // typedef just omits `null`. Cast through the real param type so the test
  // keeps exercising the null path without widening the lib type here.
  assert.deepEqual(
    formatWorkersList(/** @type {Parameters<typeof formatWorkersList>[0]} */ (
      /** @type {unknown} */ ({
        workers: [{ name: "draft", activeVersion: null, versions: ["v1"], hasSecrets: false }],
      })
    )),
    ["draft\tactive=-\tversions=v1\tsecrets=no"]
  );
});

test("tenant lifecycle commands default namespace from WDL_NS", async () => {
  /** @type {ControlCall[]} */
  const workerCalls = [];
  await runWorkersCommand(["--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
    stdout: () => {},
    controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
      workerCalls.push({ url, init });
      return response({ namespace: "demo", workers: [] });
    },
  });
  assert.equal(workerCalls[0].url, "http://ctl.test/ns/demo/workers");

  /** @type {ControlCall[]} */
  const secretCalls = [];
  await runSecretCommand(["list", "--worker", "api", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
    stdout: () => {},
    controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
      secretCalls.push({ url, init });
      return response({ keys: [] });
    },
  });
  assert.equal(secretCalls[0].url, "http://ctl.test/ns/demo/worker/api/secrets");

  /** @type {ControlCall[]} */
  const deleteCalls = [];
  await runDeleteCommand(["version", "api", "v1", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
    stdout: () => {},
    controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
      deleteCalls.push({ url, init });
      return response({
        namespace: "demo",
        name: "api",
        version: "v1",
        deleted: true,
      });
    },
  });
  assert.equal(deleteCalls[0].url, "http://ctl.test/ns/demo/worker/api/versions/v1");
});

test("delete version calls the version hard-delete endpoint", async () => {
  const { calls, lines, deps } = mockDeps({
    namespace: "demo",
    name: "api",
    version: "v1",
    deleted: true,
    assets: { cleanupTaskId: null, skippedSharedPrefix: false, warnings: [] },
  });

  await runDeleteCommand(
    ["version", "--ns", "demo", "api", "v1", "--control-url", "http://ctl.test"],
    deps
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/worker/api/versions/v1");
  assert.equal(/** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ (calls[0].init).method, "DELETE");
  assert.deepEqual(lines, ["OK demo/api@v1 deleted"]);
});

test("delete output does not expose internal cleanup task ids", async () => {
  const { lines, deps } = mockDeps({
    namespace: "demo",
    name: "api",
    activeDeleted: "v1",
    versionsDeleted: ["v1"],
    deleted: true,
    assets: { cleanupTaskId: "s3cleanup:internal", queueHint: "sent", warnings: [] },
  });

  await runDeleteCommand(
    ["worker", "--ns", "demo", "api", "--yes", "--control-url", "http://ctl.test"],
    deps
  );

  assert.equal(lines.some((line) => line.includes("s3cleanup:internal")), false);
  assert.equal(lines.some((line) => line.includes("cleanup task")), false);
});

test("delete output projects asset warnings before printing", async () => {
  const { lines, deps } = mockDeps({
    namespace: "demo",
    name: "api",
    activeDeleted: "v1",
    versionsDeleted: ["v1"],
    deleted: true,
    assets: {
      warnings: [{
        code: "asset_cleanup_skipped",
        message: "cleanup skipped",
        internalTaskId: "s3cleanup:internal",
      }],
    },
  });

  await runDeleteCommand(
    ["worker", "--ns", "demo", "api", "--yes", "--control-url", "http://ctl.test"],
    deps
  );

  assert.equal(
    lines.some((line) => line.includes('{"code":"asset_cleanup_skipped","message":"cleanup skipped"}')),
    true,
  );
  assert.equal(lines.some((line) => line.includes("s3cleanup:internal")), false);
});

test("delete worker supports dry-run query and raw json output", async () => {
  const body = {
    dryRun: true,
    namespace: "demo",
    name: "api",
    deleted: true,
    activeDeleted: "v2",
    versionsDeleted: ["v1", "v2"],
    affectedHosts: ["demo.workers.example"],
    queueConsumersRemoved: 1,
    hasWorkerSecrets: true,
  };
  const { calls, lines, deps } = mockDeps(body);

  await runDeleteCommand(
    ["worker", "--ns", "demo", "api", "--dry-run", "--json", "--control-url", "http://ctl.test"],
    deps
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/worker/api/delete?dry_run=1");
  assert.equal(/** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ (calls[0].init).method, "POST");
  assert.deepEqual(lines, [JSON.stringify(body, null, 2)]);
});

test("delete worker dry-run renders workflow blockers in human output", async () => {
  const hostile = `bad${ESC}[2J\nFORGED\rBAD`;
  const body = {
    dryRun: true,
    namespace: `demo-${hostile}`,
    name: `api-${hostile}`,
    deleted: false,
    activeDeleted: `v2-${hostile}`,
    versionsDeleted: [`v1-${hostile}`],
    affectedHosts: [`host-${hostile}.example`],
    blockers: [{
      version: `v1-${hostile}`,
      referrers: [{
        callerNs: `ns-${hostile}`,
        callerWorker: `worker-${hostile}`,
        callerVersion: `version-${hostile}`,
        binding: `binding-${hostile}`,
      }],
    }],
    workflowBlocker: {
      error: `workflow_instances_active-${hostile}`,
      message: `demo/api has active workflow instances ${hostile}`,
      count: 1,
      blockers: [{ workflowKey: `wf-${hostile}`, instanceId: `inst-${hostile}` }],
    },
  };
  const { lines, deps } = mockDeps(body);

  await runDeleteCommand(
    ["worker", "--ns", "demo", "api", "--dry-run", "--control-url", "http://ctl.test"],
    deps
  );

  const joined = lines.join("\n");
  assert.doesNotMatch(joined, new RegExp(ESC), "raw ESC must not reach delete dry-run output");
  assert.doesNotMatch(joined, /\nFORGED|\rBAD/, "raw line controls must not forge delete dry-run output");
  assert.ok(lines.some((line) => /workflow blocker/.test(line)));
  assert.match(joined, /DRY RUN demo-bad\\u001b\[2J\\nFORGED\\rBAD\/api-bad\\u001b\[2J\\nFORGED\\rBAD/);
  assert.match(joined, /affected hosts: host-bad\\u001b\[2J\\nFORGED\\rBAD\.example/);
  assert.match(joined, /binding=binding-bad\\u001b\[2J\\nFORGED\\rBAD/);
  assert.match(joined, /workflow_instances_active-bad\\u001b\[2J\\nFORGED\\rBAD/);
  assert.match(joined, /wf-bad\\u001b\[2J\\nFORGED\\rBAD instance=inst-bad\\u001b\[2J\\nFORGED\\rBAD/);
});

test("delete worker requires confirmation unless --yes or --dry-run is used", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  await assert.rejects(
    () => runDeleteCommand(["worker", "--ns", "demo", "api", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdin: stdinFrom(""),
      controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
        calls.push({ url, init });
        return response({});
      },
    }),
    /Refusing to delete worker "demo\/api" without interactive confirmation/
  );
  assert.equal(calls.length, 0);

  await runDeleteCommand(["worker", "--ns", "demo", "api", "--yes", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: () => {},
    controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
      calls.push({ url, init });
      return response({
        namespace: "demo",
        name: "api",
        deleted: true,
        versionsDeleted: ["v1"],
      });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/worker/api/delete");
});

test("delete worker proceeds after interactive confirmation", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const prompts = [];
  const stdin = ttyStdinLine("yes\n");

  await runDeleteCommand(["worker", "--ns", "demo", "api", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdin,
    stderr: (/** @type {string} */ text) => prompts.push(text),
    stdout: () => {},
    controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
      calls.push({ url, init });
      return response({
        namespace: "demo",
        name: "api",
        deleted: true,
        versionsDeleted: ["v1"],
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(prompts, ['Are you sure you want to delete worker "demo/api"? [y/N] ']);
  assert.equal(stdin.paused, true);
});

test("delete command exposes only documented destructive subcommands", async () => {
  await assert.rejects(
    () => runDeleteCommand(["ver", "--ns", "demo", "api", "v1"], {
      env: { ADMIN_TOKEN: "tok" },
      controlFetch: async () => response({}),
    }),
    /unknown subcommand: ver/
  );
  await assert.rejects(
    () => runDeleteCommand(["rm", "--ns", "demo", "api"], {
      env: { ADMIN_TOKEN: "tok" },
      controlFetch: async () => response({}),
    }),
    /unknown subcommand: rm/
  );
});

test("delete command rejects unexpected positional arguments", async () => {
  const deps = {
    env: { ADMIN_TOKEN: "tok" },
    controlFetch: async () => {
      throw new Error("controlFetch should not be called");
    },
  };
  await assert.rejects(
    () => runDeleteCommand(["version", "--ns", "demo", "api", "v1", "extra"], deps),
    /delete version received unexpected argument: extra/
  );
  await assert.rejects(
    () => runDeleteCommand(["worker", "--ns", "demo", "--worker", "api", "extra"], deps),
    /delete worker received unexpected argument: extra/
  );
});

test("commands escape terminal controls in unexpected positional errors", async () => {
  const bad = `bad${ESC}[2J\nFORGED\rBAD`;
  const deps = {
    env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
    controlFetch: async () => {
      throw new Error("controlFetch should not be called");
    },
  };

  await assert.rejects(
    () => runDeleteCommand(["version", "--ns", "demo", "api", "v1", bad], deps),
    assertEscapedBadArg,
  );
  await assert.rejects(
    () => runSecretCommand(["list", "--ns", "demo", "--scope", "ns", bad], deps),
    assertEscapedBadArg,
  );
  await assert.rejects(
    () => runR2Command(["buckets", "list", bad, "--ns", "demo"], deps),
    assertEscapedBadArg,
  );
  await assert.rejects(
    () => runWorkflowsCommand(["list", "--ns", "demo", bad], deps),
    assertEscapedBadArg,
  );
});

test("secret list accepts flags before the subcommand", async () => {
  const { calls, deps } = mockDeps({ keys: [] });

  await runSecretCommand(["--ns", "demo", "--worker", "api", "--control-url", "http://ctl.test", "list"], deps);

  assert.equal(calls[0].url, "http://ctl.test/ns/demo/worker/api/secrets");
});

test("secret list uses encoded namespace and worker path segments", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  await runSecretCommand(
    ["list", "--ns", "demo space", "--worker", "api/slash", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (/** @type {string} */ line) => lines.push(line),
      controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
        calls.push({ url, init });
        return response({ keys: ["A", "B"] });
      },
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo%20space/worker/api%2Fslash/secrets");
  assert.deepEqual(calls[0].init.headers, { "x-admin-token": "tok" });
  assert.deepEqual(lines, ["A", "B"]);
});

test("secret list supports raw json output", async () => {
  /** @type {string[]} */
  const lines = [];
  await runSecretCommand(
    ["list", "--json", "--ns", "demo", "--scope", "ns", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (/** @type {string} */ line) => lines.push(line),
      controlFetch: async () => response({ namespace: "demo", keys: ["A", "B"] }),
    }
  );

  assert.deepEqual(lines, [JSON.stringify({ namespace: "demo", keys: ["A", "B"] }, null, 2)]);
});

test("secret list tolerates a response without a keys array", async () => {
  /** @type {string[]} */
  const lines = [];
  await runSecretCommand(
    ["list", "--ns", "demo", "--scope", "ns", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (/** @type {string} */ line) => lines.push(line),
      controlFetch: async () => response({ namespace: "demo" }),
    }
  );
  assert.deepEqual(lines, ["(no secrets)"]);
});

test("secret put reads stdin, trims one newline, and encodes key", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  await runSecretCommand(
    ["put", "--ns", "demo", "--scope", "ns", "KEY/ONE", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok", CONTROL_CONNECT_HOST: "127.0.0.1:18080" },
      stdin: stdinFrom("secret-value\n"),
      stdout: (/** @type {string} */ line) => lines.push(line),
      controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
        calls.push({ url, init });
        return response({ deleted: false });
      },
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/secrets/KEY%2FONE");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.env?.CONTROL_CONNECT_HOST, "127.0.0.1:18080");
  assert.equal(calls[0].init.body, JSON.stringify({ value: "secret-value" }));
  assert.deepEqual(lines, ["✓ demo (ns)/KEY/ONE set — effect on next natural cold-load"]);
});

test("secret put escapes terminal controls from a raw keyArg in the status line", async () => {
  const esc = String.fromCharCode(27);
  /** @type {string[]} */
  const lines = [];
  await runSecretCommand(
    ["put", "--ns", "demo", "--scope", "ns", `KEY${esc}[2J`, "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdin: stdinFrom("v\n"),
      stdout: (/** @type {string} */ line) => lines.push(line),
      controlFetch: async () => response({ deleted: false }),
    }
  );
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], new RegExp(esc), "raw ESC from keyArg must not reach stdout");
});

test("secret put reads one tty line without waiting for EOF", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const prompts = [];
  const stdin = ttyStdinLine("typed-value\n");
  await runSecretCommand(
    ["put", "--ns", "demo", "--scope", "ns", "KEY", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdin,
      stdout: () => {},
      stderr: (/** @type {string} */ text) => prompts.push(text),
      controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
        calls.push({ url, init });
        return response({ deleted: false });
      },
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.body, JSON.stringify({ value: "typed-value" }));
  // The prompt, then a newline written when raw (hidden) mode is restored.
  assert.deepEqual(prompts, ["Enter secret value for demo (ns)/KEY (input hidden): ", "\n"]);
  assert.equal(stdin.paused, true);
});

test("secret put reports worker version promotion", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  await runSecretCommand(
    ["put", "--ns", "demo", "--worker", "api", "KEY", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdin: stdinFrom("secret-value\n"),
      stdout: (/** @type {string} */ line) => lines.push(line),
      controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
        calls.push({ url, init });
        return response({ previousVersion: "v1", version: "v2" });
      },
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/worker/api/secrets/KEY");
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(lines, ["✓ demo/api/KEY set — promoted v1 → v2"]);
});

test("secret put explains env-budget failures as unwritten mutations", async () => {
  await assert.rejects(
    () => runSecretCommand(
      ["put", "--ns", "demo", "--scope", "ns", "KEY", "--control-url", "http://ctl.test"],
      {
        env: { ADMIN_TOKEN: "tok" },
        stdin: stdinFrom("secret-value\n"),
        controlFetch: async () => response({
          error: "worker_env_too_large",
          message: "env too large",
          source_version: "v2",
          estimated_version: "v9007199254740991",
        }, 400),
      }
    ),
    (err) => {
      const message = /** @type {Error} */ (err).message;
      assert.match(message, /worker_env_too_large/);
      assert.match(message, /secret mutation was not written/);
      assert.match(message, /source_version=v2/);
      assert.match(message, /estimated_version=v9007199254740991/);
      return true;
    }
  );
});

test("secret mutation errors explain retry and operator-repair cases", async () => {
  for (const error of ["secret_mutation_contention", "namespace_secret_mutation_contention"]) {
    await assert.rejects(
      () => runSecretCommand(
        ["delete", "--ns", "demo", "--worker", "api", "KEY", "--yes", "--control-url", "http://ctl.test"],
        {
          env: { ADMIN_TOKEN: "tok" },
          controlFetch: async () => response({
            error,
            message: "active version changed",
          }, 503),
        }
      ),
      /Retry after concurrent worker metadata updates settle/
    );
  }
  for (const error of [
    "invalid_envelope",
    "secret_decrypt_failed",
    "secret_encryption_unconfigured",
    "secret_not_encrypted",
    "unsupported_envelope",
    "unknown_kid",
  ]) {
    await assert.rejects(
      () => runSecretCommand(
        ["delete", "--ns", "demo", "--scope", "ns", "KEY", "--yes", "--control-url", "http://ctl.test"],
        {
          env: { ADMIN_TOKEN: "tok" },
          controlFetch: async () => response({
            error,
            message: "bad envelope",
          }, 503),
        }
      ),
      /Secret-envelope configuration or stored secret data needs operator repair/
    );
  }
});

test("secret put and delete support raw json output", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const putLines = [];
  await runSecretCommand(
    ["put", "--json", "--ns", "demo", "--worker", "api", "KEY", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdin: stdinFrom("secret-value\n"),
      stdout: (/** @type {string} */ line) => putLines.push(line),
      controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
        calls.push({ url, init });
        return response({ previousVersion: "v1", version: "v2" });
      },
    }
  );
  assert.deepEqual(putLines, [JSON.stringify({ previousVersion: "v1", version: "v2" }, null, 2)]);

  /** @type {string[]} */
  const deleteLines = [];
  await runSecretCommand(
    ["delete", "--json", "--ns", "demo", "--worker", "api", "KEY", "--yes", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (/** @type {string} */ line) => deleteLines.push(line),
      controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
        calls.push({ url, init });
        return response({ deleted: true, previousVersion: "v2", version: "v3" });
      },
    }
  );
  assert.deepEqual(deleteLines, [JSON.stringify({ deleted: true, previousVersion: "v2", version: "v3" }, null, 2)]);
});

test("secret list refuses ambiguous scope before calling control", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  await assert.rejects(
    () => runSecretCommand(["list", "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
        calls.push({ url, init });
        return response({});
      },
    }),
    /must specify either --worker <name> \(worker-level\) or --scope ns \(ns-level\)/
  );

  assert.equal(calls.length, 0);
});

test("secret list and delete reject unexpected positional arguments", async () => {
  const deps = {
    env: { ADMIN_TOKEN: "tok" },
    controlFetch: async () => {
      throw new Error("controlFetch should not be called");
    },
  };
  await assert.rejects(
    () => runSecretCommand(["list", "--ns", "demo", "--scope", "ns", "extra"], deps),
    /secret list received unexpected argument: extra/
  );
  await assert.rejects(
    () => runSecretCommand(["delete", "--ns", "demo", "--scope", "ns", "KEY", "extra", "--yes"], deps),
    /secret delete received unexpected argument: extra/
  );
});

test("secret delete calls worker endpoint and reports promoted bump", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  await runSecretCommand(
    ["delete", "--ns", "demo", "--worker", "api", "KEY", "--yes", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (/** @type {string} */ line) => lines.push(line),
      controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
        calls.push({ url, init });
        return response({ deleted: true, previousVersion: "v1", version: "v2" });
      },
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/worker/api/secrets/KEY");
  assert.equal(calls[0].init.method, "DELETE");
  assert.deepEqual(lines, ["✓ demo/api/KEY deleted — promoted v1 → v2"]);
});

test("secret delete requires confirmation unless --yes is used", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  await assert.rejects(
    () => runSecretCommand(["delete", "--ns", "demo", "--worker", "api", "KEY", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdin: stdinFrom(""),
      controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
        calls.push({ url, init });
        return response({});
      },
    }),
    /Refusing to delete secret "demo\/api\/KEY" without interactive confirmation/
  );
  assert.equal(calls.length, 0);
});

test("secret delete proceeds after interactive confirmation", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const prompts = [];
  const stdin = ttyStdinLine("y\n");

  await runSecretCommand(["delete", "--ns", "demo", "--scope", "ns", "KEY", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdin,
    stderr: (/** @type {string} */ text) => prompts.push(text),
    stdout: () => {},
    controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
      calls.push({ url, init });
      return response({ deleted: true });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/secrets/KEY");
  assert.deepEqual(prompts, ['Are you sure you want to delete secret "demo (ns)/KEY"? [y/N] ']);
  assert.equal(stdin.paused, true);
});

test("secret delete ignores obsolete deferred-promote warnings", async () => {
  /** @type {string[]} */
  const lines = [];
  await runSecretCommand(
    ["delete", "--ns", "demo", "--worker", "api", "KEY", "--yes", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (/** @type {string} */ line) => lines.push(line),
      controlFetch: async () => response({
        deleted: false,
        warnings: [
          { kind: "promote_failed", reason: "active version changed", nextPickup: "next deploy" },
        ],
      }),
    }
  );

  assert.deepEqual(lines, [
    "(KEY was not set)",
  ]);
});

test("secret put rejects an unexpected VALUE positional before reading stdin", async () => {
  let read = false;
  await assert.rejects(
    () => runSecretCommand(
      ["put", "--ns", "demo", "--scope", "ns", "KEY", "VALUE", "--control-url", "http://ctl.test"],
      {
        env: { ADMIN_TOKEN: "tok" },
        stdin: Object.assign(new EventEmitter(), {
          setEncoding() { read = true; },
        }),
        controlFetch: async () => {
          throw new Error("controlFetch should not be called");
        },
      }
    ),
    /secret put received unexpected argument: VALUE/
  );
  assert.equal(read, false);
});

test("r2 buckets and objects commands call encoded control endpoints", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const bytes = [];
  const stdoutStream = new Writable({
    write(chunk, _encoding, callback) {
      bytes.push(Buffer.from(chunk).toString("utf8"));
      callback();
    },
  });
  const deps = {
    env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
    stdout: (/** @type {string} */ line) => lines.push(line),
    stdoutStream,
    controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
      calls.push({ url, init });
      if (init.method === "DELETE") {
        return response({ namespace: "demo space", bucket: "uploads", key: "dir/file.txt", status: "ok" });
      }
      if (init.method === "HEAD") {
        return {
          status: 200,
          ok: true,
          headers: {
            "content-length": "11",
            "content-type": "text/plain",
            "cache-control": "max-age=60",
            etag: '"abc"',
            "last-modified": "Wed, 22 Apr 2026 00:00:00 GMT",
            "x-amz-meta-source": "unit",
            "x-amz-meta-__proto__": "pwned",
          },
          text: async () => "",
        };
      }
      if (url.includes("/objects/dir/file.txt")) {
        return {
          status: 200,
          ok: true,
          headers: {},
          body: Readable.from([Buffer.from("object-"), Buffer.from("body")]),
          arrayBuffer: async () => {
            throw new Error("r2 get should stream the response body");
          },
          text: async () => "object-body",
        };
      }
      if (url.endsWith("/r2/buckets?limit=5")) {
        return response({ namespace: "demo space", buckets: [{ name: "uploads" }], truncated: false });
      }
      return response({
        namespace: "demo space",
        bucket: "uploads",
        objects: [{ key: "dir/file.txt", size: 11, etag: "abc", uploaded: "2026-04-22T00:00:00.000Z" }],
        delimitedPrefixes: ["dir/"],
        truncated: false,
      });
    },
  };

  await runR2Command(["buckets", "list", "--ns", "demo space", "--limit", "5"], deps);
  await runR2Command(["objects", "list", "--ns", "demo space", "uploads", "--prefix", "dir/"], deps);
  await runR2Command(["objects", "get", "--ns", "demo space", "uploads", "dir/file.txt"], deps);
  await runR2Command(["objects", "head", "--ns", "demo space", "uploads", "dir/file.txt"], deps);
  await runR2Command(["objects", "delete", "--ns", "demo space", "uploads", "dir/file.txt", "--yes"], deps);

  assert.equal(calls[0].url, "http://ctl.test/ns/demo%20space/r2/buckets?limit=5");
  assert.equal(calls[1].url, "http://ctl.test/ns/demo%20space/r2/buckets/uploads/objects?prefix=dir%2F");
  assert.equal(calls[2].url, "http://ctl.test/ns/demo%20space/r2/buckets/uploads/objects/dir/file.txt");
  assert.equal(calls[2].init.timeoutMs, LONG_CONTROL_TIMEOUT_MS);
  assert.equal(calls[2].init.maxBodyBytes, UNLIMITED_CONTROL_BODY_BYTES);
  assert.equal(calls[3].url, "http://ctl.test/ns/demo%20space/r2/buckets/uploads/objects/dir/file.txt");
  assert.equal(calls[3].init.method, "HEAD");
  assert.equal(calls[4].url, "http://ctl.test/ns/demo%20space/r2/buckets/uploads/objects/dir/file.txt");
  assert.equal(calls[4].init.method, "DELETE");
  assert.equal(bytes.join(""), "object-body");
  assert.deepEqual(lines.slice(0, 4), [
    "R2 buckets in demo space:",
    "  uploads",
    "R2 objects in demo space/uploads:",
    "  <prefix> dir/",
  ]);
  assert.ok(lines.includes("R2 object demo space/uploads/dir/file.txt:"));
  assert.ok(lines.includes("  customMetadata.source: unit"));
  assert.ok(lines.includes("  customMetadata.__proto__: pwned"), "a control-supplied __proto__ metadata key is not dropped");
  assert.equal(lines.at(-1), "OK demo space/uploads/dir/file.txt deleted");
});

test("r2 object head --json keeps a __proto__ metadata key and drops a bare x-amz-meta-", async () => {
  /** @type {string[]} */
  const lines = [];
  const deps = {
    env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
    stdout: (/** @type {string} */ line) => lines.push(line),
    controlFetch: async () => ({
      status: 200,
      ok: true,
      headers: {
        "content-length": "0",
        "x-amz-meta-source": "unit",
        "x-amz-meta-__proto__": "pwned",
        "x-amz-meta-": "dropped",
      },
      text: async () => "",
    }),
  };
  await runR2Command(["objects", "head", "--ns", "demo", "uploads", "k", "--json", "--control-url", "http://ctl.test"], deps);
  const meta = JSON.parse(/** @type {string} */ (lines.find((l) => l.trim().startsWith("{")))).customMetadata;
  // JSON.parse re-materializes __proto__ as an own data property, so read the
  // descriptor — `meta.__proto__` would go through the prototype accessor instead.
  assert.equal(Object.getOwnPropertyDescriptor(meta, "__proto__")?.value, "pwned");
  assert.equal(meta.source, "unit");
  assert.ok(!Object.hasOwn(meta, ""), "a bare x-amz-meta- header produces no empty metadata key");
});

test("r2 buckets list accepts flags before the group/action", async () => {
  const { calls, deps } = mockDeps({ namespace: "demo", buckets: [] });

  await runR2Command(["--ns", "demo", "--control-url", "http://ctl.test", "buckets", "list"], deps);

  assert.equal(calls[0].url, "http://ctl.test/ns/demo/r2/buckets");
});

test("r2 list --limit is validated locally", async () => {
  const { calls, deps } = mockDeps({ namespace: "demo", buckets: [] });

  await runR2Command(["buckets", "list", "--ns", "demo", "--limit", "1000", "--control-url", "http://ctl.test"], deps);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/r2/buckets?limit=1000");

  await assert.rejects(
    () => runR2Command(["buckets", "list", "--ns", "demo", "--limit", "1001", "--control-url", "http://ctl.test"], deps),
    /--limit must be an integer/
  );
  await assert.rejects(
    () => runR2Command(["objects", "list", "--ns", "demo", "uploads", "--limit", "1.5", "--control-url", "http://ctl.test"], deps),
    /--limit must be an integer/
  );
  assert.equal(calls.length, 1);
});

test("r2 object get waits for stdout backpressure", async () => {
  /** @type {string[]} */
  const events = [];
  const stdoutStream = Object.assign(new EventEmitter(), {
    /** @param {Buffer} chunk */
    write(chunk) {
      events.push(`write:${Buffer.from(chunk).toString("utf8")}`);
      if (events.length === 1) {
        setTimeout(() => {
          events.push("drain");
          stdoutStream.emit("drain");
        }, 5);
        return false;
      }
      return true;
    },
  });

  await runR2Command(["objects", "get", "--ns", "demo", "uploads", "file.txt"], {
    env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
    stdoutStream,
    controlFetch: async () => ({
      status: 200,
      ok: true,
      headers: {},
      body: Readable.from([Buffer.from("a"), Buffer.from("b")]),
      text: async () => "",
    }),
  });

  assert.deepEqual(events, ["write:a", "drain", "write:b"]);
});

test("r2 object get refuses raw output to an interactive terminal", async () => {
  const stdoutStream = Object.assign(new EventEmitter(), {
    isTTY: true,
    write() {
      throw new Error("stdout should not be written");
    },
  });
  await assert.rejects(
    () => runR2Command(["objects", "get", "--ns", "demo", "uploads", "file.txt"], {
      env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
      stdoutStream,
      controlFetch: async () => {
        throw new Error("controlFetch should not be called");
      },
    }),
    /refuses to write raw object bytes to an interactive terminal/
  );
});

test("r2 object get --out escapes a control-char path in the success line", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-r2-out-escape-"));
  try {
    const esc = String.fromCharCode(27);
    const outPath = path.join(dir, `file${esc}[2J.bin`);
    /** @type {string[]} */
  const lines = [];
    await runR2Command(
      ["objects", "get", "--ns", "demo", "uploads", "file.txt", "--out", outPath, "--control-url", "http://ctl.test"],
      {
        env: { ADMIN_TOKEN: "tok" },
        stdout: (/** @type {string} */ line) => lines.push(line),
        controlFetch: async () => ({
          status: 200,
          ok: true,
          headers: {},
          body: Readable.from([Buffer.from("ab")]),
          text: async () => "",
        }),
      }
    );
    const out = lines.join("\n");
    assert.doesNotMatch(out, new RegExp(esc), "raw ESC from --out path must not reach stdout");
    assert.match(out, /OK wrote 2 bytes to/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("r2 object get, head, and delete reject blank keys", async () => {
  const deps = {
    env: { CONTROL_URL: "http://ctl.test" },
    controlFetch: async () => {
      throw new Error("controlFetch should not be called");
    },
  };

  await assert.rejects(
    () => runR2Command(["objects", "get", "--ns", "demo", "uploads", "   "], deps),
    /R2 object key is required/
  );
  await assert.rejects(
    () => runR2Command(["objects", "head", "--ns", "demo", "uploads", "   "], deps),
    /R2 object key is required/
  );
  await assert.rejects(
    () => runR2Command(["objects", "delete", "--ns", "demo", "uploads", "   ", "--yes"], deps),
    /R2 object key is required/
  );
});

test("r2 object key preserves empty path segments but rejects dot segments", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  const deps = {
    env: { ADMIN_TOKEN: "tok" },
    stdout: () => {},
    controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
      calls.push({ url, init });
      return {
        status: 200,
        ok: true,
        headers: {},
        text: async () => "",
      };
    },
  };
  await runR2Command(["objects", "head", "bkt", "a//b", "--ns", "demo", "--control-url", "http://ctl.test"], deps);
  await runR2Command(["objects", "head", "bkt", "/a", "--ns", "demo", "--control-url", "http://ctl.test"], deps);
  await runR2Command(["objects", "head", "bkt", "a/", "--ns", "demo", "--control-url", "http://ctl.test"], deps);

  assert.equal(calls[0].url, "http://ctl.test/ns/demo/r2/buckets/bkt/objects/a//b");
  assert.equal(calls[1].url, "http://ctl.test/ns/demo/r2/buckets/bkt/objects//a");
  assert.equal(calls[2].url, "http://ctl.test/ns/demo/r2/buckets/bkt/objects/a/");

  await assert.rejects(
    () => runR2Command(["objects", "get", "bkt", "a/./b", "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      controlFetch: async () => response({}),
    }),
    /must not contain \. or \.\. path segments/
  );
});

test("r2 commands reject unexpected positional arguments", async () => {
  const deps = {
    env: { CONTROL_URL: "http://ctl.test" },
    controlFetch: async () => {
      throw new Error("controlFetch should not be called");
    },
  };
  await assert.rejects(
    () => runR2Command(["buckets", "list", "extra", "--ns", "demo"], deps),
    /r2 buckets list received unexpected argument: extra/
  );
  await assert.rejects(
    () => runR2Command(["objects", "list", "uploads", "extra", "--ns", "demo"], deps),
    /r2 objects list received unexpected argument: extra/
  );
  await assert.rejects(
    () => runR2Command(["objects", "get", "uploads", "key", "extra", "--ns", "demo"], deps),
    /r2 objects get received unexpected argument: extra/
  );
});

test("r2 streaming commands format JSON control errors", async () => {
  const deps = {
    env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
    controlFetch: async () => response({
      error: "r2_object_not_found",
      message: "R2 object not found",
    }, 404),
  };

  await assert.rejects(
    () => runR2Command(["objects", "get", "--ns", "demo", "uploads", "missing.txt"], deps),
    { message: "get R2 object failed: 404 r2_object_not_found: R2 object not found" }
  );
});

test("r2 object delete requires confirmation unless --yes is used", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  await assert.rejects(
    () => runR2Command(["objects", "delete", "--ns", "demo", "uploads", "a.txt", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdin: stdinFrom(""),
      controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
        calls.push({ url, init });
        return response({});
      },
    }),
    /Refusing to delete R2 object "demo\/uploads\/a.txt" without interactive confirmation/
  );
  assert.equal(calls.length, 0);
});

test("workflows commands call encoded control endpoints", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  const deps = {
    env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
    stdout: (/** @type {string} */ line) => lines.push(line),
    controlFetch: async (/** @type {string} */ url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}) => {
      calls.push({ url, init });
      if (url.endsWith("/workflows")) {
        return response({
          workflows: [{
            worker: "api",
            name: "orders",
            binding: "ORDERS",
            className: "OrderWorkflow",
            activeVersion: "v2",
            workflowKey: "wf_1234",
          }],
        });
      }
      if (url.includes("/instances?")) {
        return response({ instances: [{ id: "order/1", status: "queued" }], cursor: "1" });
      }
      if (url.includes("/status-instance?")) {
        return response({
          id: "status-instance",
          status: "completed",
          output: { ok: true },
          steps: { entries: [{ ordinal: 0, name: "load", status: "completed" }], truncated: false },
        });
      }
      return response({ id: "order/1", status: "paused" });
    },
  };

  await runWorkflowsCommand(["list", "--ns", "demo space"], deps);
  await runWorkflowsCommand(["instances", "--ns", "demo space", "api", "orders", "--limit", "5", "--cursor", "0"], deps);
  await runWorkflowsCommand(["status", "--ns", "demo space", "api", "orders", "status-instance", "--include-steps", "--step-limit", "10"], deps);
  await runWorkflowsCommand(["pause", "--ns", "demo space", "api", "orders", "order/1"], deps);
  await runWorkflowsCommand(["resume", "--ns", "demo space", "api", "orders", "order/1"], deps);
  await runWorkflowsCommand(["restart", "--ns", "demo space", "api", "orders", "order/1", "--yes"], deps);
  await runWorkflowsCommand(["terminate", "--ns", "demo space", "api", "orders", "order/1", "--yes"], deps);

  assert.equal(calls[0].url, "http://ctl.test/ns/demo%20space/workflows");
  assert.equal(calls[1].url, "http://ctl.test/ns/demo%20space/workflows/api/orders/instances?limit=5&cursor=0");
  assert.equal(calls[2].url, "http://ctl.test/ns/demo%20space/workflows/api/orders/instances/status-instance?includeSteps=true&stepLimit=10");
  assert.equal(calls[3].url, "http://ctl.test/ns/demo%20space/workflows/api/orders/instances/order%2F1/pause");
  assert.equal(calls[3].init.method, "POST");
  assert.equal(calls[4].url, "http://ctl.test/ns/demo%20space/workflows/api/orders/instances/order%2F1/resume");
  assert.equal(calls[4].init.method, "POST");
  assert.equal(calls[5].url, "http://ctl.test/ns/demo%20space/workflows/api/orders/instances/order%2F1/restart");
  assert.equal(calls[5].init.method, "POST");
  assert.equal(calls[6].url, "http://ctl.test/ns/demo%20space/workflows/api/orders/instances/order%2F1/terminate");
  assert.equal(calls[6].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { "x-admin-token": "tok" });
  assert.ok(lines.includes("api/orders\tbinding=ORDERS\tclass=OrderWorkflow\tactive=v2\tkey=wf_1234"));
  assert.ok(lines.includes("Next cursor: 1"));
  assert.ok(lines.includes("steps=1"));
  assert.equal(lines.at(-1), "OK demo space/api/orders/order/1 terminate status=paused");
});

test("workflows list accepts flags before the subcommand", async () => {
  const { calls, lines, deps } = mockDeps({ workflows: [] });

  await runWorkflowsCommand(["--ns", "demo", "--control-url", "http://ctl.test", "list"], deps);

  assert.equal(calls[0].url, "http://ctl.test/ns/demo/workflows");
  assert.deepEqual(lines, ["(no workflows)"]);
});

test("workflows commands reject unexpected positional arguments", async () => {
  /** @type {boolean[]} */
  const calls = [];
  const deps = {
    env: { CONTROL_URL: "http://ctl.test" },
    controlFetch: async () => {
      calls.push(true);
      return response({});
    },
  };

  await assert.rejects(
    () => runWorkflowsCommand(["list", "--ns", "demo", "extra"], deps),
    /workflows list received unexpected argument: extra/
  );
  await assert.rejects(
    () => runWorkflowsCommand(["instances", "--ns", "demo", "api", "orders", "extra"], deps),
    /workflows instances received unexpected argument: extra/
  );
  await assert.rejects(
    () => runWorkflowsCommand(["status", "--ns", "demo", "api", "orders", "id", "--step-limit", "10"], deps),
    /--step-limit requires --include-steps/
  );
  await assert.rejects(
    () => runWorkflowsCommand(["restart", "--ns", "demo", "api", "orders", "id", "extra", "--yes"], deps),
    /workflows restart received unexpected argument: extra/
  );
  assert.equal(calls.length, 0);
});

test("wdl dispatcher routes documented commands and rejects unknown commands", async () => {
  const oldExit = process.exit;
  const oldError = console.error;
  const oldLog = console.log;
  /** @type {string[]} */
  const seen = [];

  process.exit = (code) => {
    throw new Error(`exit:${code}`);
  };
  console.error = (msg) => seen.push(String(msg));
  console.log = (msg) => seen.push(String(msg));

  try {
    await assert.rejects(() => wdlMain(["help"], { loadEnv: null }), /exit:0/);
    assert.ok(/** @type {string} */ (seen.at(-1)).includes("wdl <command> [args] [options]"));
    // Top-level help must list the common control flags too, matching command
    // help — --no-token-store was missing here once.
    assert.ok(/** @type {string} */ (seen.at(-1)).includes("--no-token-store"), "top-level help lists --no-token-store");
    // The command table is derived from each command's { name, summary }; assert
    // the metadata content renders (and the alias note) without pinning column spacing.
    assert.ok(/** @type {string} */ (seen.at(-1)).includes("Manage D1 databases, SQL execution, and migrations."));
    assert.ok(/** @type {string} */ (seen.at(-1)).includes("Manage namespace-level or worker-level secrets. (alias: secrets)"));
    assert.ok(/** @type {string} */ (seen.at(-1)).includes("Inspect and delete R2 virtual bucket data."));
    assert.ok(/** @type {string} */ (seen.at(-1)).includes("Live-tail worker console output and uncaught exceptions."));
    // workflows is the widest name, so its summary sits one space after it.
    assert.ok(/** @type {string} */ (seen.at(-1)).includes("workflows Inspect and control Workflow instances."));

    await assert.rejects(() => wdlMain(["del"], { loadEnv: null }), /exit:1/);
    assert.ok(seen.some((line) => line.includes("unknown command: del")));

    await assert.rejects(() => wdlMain(["worker-list"], { loadEnv: null }), /exit:1/);
    assert.ok(seen.some((line) => line.includes("unknown command: worker-list")));

    await assert.rejects(() => wdlMain(["toString"], { loadEnv: null }), /exit:1/);
    assert.ok(seen.some((line) => line.includes("unknown command: toString")));
    await assert.rejects(() => wdlMain(["help", "toString"], { loadEnv: null }), /exit:1/);
    assert.ok(seen.some((line) => line.includes("unknown help topic: toString")));
    assert.doesNotMatch(seen.join("\n"), /TypeError|COMMANDS\[|\.main/);
  } finally {
    process.exit = oldExit;
    console.error = oldError;
    console.log = oldLog;
  }
});

test("wdl help <command> prints that command help", async () => {
  const oldLog = console.log;
  /** @type {string[]} */
  const lines = [];
  console.log = (msg) => lines.push(String(msg));
  try {
    await wdlMain(["help", "r2"], { loadEnv: null });
  } finally {
    console.log = oldLog;
  }
  assert.match(lines.join("\n"), /wdl r2 objects get <bucket> <key>/);
  assert.doesNotMatch(lines.join("\n"), /wdl <command> \[args\]/);
});

test("wdl dispatcher prints the CLI version for --version, -v, and version", async () => {
  const oldLog = console.log;
  /** @type {string[]} */
  const lines = [];
  console.log = (msg) => lines.push(String(msg));
  try {
    await wdlMain(["--version"], { loadEnv: null });
    await wdlMain(["-v"], { loadEnv: null });
    await wdlMain(["version"], { loadEnv: null });
  } finally {
    console.log = oldLog;
  }
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.deepEqual(lines, [pkg.version, pkg.version, pkg.version]);
});

// Stub process.exit (throws `exit:<code>`) and capture console.error lines
// for dispatcher-level tests that drive bin/wdl.js end to end.
/** @param {(errors: string[]) => Promise<void>} fn */
async function withMockedExit(fn) {
  const oldExit = process.exit;
  const oldError = console.error;
  /** @type {string[]} */
  const errors = [];
  process.exit = (code) => {
    throw new Error(`exit:${code}`);
  };
  console.error = (msg) => errors.push(String(msg));
  try {
    await fn(errors);
  } finally {
    process.exit = oldExit;
    console.error = oldError;
  }
  return errors;
}

test("wdl dispatcher loads base dotenv before namespace section overlay", async () => {
  /** @type {LoadEnvOptions[]} */
  const calls = [];
  // secret's missing-subcommand CliError fires after autoload, keeping the
  // dispatch harmless without needing a control-plane mock.
  await withMockedExit(async () => {
    await assert.rejects(
      () => wdlMain(["secret", "--ns", "demo"], {
        env: {},
        loadEnv: /** @type {LoadEnvFn} */ (/** @type {unknown} */ ((/** @type {NodeJS.ProcessEnv | undefined} */ _env, /** @type {string | undefined} */ _path, /** @type {LoadEnvOptions} */ options) => calls.push(options))),
      }),
      /exit:1/
    );
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map(({ loadBase, resolvedNs }) => ({ loadBase, resolvedNs })),
    [
      { loadBase: undefined, resolvedNs: undefined },
      { loadBase: false, resolvedNs: "demo" },
    ]
  );
  assert.equal(calls[0].protectedKeys, calls[1].protectedKeys);
});

test("wdl dispatcher overlays the LAST --ns occurrence, matching parseArgs", async () => {
  /** @type {LoadEnvOptions[]} */
  const calls = [];
  await withMockedExit(async () => {
    await assert.rejects(
      () => wdlMain(["secret", "--ns", "first", "--ns=last"], {
        env: {},
        loadEnv: /** @type {LoadEnvFn} */ (/** @type {unknown} */ ((/** @type {NodeJS.ProcessEnv | undefined} */ _env, /** @type {string | undefined} */ _path, /** @type {LoadEnvOptions} */ options) => calls.push(options))),
      }),
      /exit:1/
    );
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].resolvedNs, "last");
});

test("wdl dispatcher skips dotenv when help is requested", async () => {
  /** @type {LoadEnvOptions[]} */
  const calls = [];
  const oldLog = console.log;
  console.log = () => {};
  try {
    await wdlMain(["workers", "--ns", "demo", "--help"], {
      env: {},
      loadEnv: /** @type {LoadEnvFn} */ (/** @type {unknown} */ ((/** @type {NodeJS.ProcessEnv | undefined} */ _env, /** @type {string | undefined} */ _path, /** @type {LoadEnvOptions} */ options) => calls.push(options))),
    });
    // The positional alias form must skip autoload too — including with
    // flags present — so a broken .env cannot block `wdl <command> help`.
    await wdlMain(["workers", "help"], {
      env: {},
      loadEnv: /** @type {LoadEnvFn} */ (/** @type {unknown} */ ((/** @type {NodeJS.ProcessEnv | undefined} */ _env, /** @type {string | undefined} */ _path, /** @type {LoadEnvOptions} */ options) => calls.push(options))),
    });
    await wdlMain(["workers", "--ns", "demo", "help"], {
      env: {},
      loadEnv: /** @type {LoadEnvFn} */ (/** @type {unknown} */ ((/** @type {NodeJS.ProcessEnv | undefined} */ _env, /** @type {string | undefined} */ _path, /** @type {LoadEnvOptions} */ options) => calls.push(options))),
    });
  } finally {
    console.log = oldLog;
  }
  assert.deepEqual(calls, []);
});

test("wdl dispatcher reports a malformed .env without a Node stack", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-dispatch-env-"));
  const oldCwd = process.cwd();
  let errors;
  try {
    process.chdir(dir);
    writeFileSync(path.join(dir, ".env"), "CONTROL_URL\n");
    errors = await withMockedExit(async () => {
      await assert.rejects(() => wdlMain(["workers", "--ns", "demo"], {}), /exit:1/);
    });
  } finally {
    process.chdir(oldCwd);
    rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(errors.length, 1);
  assert.match(errors[0], /error: Invalid \.env line 1: expected KEY=value/);
  assert.doesNotMatch(errors[0], /at |Node\.js/);
});

test("wdl dispatcher skips dotenv for top-level help and unknown commands", async () => {
  const oldExit = process.exit;
  const oldError = console.error;
  const oldLog = console.log;
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const calls = [];

  process.exit = (code) => {
    throw new Error(`exit:${code}`);
  };
  console.error = (msg) => errors.push(String(msg));
  console.log = () => {};

  try {
    await assert.rejects(
      () => wdlMain(["help"], { loadEnv: /** @type {LoadEnvFn} */ (/** @type {unknown} */ (() => calls.push("help"))) }),
      /exit:0/
    );
    await assert.rejects(
      () => wdlMain(["bogus"], { loadEnv: /** @type {LoadEnvFn} */ (/** @type {unknown} */ (() => calls.push("bogus"))) }),
      /exit:1/
    );
    await assert.rejects(
      () => wdlMain([`bad${ESC}[2J\nFORGED\rBAD`], { loadEnv: /** @type {LoadEnvFn} */ (/** @type {unknown} */ (() => calls.push("bad"))) }),
      /exit:1/
    );
    assert.deepEqual(calls, []);
    assert.ok(errors.some((line) => line.includes("unknown command: bogus")));
    const escaped = errors.find((line) => line.includes("unknown command: bad"));
    assert.ok(escaped);
    assertNoRawTerminalControls(escaped, "unknown-command errors");
    assert.match(escaped, /bad\\u001b\[2J\\nFORGED\\rBAD/);
  } finally {
    process.exit = oldExit;
    console.error = oldError;
    console.log = oldLog;
  }
});

test("wdl dispatcher prints parseArgs errors without a Node stack", async () => {
  const oldExit = process.exit;
  const oldError = console.error;
  /** @type {string[]} */
  const errors = [];

  process.exit = (code) => {
    throw new Error(`exit:${code}`);
  };
  console.error = (msg) => errors.push(String(msg));

  try {
    await assert.rejects(
      () => wdlMain(["tail", `--dsf${ESC}[2J\nFORGED\rBAD`], { loadEnv: null }),
      /exit:1/
    );
  } finally {
    process.exit = oldExit;
    console.error = oldError;
  }

  assert.equal(errors.length, 1);
  assert.match(errors[0], /error: Unknown option '--dsf\\u001b\[2J\\nFORGED\\rBAD'/);
  assertNoRawTerminalControls(errors[0], "parseArgs errors");
  assert.doesNotMatch(errors[0], /TypeError|parse_args|Node\.js/);
});

test("SseParser dispatches event/id/data on blank line per SSE rules", () => {
  /** @type {import("../../commands/tail.js").SseEvent[]} */
  const events = [];
  const parser = new SseParser((event) => events.push(event));

  parser.push("event: worker_console\nid: 1700000000000-0\ndata: {\"a\":");
  parser.push("1}\n");
  parser.push("data: \"trailing\"\n\n");
  parser.push(":hb\n\n");
  parser.push("data: hello\n\n");

  assert.deepEqual(events, [
    { event: "worker_console", id: "1700000000000-0", data: "{\"a\":1}\n\"trailing\"" },
    { event: "message", id: "1700000000000-0", data: "hello" },
  ]);
});

test("SseParser handles CRLF line endings and flushes trailing events", () => {
  /** @type {import("../../commands/tail.js").SseEvent[]} */
  const events = [];
  const parser = new SseParser((event) => events.push(event));

  parser.push("event: ping\r\ndata: x\r\n\r\n");
  parser.push("event: late\ndata: y");
  parser.flush();

  assert.equal(events.length, 2);
  assert.equal(events[0].event, "ping");
  assert.equal(events[0].data, "x");
  assert.equal(events[1].event, "late");
  assert.equal(events[1].data, "y");
});

test("SseParser rejects overlong lines", () => {
  const parser = new SseParser(() => {});
  assert.throws(() => parser.push(`data: ${"x".repeat(SSE_MAX_LINE_CHARS)}`), /SSE line exceeded/);
});

test("wdl tail rejects errors raised while flushing a trailing SSE event", async () => {
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        res.emit("data", 'data: {"event":"worker_console","message":["x"]}');
        res.emit("end");
      });
      return req;
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"],
      {
        env: {},
        stdout: () => { throw new CliError("stdout stop"); },
        stderr: () => {},
        transport: fakeTransport,
      }
    ),
    { message: "stdout stop" }
  );
});

test("wdl tail rejects --since for multi-worker sessions", async () => {
  await assert.rejects(
    () => runTailCommand(
      ["foo", "bar", "--since", "1-0", "--ns", "demo", "--token", "t"],
      { env: {}, stdout: () => {}, stderr: () => {} }
    ),
    /single-worker/i
  );
});

test("wdl tail rejects invalid max-reconnects input", async () => {
  const bad = `forever${ESC}[2J\nFORGED\rBAD\u009b`;
  await assert.rejects(
    () => runTailCommand(
      ["foo", "--max-reconnects", bad, "--ns", "demo", "--token", "t",
       "--control-url", "http://ctl.test"],
      { env: {}, stdout: () => {}, stderr: () => {} }
    ),
    (err) => {
      const message = /** @type {Error} */ (err).message;
      assert.match(message, /--max-reconnects must be a non-negative integer/);
      assert.match(message, /forever\\u001b\[2J\\nFORGED\\rBAD\\u009b/);
      assertNoRawTerminalControls(message, "--max-reconnects errors");
      return true;
    }
  );
});

test("wdl tail requires at least one positional worker", async () => {
  await assert.rejects(
    () => runTailCommand(
      ["--ns", "demo", "--token", "t"],
      { env: {}, stdout: () => {}, stderr: () => {} }
    ),
    /Specify one or more worker names/
  );
});

test("wdl tail help short-circuits before max-reconnects validation", async () => {
  /** @type {string[]} */
  const stdoutLines = [];
  await runTailCommand(
    ["--help", "--max-reconnects", "forever"],
    {
      env: {},
      stdout: (/** @type {string} */ line) => stdoutLines.push(line),
      stderr: () => {},
    }
  );

  assert.ok(stdoutLines.some((line) => /--max-reconnects/.test(line)));
});

test("wdl tail escapes control error details", async () => {
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = Object.assign(fakeHttpRes(), { statusCode: 500 });
        cb(res);
        res.emit("data", Buffer.from(JSON.stringify({
          message: "bad\u001b[31m\nline",
        })));
        res.emit("end");
      });
      return req;
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"],
      {
        env: {},
        stdout: () => {},
        stderr: () => {},
        transport: fakeTransport,
      }
    ),
    { message: "bad\\u001b[31m\\nline" }
  );
});

/** @returns {import("../../lib/control-fetch.js").ControlClientRequest} */
function fakeHttpReq() {
  return /** @type {import("../../lib/control-fetch.js").ControlClientRequest} */ (
    /** @type {unknown} */ (Object.assign(new EventEmitter(), {
      end() {},
      destroy() {},
    }))
  );
}

/** @returns {import("node:http").IncomingMessage} */
function fakeHttpRes() {
  return /** @type {import("node:http").IncomingMessage} */ (
    /** @type {unknown} */ (Object.assign(new EventEmitter(), {
      statusCode: 200,
      headers: {},
      setEncoding() {},
    }))
  );
}

test("wdl tail renders fetch, scheduled, and queue invocation events", async () => {
  /** @type {string[]} */
  const stdoutLines = [];
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        const events = [
          {
            event: "worker_scheduled",
            phase: "start",
            ts: 1,
            cron: "*/5 * * * *",
            scheduled_time: 123,
          },
          {
            event: "worker_queue",
            phase: "finish",
            ts: 2,
            queue: "jobs",
            batch_size: 3,
            outcome: "ok",
            duration_ms: 7,
          },
          {
            event: "worker_fetch",
            worker: "foo",
            phase: "finish",
            ts: 3,
            method: "GET",
            path: "/api/inspections",
            path_truncated: true,
            status: 204,
            outcome: "ok",
            duration_ms: 4,
          },
        ];
        for (const payload of events) {
          res.emit("data", `event: ${payload.event}\ndata: ${JSON.stringify(payload)}\n\n`);
        }
        res.emit("error", new CliError("test stop"));
      });
      return req;
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"],
      {
        env: {},
        stdout: (/** @type {string} */ line) => stdoutLines.push(line),
        stderr: () => {},
        transport: fakeTransport,
      }
    ),
    { message: "test stop" }
  );

  assert.match(stdoutLines[0], /scheduled start cron="\*\/5 \* \* \* \*" scheduled_time=123/);
  assert.match(stdoutLines[1], /queue finish name=jobs batch_size=3 outcome=ok duration_ms=7/);
  assert.match(stdoutLines[2], /fetch finish method=GET path="\/foo\/api\/inspections" \(truncated\) status=204 outcome=ok duration_ms=4/);
  assert.ok(!stdoutLines.some((line) => line.includes('{"event"')));
});

test("wdl tail escapes terminal control sequences in rendered events", async () => {
  /** @type {string[]} */
  const stdoutLines = [];
  let emitted = false;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        if (!emitted) {
          emitted = true;
          const consoleEvent = JSON.stringify({
            event: "worker_console",
            console_level: "log",
            message: "\u001b]0;owned\u0007evil",
            ts: 1,
          });
          const exceptionEvent = JSON.stringify({
            event: "worker_exception",
            name: "Error",
            message: "boom",
            stack: "Error: boom\n    at fetch (\u001b[2Jworker.js:1)",
            ts: 2,
          });
          res.emit("data", `event: worker_console\ndata: ${consoleEvent}\n\n` +
            `event: worker_exception\ndata: ${exceptionEvent}\n\n`);
        }
        res.emit("error", new CliError("test stop"));
      });
      return req;
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"],
      {
        env: {},
        stdout: (/** @type {string} */ line) => stdoutLines.push(line),
        stderr: () => {},
        transport: fakeTransport,
        sleepFn: async () => {},
      }
    ),
    { message: "test stop" }
  );

  const out = stdoutLines.join("\n");
  assert.ok(!out.includes("\u001b"), "raw ESC byte must never reach the terminal");
  assert.ok(out.includes("\\u001b]0;owned\\u0007evil"), `console message must be escaped, got ${JSON.stringify(out)}`);
  // The stack keeps its real newline but each line is escaped.
  assert.ok(out.includes("    at fetch (\\u001b[2Jworker.js:1)"), "stack lines must be escaped");
});

test("wdl tail accepts bare CONTROL_URL hosts by defaulting to https", async () => {
  /** @type {import("node:https").RequestOptions[]} */
  const requestsSeen = [];
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(opts, cb) {
      requestsSeen.push(opts);
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        res.emit("error", new CliError("test stop"));
      });
      return req;
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["kv-demo"],
      {
        env: {
          ADMIN_TOKEN: "tok",
          CONTROL_URL: "ctl.uat.example",
          WDL_NS: "demo",
        },
        stdout: () => {},
        stderr: () => {},
        transport: fakeTransport,
      }
    ),
    { message: "test stop" }
  );

  assert.equal(requestsSeen[0].host, "ctl.uat.example");
  assert.equal(requestsSeen[0].port, 443);
  assert.equal(/** @type {import("node:http").OutgoingHttpHeaders} */ (requestsSeen[0].headers).Host, "ctl.uat.example");
  assert.equal(requestsSeen[0].path, "/ns/demo/logs/tail?worker=kv-demo");
});

test("wdl tail uses effective CONTROL_CONNECT_HOST for SSE sockets", async () => {
  /** @type {import("node:https").RequestOptions[]} */
  const requestsSeen = [];
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(opts, cb) {
      requestsSeen.push(opts);
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        res.emit("error", new CliError("test stop"));
      });
      return req;
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["kv-demo"],
      {
        env: {
          ADMIN_TOKEN: "tok",
          CONTROL_URL: "http://admin.test:8080",
          CONTROL_CONNECT_HOST: "127.0.0.1:18080",
          WDL_NS: "demo",
        },
        stdout: () => {},
        stderr: () => {},
        transport: fakeTransport,
      }
    ),
    { message: "test stop" }
  );

  assert.equal(requestsSeen[0].host, "127.0.0.1");
  assert.equal(requestsSeen[0].port, 18080);
  assert.equal(/** @type {import("node:http").OutgoingHttpHeaders} */ (requestsSeen[0].headers).Host, "admin.test:8080");
  assert.equal(requestsSeen[0].path, "/ns/demo/logs/tail?worker=kv-demo");
});

test("wdl tail rejects invalid auth headers before opening an SSE request", async () => {
  let opened = false;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} _cb
     */
    request(_opts, _cb) {
      opened = true;
      throw new Error("request should not be opened");
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["foo", "--ns", "demo", "--token", "tok\nnext", "--control-url", "http://ctl.test"],
      {
        env: {},
        stdout: () => {},
        stderr: () => {},
        transport: fakeTransport,
        sleepFn: async () => {
          throw new Error("tail should not enter the reconnect loop");
        },
      }
    ),
    (err) => err instanceof CliError &&
      err.message.includes('control request failed: invalid HTTP header "x-admin-token"')
  );
  assert.equal(opened, false);
});

test("wdl tail abort destroys the SSE request with a tolerated abort error", async () => {
  /** @type {Array<Error & { code?: string }>} */
  const destroyedWith = [];
  let requestCount = 0;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} _cb
     */
    request(_opts, _cb) {
      requestCount += 1;
      const emitter = new EventEmitter();
      const req = /** @type {import("../../lib/control-fetch.js").ControlClientRequest} */ (
        /** @type {unknown} */ (Object.assign(emitter, {
          end() {},
          /** @param {Error & { code?: string }} [err] */
          destroy(err) {
            if (err) destroyedWith.push(err);
            setImmediate(() => emitter.emit(
              "error",
              err || Object.assign(new Error("socket closed"), { code: "ECONNRESET" }),
            ));
          },
        }))
      );
      setImmediate(() => process.emit("SIGINT"));
      return req;
    },
  };

  await runTailCommand(
    ["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"],
    {
      env: {},
      stdout: () => {},
      stderr: () => {},
      transport: fakeTransport,
      sleepFn: async () => {
        throw new Error("tail should not reconnect after abort");
      },
    }
  );

  assert.equal(requestCount, 1);
  assert.equal(destroyedWith.length, 1);
  assert.equal(destroyedWith[0].name, "AbortError");
  assert.equal(destroyedWith[0].code, "ABORT_ERR");
});

test("wdl tail sends --since on the initial URL, not duplicated as Last-Event-ID", async () => {
  /** @type {Array<{ path: import("node:https").RequestOptions["path"], headers: import("node:http").OutgoingHttpHeaders }>} */
  const requestsSeen = [];
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(opts, cb) {
      requestsSeen.push({ path: opts.path, headers: { .../** @type {import("node:http").OutgoingHttpHeaders} */ (opts.headers) } });
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        res.emit("error", new CliError("test stop"));
      });
      return req;
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["foo", "--since", "100-0", "--ns", "demo", "--token", "t",
       "--control-url", "http://ctl.test"],
      {
        env: {},
        stdout: () => {},
        stderr: () => {},
        transport: fakeTransport,
      }
    ),
    { message: "test stop" }
  );

  assert.equal(requestsSeen[0].path, "/ns/demo/logs/tail?worker=foo&since=100-0");
  assert.equal(requestsSeen[0].headers["last-event-id"], undefined);
});

test("wdl tail keeps --since on reconnect until the server provides an event id", async () => {
  /** @type {Array<{ path: import("node:https").RequestOptions["path"], headers: import("node:http").OutgoingHttpHeaders }>} */
  const requestsSeen = [];
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(opts, cb) {
      requestsSeen.push({ path: opts.path, headers: { .../** @type {import("node:http").OutgoingHttpHeaders} */ (opts.headers) } });
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        if (requestsSeen.length === 1) {
          res.emit("error", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
          return;
        }
        res.emit("error", new CliError("test stop"));
      });
      return req;
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["foo", "--since", "100-0", "--ns", "demo", "--token", "t",
       "--control-url", "http://ctl.test"],
      {
        env: {},
        stdout: () => {},
        stderr: () => {},
        transport: fakeTransport,
        sleepFn: async () => {},
      }
    ),
    { message: "test stop" }
  );

  assert.equal(requestsSeen[0].path, "/ns/demo/logs/tail?worker=foo&since=100-0");
  assert.equal(requestsSeen[1].path, "/ns/demo/logs/tail?worker=foo&since=100-0");
  assert.equal(requestsSeen[1].headers["last-event-id"], undefined);
});

test("wdl tail switches from --since to Last-Event-ID after receiving an event id", async () => {
  /** @type {Array<{ path: import("node:https").RequestOptions["path"], headers: import("node:http").OutgoingHttpHeaders }>} */
  const requestsSeen = [];
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(opts, cb) {
      requestsSeen.push({ path: opts.path, headers: { .../** @type {import("node:http").OutgoingHttpHeaders} */ (opts.headers) } });
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        if (requestsSeen.length === 1) {
          res.emit("data", `id: 101-0\nevent: worker_console\ndata: ${JSON.stringify({
            event: "worker_console",
            console_level: "log",
            message: "hello",
            ts: 1,
          })}\n\n`);
          res.emit("error", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
          return;
        }
        res.emit("error", new CliError("test stop"));
      });
      return req;
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["foo", "--since", "100-0", "--ns", "demo", "--token", "t",
       "--control-url", "http://ctl.test"],
      {
        env: {},
        stdout: () => {},
        stderr: () => {},
        transport: fakeTransport,
        sleepFn: async () => {},
      }
    ),
    { message: "test stop" }
  );

  assert.equal(requestsSeen[0].path, "/ns/demo/logs/tail?worker=foo&since=100-0");
  assert.equal(requestsSeen[1].path, "/ns/demo/logs/tail?worker=foo");
  assert.equal(requestsSeen[1].headers["last-event-id"], "101-0");
});

test("wdl tail prints a connected status after SSE handshake", async () => {
  /** @type {string[]} */
  const stderrLines = [];
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        res.emit("error", new CliError("test stop"));
      });
      return req;
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"],
      {
        env: {},
        stdout: () => {},
        stderr: (/** @type {string} */ line) => stderrLines.push(line),
        transport: fakeTransport,
      }
    ),
    { message: "test stop" }
  );

  assert.ok(stderrLines.includes("tail connected; waiting for events…"));
});

test("wdl tail reconnects with Last-Event-ID after transport errors", async () => {
  /** @type {Array<{ path: import("node:https").RequestOptions["path"], headers: import("node:http").OutgoingHttpHeaders }>} */
  const requestsSeen = [];
  /** @type {string[]} */
  const stderrLines = [];
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(opts, cb) {
      requestsSeen.push({ path: opts.path, headers: { .../** @type {import("node:http").OutgoingHttpHeaders} */ (opts.headers) } });
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        if (requestsSeen.length === 1) {
          setImmediate(() => {
            res.emit("data", `id: 100-0\nevent: worker_console\ndata: ${JSON.stringify({
              event: "worker_console",
              console_level: "log",
              message: "hello",
              ts: 1,
            })}\n\n`);
            setImmediate(() => {
              res.emit("error", Object.assign(new Error(`socket hang up${ESC}[2J\nFORGED\rBAD`), { code: "ECONNRESET" }));
            });
          });
        } else {
          setImmediate(() => {
            res.emit("error", new CliError("test stop"));
          });
        }
      });
      return req;
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"],
      {
        env: {},
        stdout: () => {},
        stderr: (/** @type {string} */ line) => stderrLines.push(line),
        transport: fakeTransport,
        sleepFn: async () => {},
      }
    ),
    { message: "test stop" }
  );

  assert.ok(requestsSeen.length >= 2);
  assert.equal(requestsSeen[0].headers["last-event-id"], undefined);
  assert.equal(requestsSeen[1].headers["last-event-id"], "100-0");
  const transportLine = stderrLines.find((line) => /transport error/i.test(line));
  assert.ok(transportLine);
  assert.match(transportLine, /socket hang up\\u001b\[2J\\nFORGED\\rBAD/);
  assertNoRawTerminalControls(transportLine, "tail transport diagnostics");
});

test("wdl tail treats session recycle warnings as control-initiated reconnects", async () => {
  /** @type {number[]} */
  const sleepCalls = [];
  /** @type {string[]} */
  const stderrLines = [];
  let requestCount = 0;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      requestCount += 1;
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        if (requestCount === 1) {
          setImmediate(() => {
            res.emit("data", `event: tail_warning\ndata: ${JSON.stringify({
              event: "tail_warning",
              code: "session_idle",
              message: "client idle",
            })}\n\n`);
            res.emit("end");
          });
        } else {
          setImmediate(() => {
            res.emit("error", new CliError("test stop"));
          });
        }
      });
      return req;
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"],
      {
        env: {},
        stdout: () => {},
        stderr: (/** @type {string} */ line) => stderrLines.push(line),
        transport: fakeTransport,
        sleepFn: async (/** @type {number} */ ms) => sleepCalls.push(ms),
      }
    ),
    { message: "test stop" }
  );

  assert.deepEqual(sleepCalls, [1000]);
  assert.ok(stderrLines.some((line) => /tail session_idle: client idle/.test(line)));
  assert.ok(!stderrLines.some((line) => /! tail_warning session_idle/.test(line)));
});

test("wdl tail --raw still treats session recycle warnings as control-initiated reconnects", async () => {
  /** @type {number[]} */
  const sleepCalls = [];
  /** @type {string[]} */
  const stdoutLines = [];
  let requestCount = 0;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      requestCount += 1;
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        if (requestCount <= 3) {
          setImmediate(() => {
            res.emit("data", `event: tail_warning\ndata: ${JSON.stringify({
              event: "tail_warning",
              code: "session_idle",
              message: "client idle",
            })}\n\n`);
            res.emit("end");
          });
        } else {
          setImmediate(() => {
            res.emit("error", new CliError("test stop"));
          });
        }
      });
      return req;
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["foo", "--raw", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"],
      {
        env: {},
        stdout: (/** @type {string} */ line) => stdoutLines.push(line),
        stderr: () => {},
        transport: fakeTransport,
        sleepFn: async (/** @type {number} */ ms) => sleepCalls.push(ms),
      }
    ),
    { message: "test stop" }
  );

  assert.deepEqual(sleepCalls, [1000, 1000, 1000]);
  assert.equal(stdoutLines.length, 3);
  assert.deepEqual(JSON.parse(stdoutLines[0]), {
    event: "tail_warning",
    code: "session_idle",
    message: "client idle",
  });
});

test("wdl tail --raw treats non-object SSE JSON payloads as raw values", async () => {
  /** @type {string[]} */
  const stdoutLines = [];
  let requestCount = 0;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      requestCount += 1;
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        if (requestCount === 1) {
          setImmediate(() => {
            res.emit("data", "data: null\n\n");
            res.emit("end");
          });
        } else {
          setImmediate(() => {
            res.emit("error", new CliError("test stop"));
          });
        }
      });
      return req;
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["foo", "--raw", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"],
      {
        env: {},
        stdout: (/** @type {string} */ line) => stdoutLines.push(line),
        stderr: () => {},
        transport: fakeTransport,
        sleepFn: async () => {},
      }
    ),
    { message: "test stop" }
  );

  assert.deepEqual(stdoutLines.map((line) => JSON.parse(line)), [
    { event: "message", raw: null },
  ]);
});

test("wdl tail increases backoff until a stable session resets it", async () => {
  /** @type {number[]} */
  const sleepCalls = [];
  /** @type {string[]} */
  const stderrLines = [];
  let nowMs = 0;
  let requestCount = 0;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      requestCount += 1;
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        setImmediate(() => {
          if (requestCount === 1 || requestCount === 2) {
            res.emit("end");
            return;
          }
          if (requestCount === 3) {
            nowMs += 31_000;
            res.emit("end");
            return;
          }
          res.emit("error", new CliError("test stop"));
        });
      });
      return req;
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"],
      {
        env: {},
        stdout: () => {},
        stderr: (/** @type {string} */ line) => stderrLines.push(line),
        transport: fakeTransport,
        now: () => nowMs,
        sleepFn: async (/** @type {number} */ ms) => {
          sleepCalls.push(ms);
          nowMs += ms;
        },
      }
    ),
    { message: "test stop" }
  );

  assert.deepEqual(sleepCalls, [1000, 2000, 1000]);
  assert.ok(stderrLines.some((line) => /reconnecting in 2000ms/.test(line)));
});

test("wdl tail gives up after reconnects repeatedly hit the cap", async () => {
  /** @type {number[]} */
  const sleepCalls = [];
  let requestCount = 0;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      requestCount += 1;
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        setImmediate(() => res.emit("end"));
      });
      return req;
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["foo", "--max-reconnects", "2", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"],
      {
        env: {},
        stdout: () => {},
        stderr: () => {},
        transport: fakeTransport,
        sleepFn: async (/** @type {number} */ ms) => sleepCalls.push(ms),
      }
    ),
    /gave up after 2 consecutive reconnects/
  );

  assert.equal(requestCount, 5);
  assert.deepEqual(sleepCalls, [1000, 2000, 4000, 5000]);
});

test("wdl tail --max-reconnects 0 disables the cap", async () => {
  /** @type {number[]} */
  const sleepCalls = [];
  let requestCount = 0;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      requestCount += 1;
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        setImmediate(() => {
          if (requestCount >= 6) {
            res.emit("error", new CliError("test stop"));
          } else {
            res.emit("end");
          }
        });
      });
      return req;
    },
  };

  await assert.rejects(
    () => runTailCommand(
      ["foo", "--max-reconnects", "0", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"],
      {
        env: {},
        stdout: () => {},
        stderr: () => {},
        transport: fakeTransport,
        sleepFn: async (/** @type {number} */ ms) => sleepCalls.push(ms),
      }
    ),
    { message: "test stop" }
  );

  assert.equal(requestCount, 6);
  assert.deepEqual(sleepCalls, [1000, 2000, 4000, 5000, 5000]);
});

test("cli package exposes only the wdl binary", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.bin, {
    wdl: "bin/wdl.js",
  });
});

test("cli source imports stay inside the package and its declared dependencies", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const allowedBare = new Set(Object.keys(pkg.dependencies || {}));
  const offenders = [];
  for (const file of listCliJsFiles(root)) {
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(file), specifier);
        const rel = path.relative(root, target);
        if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
          offenders.push(`${path.relative(root, file)} -> ${specifier}`);
        }
        continue;
      }
      if (!specifier.startsWith("node:") && !allowedBare.has(specifier)) {
        offenders.push(`${path.relative(root, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

/** @param {string} source */
function importSpecifiers(source) {
  /** @type {string[]} */
  const specs = [];
  const patterns = [
    /^\s*(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.push(/** @type {string} */ (match[1]));
  }
  return specs;
}

/** @param {string} root */
function listCliJsFiles(root) {
  /** @type {string[]} */
  const out = [];
  for (const dir of ["bin", "commands", "lib"]) {
    out.push(...listJsFiles(path.join(root, dir)));
  }
  return out;
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listJsFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}
