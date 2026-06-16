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
import { SseParser, runTailCommand } from "../../commands/tail.js";
import { runWorkersCommand, formatWorkersList } from "../../commands/workers.js";
import { runWorkflowsCommand } from "../../commands/workflows.js";
import { main as wdlMain } from "../../bin/wdl.js";
import {
  CliError,
  confirmAction,
  loadCliControlEnv,
  loadCliDotEnv,
  readJsonOrFail,
  resolveControlContext,
  resolveControlUrl,
  resolveNamespace,
  writeJsonOr,
  writeStatusLine,
} from "../../lib/common.js";
import {
  LONG_CONTROL_TIMEOUT_MS,
  UNLIMITED_CONTROL_BODY_BYTES,
} from "../../lib/control-fetch.js";
import { mockDeps, response } from "./helpers.js";

function emptyEnv() {
  return /** @type {NodeJS.ProcessEnv} */ ({});
}

function stdinFrom(value) {
  const stdin = Object.assign(new EventEmitter(), {
    setEncoding(_encoding) {},
  });
  queueMicrotask(() => {
    stdin.emit("data", value);
    stdin.emit("end");
  });
  return stdin;
}

function ttyStdinLine(value) {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    paused: false,
    setEncoding(_encoding) {},
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

test("resolveControlUrl strips trailing slashes from flags and env", () => {
  assert.equal(
    resolveControlUrl({ "control-url": "http://ctl.test///" }, {}),
    "http://ctl.test"
  );
  assert.equal(
    resolveControlUrl({}, { CONTROL_URL: "http://ctl.test/" }),
    "http://ctl.test"
  );
});

test("resolveControlUrl requires a configured endpoint", () => {
  assert.throws(() => resolveControlUrl({}, {}), /No control URL configured/);
});

test("resolveControlUrl accepts bare control hosts as https URLs", () => {
  assert.equal(
    resolveControlUrl({ "control-url": "ctl.example" }, {}),
    "https://ctl.example"
  );
  assert.equal(
    resolveControlUrl({}, { CONTROL_URL: "ctl.uat.example/" }),
    "https://ctl.uat.example"
  );
});

test("resolveControlUrl keeps bare local dev control URLs on http", () => {
  assert.equal(
    resolveControlUrl({}, { CONTROL_URL: "ctl.test:8080" }),
    "http://ctl.test:8080"
  );
  assert.equal(
    resolveControlUrl({ "control-url": "localhost:8080/" }, {}),
    "http://localhost:8080"
  );
  assert.equal(
    resolveControlUrl({ "control-url": "[::1]" }, {}),
    "http://[::1]"
  );
  assert.equal(
    resolveControlUrl({ "control-url": "[::1]:8080/" }, {}),
    "http://[::1]:8080"
  );
  assert.equal(
    resolveControlUrl({ "control-url": "ctl.test" }, {}),
    "http://ctl.test"
  );
});

test("resolveControlContext centralizes admin token and headers", () => {
  assert.deepEqual(
    resolveControlContext({ "control-url": "http://ctl.example/" }, { ADMIN_TOKEN: "tok" }),
    {
      controlUrl: "http://ctl.example",
      token: "tok",
      headers: { "x-admin-token": "tok" },
    }
  );
  assert.throws(
    () => resolveControlContext({}, {}),
    /Missing admin token/
  );
});

test("resolveNamespace prefers explicit namespace before WDL_NS", () => {
  assert.equal(resolveNamespace({ ns: "flag" }, { WDL_NS: "env" }), "flag");
  assert.equal(resolveNamespace({}, { WDL_NS: "env" }), "env");
  assert.equal(resolveNamespace({}, {}), undefined);
});

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

test("loadCliDotEnv loads an explicit .env without overriding explicit env", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-env-"));
  const file = path.join(dir, ".env");
  try {
    writeFileSync(
      file,
      [
        "# tenant defaults",
        "ADMIN_TOKEN=from-file",
        "CONTROL_URL=https://ctl.example/",
        "export WDL_NS=demo",
        "CONTROL_CONNECT_HOST='localhost'",
        "CLOUDFLARE_ENV=\"staging\" # ignored: not a WDL platform variable",
        "IGNORED_VALUE=ignored",
        "",
      ].join("\n")
    );

    const env = { ADMIN_TOKEN: "from-shell" };
    assert.deepEqual(loadCliDotEnv(env, file), [
      "CONTROL_URL",
      "WDL_NS",
      "CONTROL_CONNECT_HOST",
    ]);
    assert.equal(env.ADMIN_TOKEN, "from-shell");
    assert.equal(env.CONTROL_URL, "https://ctl.example/");
    assert.equal(env.WDL_NS, "demo");
    assert.equal(env.CONTROL_CONNECT_HOST, "localhost");
    assert.equal(env.CLOUDFLARE_ENV, undefined);
    assert.equal(env.IGNORED_VALUE, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliDotEnv defaults to the current project .env", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-env-cwd-"));
  const previous = process.cwd();
  try {
    writeFileSync(path.join(dir, ".env"), "ADMIN_TOKEN=from-project\nWDL_NS=demo\n");
    process.chdir(dir);

    const env = emptyEnv();
    assert.deepEqual(loadCliDotEnv(env), ["ADMIN_TOKEN", "WDL_NS"]);
    assert.equal(env.ADMIN_TOKEN, "from-project");
    assert.equal(env.WDL_NS, "demo");
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliDotEnv rejects malformed quoted values", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-env-"));
  const file = path.join(dir, ".env");
  try {
    writeFileSync(file, "CONTROL_URL=\"https://ctl.example\" trailing\n");
    assert.throws(
      () => loadCliDotEnv(emptyEnv(), file),
      /Invalid \.env value: unexpected text after quoted value/
    );

    writeFileSync(file, "CONTROL_URL=\"https://ctl.example\n");
    assert.throws(
      () => loadCliDotEnv(emptyEnv(), file),
      /Invalid \.env value: missing closing quote/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliDotEnv overlays the resolved namespace section over base", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-env-"));
  const file = path.join(dir, ".env");
  try {
    writeFileSync(
      file,
      [
        "ADMIN_TOKEN=base-token",
        "CONTROL_URL=https://ctl.base.example",
        "WDL_NS=demo",
        "",
        "[demo]",
        "ADMIN_TOKEN=demo-token",
        "CONTROL_URL=https://ctl.demo.example",
        "",
        "[prod]",
        "ADMIN_TOKEN=prod-token",
        "",
      ].join("\n")
    );

    const env = emptyEnv();
    const protectedKeys = new Set(Object.keys(env));
    assert.deepEqual(loadCliDotEnv(env, file, { protectedKeys }), [
      "ADMIN_TOKEN",
      "CONTROL_URL",
      "WDL_NS",
    ]);
    const ns = resolveNamespace({}, env);
    assert.equal(ns, "demo");
    assert.deepEqual(loadCliDotEnv(env, file, { resolvedNs: ns, loadBase: false, protectedKeys }), [
      "ADMIN_TOKEN",
      "CONTROL_URL",
    ]);

    assert.equal(env.ADMIN_TOKEN, "demo-token");
    assert.equal(env.CONTROL_URL, "https://ctl.demo.example");
    assert.equal(env.WDL_NS, "demo");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliDotEnv supports section-only files", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-env-"));
  const file = path.join(dir, ".env");
  try {
    writeFileSync(
      file,
      [
        "[demo]",
        "ADMIN_TOKEN=demo-token",
        "CONTROL_URL=https://ctl.demo.example",
        "",
      ].join("\n")
    );

    const env = emptyEnv();
    const protectedKeys = new Set();
    assert.deepEqual(loadCliDotEnv(env, file, { protectedKeys }), []);
    assert.deepEqual(loadCliDotEnv(env, file, { resolvedNs: "demo", loadBase: false, protectedKeys }), [
      "ADMIN_TOKEN",
      "CONTROL_URL",
    ]);
    assert.equal(env.ADMIN_TOKEN, "demo-token");
    assert.equal(env.CONTROL_URL, "https://ctl.demo.example");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliDotEnv switches adjacent sections without blank lines", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-env-"));
  const file = path.join(dir, ".env");
  try {
    writeFileSync(
      file,
      [
        "WDL_NS=prod",
        "[demo]",
        "ADMIN_TOKEN=demo-token",
        "[prod]",
        "ADMIN_TOKEN=prod-token",
        "CONTROL_URL=https://ctl.prod.example",
        "",
      ].join("\n")
    );

    const env = emptyEnv();
    const protectedKeys = new Set();
    loadCliDotEnv(env, file, { protectedKeys });
    assert.deepEqual(loadCliDotEnv(env, file, {
      resolvedNs: resolveNamespace({}, env),
      loadBase: false,
      protectedKeys,
    }), ["ADMIN_TOKEN", "CONTROL_URL"]);
    assert.equal(env.ADMIN_TOKEN, "prod-token");
    assert.equal(env.CONTROL_URL, "https://ctl.prod.example");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliDotEnv treats values starting with [ as normal values", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-env-"));
  const file = path.join(dir, ".env");
  try {
    writeFileSync(file, "ADMIN_TOKEN=[abc]\n");
    const env = emptyEnv();
    assert.deepEqual(loadCliDotEnv(env, file), ["ADMIN_TOKEN"]);
    assert.equal(env.ADMIN_TOKEN, "[abc]");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliDotEnv keeps shell env above base and namespace sections", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-env-"));
  const file = path.join(dir, ".env");
  try {
    writeFileSync(
      file,
      [
        "ADMIN_TOKEN=base-token",
        "CONTROL_URL=https://ctl.base.example",
        "WDL_NS=from-file",
        "",
        "[from-shell]",
        "ADMIN_TOKEN=section-token",
        "CONTROL_URL=https://ctl.section.example",
        "",
      ].join("\n")
    );

    const env = {
      ADMIN_TOKEN: "shell-token",
      CONTROL_URL: "https://ctl.shell.example",
      WDL_NS: "from-shell",
    };
    const protectedKeys = new Set(Object.keys(env));
    assert.deepEqual(loadCliDotEnv(env, file, { protectedKeys }), []);
    assert.deepEqual(loadCliDotEnv(env, file, {
      resolvedNs: resolveNamespace({}, env),
      loadBase: false,
      protectedKeys,
    }), []);

    assert.equal(env.ADMIN_TOKEN, "shell-token");
    assert.equal(env.CONTROL_URL, "https://ctl.shell.example");
    assert.equal(env.WDL_NS, "from-shell");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliDotEnv loads only base when namespace is unresolved or missing", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-env-"));
  const file = path.join(dir, ".env");
  try {
    writeFileSync(
      file,
      [
        "CONTROL_URL=https://ctl.base.example",
        "",
        "[demo]",
        "ADMIN_TOKEN=demo-token",
        "",
      ].join("\n")
    );

    const env = emptyEnv();
    assert.deepEqual(loadCliDotEnv(env, file), ["CONTROL_URL"]);
    assert.equal(env.CONTROL_URL, "https://ctl.base.example");
    assert.equal(env.ADMIN_TOKEN, undefined);

    assert.deepEqual(loadCliDotEnv(env, file, {
      resolvedNs: "prod",
      loadBase: false,
      protectedKeys: new Set(),
    }), []);
    assert.equal(env.ADMIN_TOKEN, undefined);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliDotEnv accepts opaque operator reserved namespace sections", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-env-"));
  const file = path.join(dir, ".env");
  try {
    writeFileSync(
      file,
      [
        "WDL_NS=__reserved__",
        "",
        "[__reserved__]",
        "ADMIN_TOKEN=reserved-token",
        "",
      ].join("\n")
    );

    const env = emptyEnv();
    const protectedKeys = new Set();
    loadCliDotEnv(env, file, { protectedKeys });
    loadCliDotEnv(env, file, { resolvedNs: resolveNamespace({}, env), loadBase: false, protectedKeys });
    assert.equal(env.ADMIN_TOKEN, "reserved-token");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliDotEnv rejects invalid section names", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-env-"));
  const file = path.join(dir, ".env");
  try {
    for (const name of ["Demo", "my ns", "", "admin"]) {
      writeFileSync(file, `[${name}]\nADMIN_TOKEN=tok\n`);
      assert.throws(
        () => loadCliDotEnv(emptyEnv(), file),
        /Invalid \.env line 1: invalid section name/
      );
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliDotEnv ignores WDL_NS in selected section with a warning", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-env-"));
  const file = path.join(dir, ".env");
  try {
    writeFileSync(
      file,
      [
        "WDL_NS=demo",
        "",
        "[demo]",
        "WDL_NS=prod",
        "ADMIN_TOKEN=demo-token",
        "",
      ].join("\n")
    );

    const warnings = [];
    const env = emptyEnv();
    const protectedKeys = new Set();
    loadCliDotEnv(env, file, { protectedKeys });
    assert.deepEqual(loadCliDotEnv(env, file, {
      resolvedNs: "demo",
      loadBase: false,
      protectedKeys,
      warn: (message) => warnings.push(message),
    }), ["ADMIN_TOKEN"]);

    assert.equal(env.WDL_NS, "demo");
    assert.equal(env.ADMIN_TOKEN, "demo-token");
    assert.deepEqual(warnings, ["Ignoring WDL_NS in .env section [demo]"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliDotEnv does not warn for WDL_NS in an unselected section", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-env-"));
  const file = path.join(dir, ".env");
  try {
    writeFileSync(
      file,
      [
        "WDL_NS=demo",
        "",
        "[prod]",
        "WDL_NS=ignored",
        "ADMIN_TOKEN=prod-token",
        "",
      ].join("\n")
    );

    const warnings = [];
    const env = emptyEnv();
    const protectedKeys = new Set();
    loadCliDotEnv(env, file, { protectedKeys });
    assert.deepEqual(loadCliDotEnv(env, file, {
      resolvedNs: "demo",
      loadBase: false,
      protectedKeys,
      warn: (message) => warnings.push(message),
    }), []);

    assert.equal(env.WDL_NS, "demo");
    assert.equal(env.ADMIN_TOKEN, undefined);
    assert.deepEqual(warnings, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliDotEnv ignores a missing file", () => {
  const env = emptyEnv();
  assert.deepEqual(loadCliDotEnv(env, "/tmp/wdl-missing-env-file"), []);
  assert.deepEqual(env, {});
});

test("loadCliControlEnv drops a .env control endpoint when the token is from the shell", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-crossorigin-"));
  try {
    writeFileSync(path.join(dir, ".env"), "CONTROL_URL=https://ctl.attacker.example\n");
    /** @type {NodeJS.ProcessEnv} */
    const env = { ADMIN_TOKEN: "shell-token" };
    const warned = [];
    loadCliControlEnv(env, {
      dotenvPath: path.join(dir, ".env"),
      onCrossOrigin: (line) => warned.push(line),
    });
    assert.equal(env.CONTROL_URL, undefined, "cross-origin .env endpoint must be ignored");
    assert.equal(warned.length, 1);
    assert.match(warned[0], /ignoring CONTROL_URL from \.env/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliControlEnv treats a .env endpoint as cross-origin when --token is used (decoy token ignored)", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-decoy-token-"));
  try {
    // Malicious dir: decoy token + attacker URL. Shell has no token; the user
    // passes the real one via --token, so the .env token is not the credential
    // in use and the .env endpoint must NOT be trusted.
    writeFileSync(path.join(dir, ".env"), "ADMIN_TOKEN=decoy\nCONTROL_URL=https://ctl.attacker.example\n");
    /** @type {NodeJS.ProcessEnv} */
    const env = {};
    const warned = [];
    loadCliControlEnv(env, {
      dotenvPath: path.join(dir, ".env"),
      tokenFromFlag: true,
      onCrossOrigin: (line) => warned.push(line),
    });
    assert.equal(env.CONTROL_URL, undefined, "decoy .env token must not make the attacker URL trusted");
    assert.equal(warned.length, 1);
    assert.match(warned[0], /ignoring CONTROL_URL from \.env/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliControlEnv trusts a .env control endpoint when the token is also from .env", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-samesource-"));
  try {
    writeFileSync(path.join(dir, ".env"), "ADMIN_TOKEN=env-token\nCONTROL_URL=https://ctl.mine.example\n");
    /** @type {NodeJS.ProcessEnv} */
    const env = {};
    const warned = [];
    loadCliControlEnv(env, {
      dotenvPath: path.join(dir, ".env"),
      onCrossOrigin: (line) => warned.push(line),
    });
    assert.equal(env.CONTROL_URL, "https://ctl.mine.example");
    assert.equal(env.ADMIN_TOKEN, "env-token");
    assert.deepEqual(warned, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliControlEnv keeps the documented multi-ns layout (URL in base, token in [ns])", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-multins-"));
  try {
    writeFileSync(path.join(dir, ".env"),
      "CONTROL_URL=https://ctl.shared.example\nWDL_NS=acme\n\n[acme]\nADMIN_TOKEN=acme-token\n");
    /** @type {NodeJS.ProcessEnv} */
    const env = {};
    const warned = [];
    loadCliControlEnv(env, {
      dotenvPath: path.join(dir, ".env"),
      onCrossOrigin: (line) => warned.push(line),
    });
    assert.equal(env.CONTROL_URL, "https://ctl.shared.example");
    assert.equal(env.ADMIN_TOKEN, "acme-token");
    assert.deepEqual(warned, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("commands warn when the admin token would travel over plain http to a non-local host", async () => {
  const warnings = [];
  await runWorkersCommand(["--ns", "demo", "--control-url", "http://ctl.prod.example"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: () => {},
    warn: (line) => warnings.push(line),
    controlFetch: async () => response({ workers: [] }),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /plain http on a non-local host/);

  const quiet = [];
  await runWorkersCommand(["--ns", "demo", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: () => {},
    warn: (line) => quiet.push(line),
    controlFetch: async () => response({ workers: [] }),
  });
  assert.deepEqual(quiet, []);
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
  assert.deepEqual(calls[0].init.headers, { "x-admin-token": "tok" });
  assert.deepEqual(lines, ["api\tactive=v2\tversions=v1,v2\tsecrets=yes"]);
});

test("workers command does not double-slash paths when CONTROL_URL has a trailing slash", async () => {
  const calls = [];
  await runWorkersCommand(["--ns", "demo"], {
    env: {
      ADMIN_TOKEN: "tok",
      CONTROL_URL: "http://ctl.test/",
    },
    stdout: () => {},
    controlFetch: async (url, init = {}) => {
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
  const lines = [];
  await runWorkersCommand(["--ns", "demo", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: (line) => lines.push(line),
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
  assert.deepEqual(
    formatWorkersList({
      workers: [{ name: "draft", activeVersion: null, versions: ["v1"], hasSecrets: false }],
    }),
    ["draft\tactive=-\tversions=v1\tsecrets=no"]
  );
});

test("tenant lifecycle commands default namespace from WDL_NS", async () => {
  const workerCalls = [];
  await runWorkersCommand(["--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
    stdout: () => {},
    controlFetch: async (url, init = {}) => {
      workerCalls.push({ url, init });
      return response({ namespace: "demo", workers: [] });
    },
  });
  assert.equal(workerCalls[0].url, "http://ctl.test/ns/demo/workers");

  const secretCalls = [];
  await runSecretCommand(["list", "--worker", "api", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
    stdout: () => {},
    controlFetch: async (url, init = {}) => {
      secretCalls.push({ url, init });
      return response({ keys: [] });
    },
  });
  assert.equal(secretCalls[0].url, "http://ctl.test/ns/demo/worker/api/secrets");

  const deleteCalls = [];
  await runDeleteCommand(["version", "api", "v1", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
    stdout: () => {},
    controlFetch: async (url, init = {}) => {
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
  assert.equal(calls[0].init.method, "DELETE");
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
  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(lines, [JSON.stringify(body, null, 2)]);
});

test("delete worker requires confirmation unless --yes or --dry-run is used", async () => {
  const calls = [];
  await assert.rejects(
    () => runDeleteCommand(["worker", "--ns", "demo", "api", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdin: stdinFrom(""),
      controlFetch: async (url, init = {}) => {
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
    controlFetch: async (url, init = {}) => {
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
  const calls = [];
  const prompts = [];
  const stdin = ttyStdinLine("yes\n");

  await runDeleteCommand(["worker", "--ns", "demo", "api", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdin,
    stderr: (text) => prompts.push(text),
    stdout: () => {},
    controlFetch: async (url, init = {}) => {
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

test("secret list accepts flags before the subcommand", async () => {
  const { calls, deps } = mockDeps({ keys: [] });

  await runSecretCommand(["--ns", "demo", "--worker", "api", "--control-url", "http://ctl.test", "list"], deps);

  assert.equal(calls[0].url, "http://ctl.test/ns/demo/worker/api/secrets");
});

test("secret list uses encoded namespace and worker path segments", async () => {
  const calls = [];
  const lines = [];
  await runSecretCommand(
    ["list", "--ns", "demo space", "--worker", "api/slash", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (line) => lines.push(line),
      controlFetch: async (url, init = {}) => {
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
  const lines = [];
  await runSecretCommand(
    ["list", "--json", "--ns", "demo", "--scope", "ns", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (line) => lines.push(line),
      controlFetch: async () => response({ namespace: "demo", keys: ["A", "B"] }),
    }
  );

  assert.deepEqual(lines, [JSON.stringify({ namespace: "demo", keys: ["A", "B"] }, null, 2)]);
});

test("secret list tolerates a response without a keys array", async () => {
  const lines = [];
  await runSecretCommand(
    ["list", "--ns", "demo", "--scope", "ns", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (line) => lines.push(line),
      controlFetch: async () => response({ namespace: "demo" }),
    }
  );
  assert.deepEqual(lines, ["(no secrets)"]);
});

test("secret put reads stdin, trims one newline, and encodes key", async () => {
  const calls = [];
  const lines = [];
  await runSecretCommand(
    ["put", "--ns", "demo", "--scope", "ns", "KEY/ONE", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdin: stdinFrom("secret-value\n"),
      stdout: (line) => lines.push(line),
      controlFetch: async (url, init = {}) => {
        calls.push({ url, init });
        return response({ deleted: false });
      },
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/secrets/KEY%2FONE");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.body, JSON.stringify({ value: "secret-value" }));
  assert.deepEqual(lines, ["✓ demo (ns)/KEY/ONE set — effect on next natural cold-load"]);
});

test("writeStatusLine escapes terminal control bytes in the assembled line", () => {
  const lines = [];
  writeStatusLine((l) => lines.push(l), `ok ${String.fromCharCode(27)}[2J done`);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], new RegExp(String.fromCharCode(27)), "raw ESC must not pass through");
});

test("writeJsonOr emits JSON and reports handled, or defers to the human path", () => {
  const out = [];
  assert.equal(writeJsonOr(true, { a: 1 }, (l) => out.push(l)), true);
  assert.equal(out[0], JSON.stringify({ a: 1 }, null, 2));
  out.length = 0;
  assert.equal(writeJsonOr(false, { a: 1 }, (l) => out.push(l)), false);
  assert.equal(out.length, 0, "nothing written when not json");
});

test("confirmAction escapes terminal controls in its refusal message", async () => {
  const esc = String.fromCharCode(27);
  await assert.rejects(
    () => confirmAction({ stdin: /** @type {any} */ ({ isTTY: false }), action: `delete ${esc}[2J thing` }),
    (err) => {
      assert.doesNotMatch(/** @type {Error} */ (err).message, new RegExp(esc), "raw ESC must not be in the refusal error");
      assert.match(/** @type {Error} */ (err).message, /Refusing to delete/);
      return true;
    }
  );
});

test("secret put escapes terminal controls from a raw keyArg in the status line", async () => {
  const esc = String.fromCharCode(27);
  const lines = [];
  await runSecretCommand(
    ["put", "--ns", "demo", "--scope", "ns", `KEY${esc}[2J`, "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdin: stdinFrom("v\n"),
      stdout: (line) => lines.push(line),
      controlFetch: async () => response({ deleted: false }),
    }
  );
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], new RegExp(esc), "raw ESC from keyArg must not reach stdout");
});

test("secret put reads one tty line without waiting for EOF", async () => {
  const calls = [];
  const prompts = [];
  const stdin = ttyStdinLine("typed-value\n");
  await runSecretCommand(
    ["put", "--ns", "demo", "--scope", "ns", "KEY", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdin,
      stdout: () => {},
      stderr: (text) => prompts.push(text),
      controlFetch: async (url, init = {}) => {
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
  const calls = [];
  const lines = [];
  await runSecretCommand(
    ["put", "--ns", "demo", "--worker", "api", "KEY", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdin: stdinFrom("secret-value\n"),
      stdout: (line) => lines.push(line),
      controlFetch: async (url, init = {}) => {
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

test("secret put and delete support raw json output", async () => {
  const calls = [];
  const putLines = [];
  await runSecretCommand(
    ["put", "--json", "--ns", "demo", "--worker", "api", "KEY", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdin: stdinFrom("secret-value\n"),
      stdout: (line) => putLines.push(line),
      controlFetch: async (url, init = {}) => {
        calls.push({ url, init });
        return response({ previousVersion: "v1", version: "v2" });
      },
    }
  );
  assert.deepEqual(putLines, [JSON.stringify({ previousVersion: "v1", version: "v2" }, null, 2)]);

  const deleteLines = [];
  await runSecretCommand(
    ["delete", "--json", "--ns", "demo", "--worker", "api", "KEY", "--yes", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (line) => deleteLines.push(line),
      controlFetch: async (url, init = {}) => {
        calls.push({ url, init });
        return response({ deleted: true, previousVersion: "v2", version: "v3" });
      },
    }
  );
  assert.deepEqual(deleteLines, [JSON.stringify({ deleted: true, previousVersion: "v2", version: "v3" }, null, 2)]);
});

test("secret list refuses ambiguous scope before calling control", async () => {
  const calls = [];
  await assert.rejects(
    () => runSecretCommand(["list", "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      controlFetch: async (url, init = {}) => {
        calls.push({ url, init });
        return response({});
      },
    }),
    /must specify either --worker <name> \(worker-level\) or --scope ns \(ns-level\)/
  );

  assert.equal(calls.length, 0);
});

test("secret delete calls worker endpoint and reports promoted bump", async () => {
  const calls = [];
  const lines = [];
  await runSecretCommand(
    ["delete", "--ns", "demo", "--worker", "api", "KEY", "--yes", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (line) => lines.push(line),
      controlFetch: async (url, init = {}) => {
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
  const calls = [];
  await assert.rejects(
    () => runSecretCommand(["delete", "--ns", "demo", "--worker", "api", "KEY", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdin: stdinFrom(""),
      controlFetch: async (url, init = {}) => {
        calls.push({ url, init });
        return response({});
      },
    }),
    /Refusing to delete secret "demo\/api\/KEY" without interactive confirmation/
  );
  assert.equal(calls.length, 0);
});

test("secret delete proceeds after interactive confirmation", async () => {
  const calls = [];
  const prompts = [];
  const stdin = ttyStdinLine("y\n");

  await runSecretCommand(["delete", "--ns", "demo", "--scope", "ns", "KEY", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdin,
    stderr: (text) => prompts.push(text),
    stdout: () => {},
    controlFetch: async (url, init = {}) => {
      calls.push({ url, init });
      return response({ deleted: true });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/secrets/KEY");
  assert.deepEqual(prompts, ['Are you sure you want to delete secret "demo (ns)/KEY"? [y/N] ']);
  assert.equal(stdin.paused, true);
});

test("secret delete warning does not claim deletion when control reports deleted=false", async () => {
  const lines = [];
  await runSecretCommand(
    ["delete", "--ns", "demo", "--worker", "api", "KEY", "--yes", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (line) => lines.push(line),
      controlFetch: async () => response({
        deleted: false,
        warnings: [
          { kind: "promote_failed", reason: "active version changed", nextPickup: "next deploy" },
        ],
      }),
    }
  );

  assert.deepEqual(lines, [
    "⚠ demo/api/KEY unchanged — reload deferred: active version changed",
    "  next pickup: next deploy",
  ]);
});

test("r2 buckets and objects commands call encoded control endpoints", async () => {
  const calls = [];
  const lines = [];
  const bytes = [];
  const stdoutStream = new Writable({
    write(chunk, _encoding, callback) {
      bytes.push(Buffer.from(chunk).toString("utf8"));
      callback();
    },
  });
  const deps = {
    env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
    stdout: (line) => lines.push(line),
    stdoutStream,
    controlFetch: async (url, init = {}) => {
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
  assert.equal(lines.at(-1), "OK demo space/uploads/dir/file.txt deleted");
});

test("r2 buckets list accepts flags before the group/action", async () => {
  const { calls, deps } = mockDeps({ namespace: "demo", buckets: [] });

  await runR2Command(["--ns", "demo", "--control-url", "http://ctl.test", "buckets", "list"], deps);

  assert.equal(calls[0].url, "http://ctl.test/ns/demo/r2/buckets");
});

test("r2 object get waits for stdout backpressure", async () => {
  const events = [];
  const stdoutStream = Object.assign(new EventEmitter(), {
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

test("r2 object get --out escapes a control-char path in the success line", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-r2-out-escape-"));
  try {
    const esc = String.fromCharCode(27);
    const outPath = path.join(dir, `file${esc}[2J.bin`);
    const lines = [];
    await runR2Command(
      ["objects", "get", "--ns", "demo", "uploads", "file.txt", "--out", outPath, "--control-url", "http://ctl.test"],
      {
        env: { ADMIN_TOKEN: "tok" },
        stdout: (line) => lines.push(line),
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
    env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
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

test("r2 object key rejects empty path segments", async () => {
  await assert.rejects(
    () => runR2Command(["objects", "get", "bkt", "a//b", "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdout: () => {},
      controlFetch: async () => response({}),
    }),
    /empty path segments/
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
  const calls = [];
  await assert.rejects(
    () => runR2Command(["objects", "delete", "--ns", "demo", "uploads", "a.txt", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdin: stdinFrom(""),
      controlFetch: async (url, init = {}) => {
        calls.push({ url, init });
        return response({});
      },
    }),
    /Refusing to delete R2 object "demo\/uploads\/a.txt" without interactive confirmation/
  );
  assert.equal(calls.length, 0);
});

test("workflows commands call encoded control endpoints", async () => {
  const calls = [];
  const lines = [];
  const deps = {
    env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
    stdout: (line) => lines.push(line),
    controlFetch: async (url, init = {}) => {
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
  const calls = [];
  const deps = {
    env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
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
    () => runWorkflowsCommand(["restart", "--ns", "demo", "api", "orders", "id", "extra", "--yes"], deps),
    /workflows restart received unexpected argument: extra/
  );
  assert.equal(calls.length, 0);
});

test("wdl dispatcher routes documented commands and rejects unknown commands", async () => {
  const oldExit = process.exit;
  const oldError = console.error;
  const seen = [];

  process.exit = (code) => {
    throw new Error(`exit:${code}`);
  };
  console.error = (msg) => seen.push(String(msg));

  try {
    await assert.rejects(() => wdlMain(["help"], { loadEnv: null }), /exit:0/);
    assert.ok(seen.at(-1).includes("wdl <command> [args] [options]"));
    // The command table is derived from each command's { name, summary }; assert
    // the metadata content renders (and the alias note) without pinning column spacing.
    assert.ok(seen.at(-1).includes("Manage D1 databases, SQL execution, and migrations."));
    assert.ok(seen.at(-1).includes("Manage namespace-level or worker-level secrets. (alias: secrets)"));
    assert.ok(seen.at(-1).includes("Inspect and delete R2 virtual bucket data."));
    assert.ok(seen.at(-1).includes("Live-tail worker console output and uncaught exceptions."));
    // workflows is the widest name, so its summary sits one space after it.
    assert.ok(seen.at(-1).includes("workflows Inspect and control Workflow instances."));

    await assert.rejects(() => wdlMain(["del"], { loadEnv: null }), /exit:1/);
    assert.ok(seen.some((line) => line.includes("unknown command: del")));

    await assert.rejects(() => wdlMain(["worker-list"], { loadEnv: null }), /exit:1/);
    assert.ok(seen.some((line) => line.includes("unknown command: worker-list")));
  } finally {
    process.exit = oldExit;
    console.error = oldError;
  }
});

test("wdl dispatcher prints the CLI version for --version, -v, and version", async () => {
  const oldLog = console.log;
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
async function withMockedExit(fn) {
  const oldExit = process.exit;
  const oldError = console.error;
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
  const calls = [];
  // secret's missing-subcommand CliError fires after autoload, keeping the
  // dispatch harmless without needing a control-plane mock.
  await withMockedExit(async () => {
    await assert.rejects(
      () => wdlMain(["secret", "--ns", "demo"], {
        env: {},
        loadEnv: (_env, _path, options) => calls.push(options),
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
  const calls = [];
  await withMockedExit(async () => {
    await assert.rejects(
      () => wdlMain(["secret", "--ns", "first", "--ns=last"], {
        env: {},
        loadEnv: (_env, _path, options) => calls.push(options),
      }),
      /exit:1/
    );
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].resolvedNs, "last");
});

test("wdl dispatcher skips dotenv when help is requested", async () => {
  const calls = [];
  const oldLog = console.log;
  console.log = () => {};
  try {
    await wdlMain(["workers", "--ns", "demo", "--help"], {
      env: {},
      loadEnv: (_env, _path, options) => calls.push(options),
    });
    // The positional alias form must skip autoload too — including with
    // flags present — so a broken .env cannot block `wdl <command> help`.
    await wdlMain(["workers", "help"], {
      env: {},
      loadEnv: (_env, _path, options) => calls.push(options),
    });
    await wdlMain(["workers", "--ns", "demo", "help"], {
      env: {},
      loadEnv: (_env, _path, options) => calls.push(options),
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
    writeFileSync(path.join(dir, ".env"), "BADLINE\n");
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
  const errors = [];
  const calls = [];

  process.exit = (code) => {
    throw new Error(`exit:${code}`);
  };
  console.error = (msg) => errors.push(String(msg));

  try {
    await assert.rejects(
      () => wdlMain(["help"], { loadEnv: () => calls.push("help") }),
      /exit:0/
    );
    await assert.rejects(
      () => wdlMain(["bogus"], { loadEnv: () => calls.push("bogus") }),
      /exit:1/
    );
    assert.deepEqual(calls, []);
    assert.ok(errors.some((line) => line.includes("unknown command: bogus")));
  } finally {
    process.exit = oldExit;
    console.error = oldError;
  }
});

test("wdl dispatcher prints parseArgs errors without a Node stack", async () => {
  const oldExit = process.exit;
  const oldError = console.error;
  const errors = [];

  process.exit = (code) => {
    throw new Error(`exit:${code}`);
  };
  console.error = (msg) => errors.push(String(msg));

  try {
    await assert.rejects(
      () => wdlMain(["tail", "--dsf"], { loadEnv: null }),
      /exit:1/
    );
  } finally {
    process.exit = oldExit;
    console.error = oldError;
  }

  assert.equal(errors.length, 1);
  assert.match(errors[0], /error: Unknown option '--dsf'/);
  assert.doesNotMatch(errors[0], /TypeError|parse_args|Node\.js/);
});

test("SseParser dispatches event/id/data on blank line per SSE rules", () => {
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
  await assert.rejects(
    () => runTailCommand(
      ["foo", "--max-reconnects", "forever", "--ns", "demo", "--token", "t",
       "--control-url", "http://ctl.test"],
      { env: {}, stdout: () => {}, stderr: () => {} }
    ),
    /--max-reconnects must be a non-negative integer/
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
  const stdoutLines = [];
  await runTailCommand(
    ["--help", "--max-reconnects", "forever"],
    {
      env: {},
      stdout: (line) => stdoutLines.push(line),
      stderr: () => {},
    }
  );

  assert.ok(stdoutLines.some((line) => /--max-reconnects/.test(line)));
});

test("wdl tail escapes control error details", async () => {
  const fakeTransport = {
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

function fakeHttpReq() {
  return Object.assign(new EventEmitter(), {
    end() {},
    destroy() {},
  });
}

function fakeHttpRes() {
  return Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {},
    setEncoding() {},
  });
}

test("wdl tail renders fetch, scheduled, and queue invocation events", async () => {
  const stdoutLines = [];
  const fakeTransport = {
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
        stdout: (line) => stdoutLines.push(line),
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
  const stdoutLines = [];
  let emitted = false;
  const fakeTransport = {
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
        stdout: (line) => stdoutLines.push(line),
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
  const requestsSeen = [];
  const fakeTransport = {
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
  assert.equal(requestsSeen[0].headers.Host, "ctl.uat.example");
  assert.equal(requestsSeen[0].path, "/ns/demo/logs/tail?worker=kv-demo");
});

test("wdl tail sends --since on the initial URL, not duplicated as Last-Event-ID", async () => {
  const requestsSeen = [];
  const fakeTransport = {
    request(opts, cb) {
      requestsSeen.push({ path: opts.path, headers: { ...opts.headers } });
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
  const requestsSeen = [];
  const fakeTransport = {
    request(opts, cb) {
      requestsSeen.push({ path: opts.path, headers: { ...opts.headers } });
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
  const requestsSeen = [];
  const fakeTransport = {
    request(opts, cb) {
      requestsSeen.push({ path: opts.path, headers: { ...opts.headers } });
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
  const stderrLines = [];
  const fakeTransport = {
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
        stderr: (line) => stderrLines.push(line),
        transport: fakeTransport,
      }
    ),
    { message: "test stop" }
  );

  assert.ok(stderrLines.includes("tail connected; waiting for events…"));
});

test("wdl tail reconnects with Last-Event-ID after transport errors", async () => {
  const requestsSeen = [];
  const stderrLines = [];
  const fakeTransport = {
    request(opts, cb) {
      requestsSeen.push({ path: opts.path, headers: { ...opts.headers } });
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
              res.emit("error", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
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
        stderr: (line) => stderrLines.push(line),
        transport: fakeTransport,
        sleepFn: async () => {},
      }
    ),
    { message: "test stop" }
  );

  assert.ok(requestsSeen.length >= 2);
  assert.equal(requestsSeen[0].headers["last-event-id"], undefined);
  assert.equal(requestsSeen[1].headers["last-event-id"], "100-0");
  assert.ok(stderrLines.some((line) => /transport error/i.test(line)));
});

test("wdl tail increases backoff until a stable session resets it", async () => {
  const sleepCalls = [];
  const stderrLines = [];
  let nowMs = 0;
  let requestCount = 0;
  const fakeTransport = {
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
        stderr: (line) => stderrLines.push(line),
        transport: fakeTransport,
        now: () => nowMs,
        sleepFn: async (ms) => {
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

function importSpecifiers(source) {
  const specs = [];
  const patterns = [
    /^\s*(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.push(match[1]);
  }
  return specs;
}

function listCliJsFiles(root) {
  const out = [];
  for (const dir of ["bin", "commands", "lib"]) {
    out.push(...listJsFiles(path.join(root, dir)));
  }
  return out;
}

function listJsFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}
