import { test } from "node:test";
import assert from "node:assert/strict";
import { defineCommand } from "../../lib/command.js";
import { CliError, defineCliOption } from "../../lib/common.js";
import { ESC, assertNoRawTerminalControls, response } from "./helpers.js";

/** @typedef {Parameters<typeof defineCommand>[0]} CommandSpec */
/** @typedef {import("../../lib/command.js").CommandContext} CommandContext */

// Most tests don't care about name/summary; default them so each case only
// states the fields it exercises.
/** @param {Omit<CommandSpec, "name" | "summary"> & { name?: string, summary?: string }} spec */
const define = (spec) => defineCommand({ name: "t", summary: "t", ...spec });

test("defineCommand assembles flag presets and custom options", async () => {
  let seen = /** @type {{ values: Record<string, unknown>, positionals: string[] }} */ (
    /** @type {unknown} */ (null)
  );
  const cmd = define({
    options: ["ns", "control", "json", "help", defineCliOption("tag", { type: "string" }, "--tag <tag>", "Tag.")],
    usage: () => "usage",
    run: ({ values, positionals }) => { seen = { values, positionals }; },
  });
  await cmd.run(["pos1", "--ns", "demo", "--json", "--tag", "x", "--token", "t"], { env: {} });
  assert.equal(seen.values.ns, "demo");
  assert.equal(seen.values.json, true);
  assert.equal(seen.values.tag, "x");
  assert.equal(seen.values.token, "t");
  assert.deepEqual(seen.positionals, ["pos1"]);
});

test("defineCommand exposes name/summary metadata and the parse schema", () => {
  const cmd = defineCommand({ name: "workers", summary: "List workers.", options: ["ns", "help"], usage: () => "", run: () => {} });
  const { parseOptions, ...meta } = cmd.meta;
  assert.deepEqual(meta, { name: "workers", summary: "List workers.", autoloadEnv: true });
  // The dispatcher pre-scans argv with this schema (ns overlay, help alias).
  assert.deepEqual(Object.keys(parseOptions).toSorted(), ["help", "ns"]);
});

test("defineCommand direct runner escapes parseArgs errors", async () => {
  const bad = `--bad${ESC}[2J\nFORGED\rBAD`;
  const cmd = define({
    options: ["ns"],
    usage: () => "usage",
    run: () => {
      throw new Error("run body should not be called");
    },
  });

  await assert.rejects(
    () => cmd.run([bad]),
    (err) => {
      assert(err instanceof CliError);
      assertNoRawTerminalControls(err.message, "direct runner errors");
      assert.match(err.message, /--bad\\u001b\[2J\\nFORGED\\rBAD/);
      return true;
    },
  );
});

test("defineCommand exposes autoloadEnv metadata", () => {
  const cmd = defineCommand({ name: "doctor", summary: "Check local state.", autoloadEnv: false, usage: () => "", run: () => {} });
  const { parseOptions, ...meta } = cmd.meta;
  assert.deepEqual(meta, { name: "doctor", summary: "Check local state.", autoloadEnv: false });
  assert.deepEqual(parseOptions, {});
});

test("defineCommand rejects an unknown option preset", () => {
  assert.throws(
    () => define({ options: ["bogus"], usage: () => "", run: () => {} }),
    /unknown option preset "bogus"/,
  );
});

test("defineCommand rejects raw parse option objects", () => {
  assert.throws(
    () => define({
      // A raw parse-option object is not a valid OptionListItem; the command
      // must reject it at runtime, so feed it through an unknown cast.
      options: [/** @type {import("../../lib/common.js").OptionListItem} */ (/** @type {unknown} */ ({ tag: { type: "string" } }))],
      usage: () => "",
      run: () => {},
    }),
    /option entries must be preset names or option specs/,
  );
});

test("defineCommand validates required fields", () => {
  /** @type {CommandSpec} */
  const ok = { name: "n", summary: "s", usage: () => "", run: () => {} };
  // Each case feeds a deliberately invalid spec to exercise runtime validation;
  // cast through unknown since the bad shapes do not satisfy CommandSpec.
  /** @param {object} spec @returns {CommandSpec} */
  const badSpec = (spec) => /** @type {CommandSpec} */ (/** @type {unknown} */ (spec));
  assert.throws(() => defineCommand(badSpec({ ...ok, name: "" })), /name must be a non-empty string/);
  assert.throws(() => defineCommand(badSpec({ ...ok, summary: "" })), /summary must be a non-empty string/);
  assert.throws(() => defineCommand(badSpec({ ...ok, usage: undefined })), /usage must be a function/);
  assert.throws(() => defineCommand(badSpec({ ...ok, run: undefined })), /run must be a function/);
});

test("--help prints usage and skips the run body", async () => {
  let ran = false;
  /** @type {string[]} */
  const lines = [];
  const cmd = define({
    options: ["help"],
    usage: () => "USAGE TEXT",
    run: () => { ran = true; },
  });
  await cmd.run(["--help"], { stdout: (/** @type {string} */ line) => lines.push(line) });
  assert.equal(ran, false);
  assert.deepEqual(lines, ["USAGE TEXT"]);
});

test("positional help prints usage and skips the run body", async () => {
  let ran = false;
  /** @type {string[]} */
  const lines = [];
  const cmd = define({
    options: ["help"],
    usage: () => "USAGE TEXT",
    run: () => { ran = true; },
  });
  await cmd.run(["help"], { stdout: (/** @type {string} */ line) => lines.push(line) });
  assert.equal(ran, false);
  assert.deepEqual(lines, ["USAGE TEXT"]);
});

test("context applies dep defaults, injected overrides, and passthrough deps", async () => {
  let ctx = /** @type {CommandContext & Record<string, unknown>} */ (
    /** @type {unknown} */ (null)
  );
  const cmd = define({
    options: ["help"],
    defaults: { custom: "default-custom" },
    usage: () => "",
    run: ({ context }) => { ctx = context; },
  });
  const injectedStdout = () => {};
  await cmd.run([], { stdout: injectedStdout, custom: "injected", extra: 42 });
  assert.equal(ctx.stdout, injectedStdout);        // injected wins over default
  assert.equal(typeof ctx.stderr, "function");      // standard default present
  assert.equal(ctx.custom, "injected");             // injected wins over command default
  assert.equal(ctx.extra, 42);                       // unknown dep passed through
});

test("context.nsUrl builds an encoded namespace URL", async () => {
  /** @type {string | undefined} */
  let url;
  const cmd = define({
    options: ["ns", "control"],
    usage: () => "",
    run: ({ context }) => { url = context.nsUrl("worker", "a b", "versions", "v/1"); },
  });
  await cmd.run(
    ["--ns", "demo space", "--control-url", "http://ctl.test", "--token", "t"],
    { env: {} },
  );
  assert.equal(url, "http://ctl.test/ns/demo%20space/worker/a%20b/versions/v%2F1");
});

test("context.nsUrl throws when the namespace is unresolved", async () => {
  const cmd = define({
    options: ["ns", "control"],
    usage: () => "",
    run: ({ context }) => context.nsUrl("workers"),
  });
  await assert.rejects(
    () => cmd.run(["--control-url", "http://ctl.test", "--token", "t"], { env: {} }),
    /namespace not resolved/,
  );
});

test("context.fetchJson fetches with the given init and parses JSON", async () => {
  let got = /** @type {{ url: string, init: import("../../lib/control-fetch.js").ControlFetchInit }} */ (
    /** @type {unknown} */ (null)
  );
  const cmd = define({
    options: [],
    usage: () => "",
    run: ({ context }) => context.fetchJson("http://x/y", { headers: { a: "b" } }, "do thing"),
  });
  const body = await cmd.run([], {
    env: { CONTROL_CONNECT_HOST: "127.0.0.1:18080" },
    /** @param {string} url @param {import("../../lib/control-fetch.js").ControlFetchInit} init */
    controlFetch: async (url, init) => { got = { url, init }; return response({ ok: 1 }); },
  });
  assert.deepEqual(body, { ok: 1 });
  assert.equal(got.url, "http://x/y");
  assert.deepEqual(got.init, { headers: { a: "b" }, env: { CONTROL_CONNECT_HOST: "127.0.0.1:18080" } });
});

test("context.fetchJson throws a CliError on a non-2xx response", async () => {
  const cmd = define({
    options: [],
    usage: () => "",
    run: ({ context }) => context.fetchJson("http://x", {}, "load"),
  });
  await assert.rejects(
    () => cmd.run([], { env: {}, controlFetch: async () => response({ error: "nope" }, 500) }),
    /load failed/,
  );
});

test("context.fetchJson escapes structured error context keys", async () => {
  const cmd = define({
    options: [],
    usage: () => "",
    run: ({ context }) => context.fetchJson("http://x", {}, "load"),
  });
  await assert.rejects(
    () => cmd.run([], {
      env: {},
      controlFetch: async () => response({
        error: "nope\u001b[31m",
        "bad\u001b]52;c;Y2xpcGJvYXJk\u0007key": "value\u001b[32m",
      }, 500),
    }),
    (err) => {
      assert(err instanceof CliError);
      assert.equal(err.message.includes("\u001b]52;c;Y2xpcGJvYXJk\u0007"), false);
      assert.match(err.message, /nope\\u001b\[31m/);
      assert.match(err.message, /bad\\u001b]52;c;Y2xpcGJvYXJk\\u0007key=value\\u001b\[32m/);
      return true;
    },
  );
});

test("context.fetchJson renders reserved module arrays from control errors", async () => {
  const cmd = define({
    options: [],
    usage: () => "",
    run: ({ context }) => context.fetchJson("http://x", {}, "deploy"),
  });
  await assert.rejects(
    () => cmd.run([], {
      env: {},
      controlFetch: async () => response({
        error: "worker_code_invalid",
        message: "reserved injected module name",
        reserved_modules: ["_wdl-wrapper.js", "_wdl-init.js"],
      }, 400),
    }),
    (err) => {
      assert(err instanceof CliError);
      assert.match(err.message, /reserved_modules=\["_wdl-wrapper\.js","_wdl-init\.js"\]/);
      return true;
    },
  );
});

test("context.fetchStream returns the raw response after a status check", async () => {
  const ok = response("bytes");
  let got = /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ (
    /** @type {unknown} */ (null)
  );
  const cmd = define({
    options: [],
    usage: () => "",
    run: ({ context }) => context.fetchStream("http://x", { method: "HEAD" }, "get"),
  });
  const res = await cmd.run([], {
    env: { CONTROL_CONNECT_HOST: "127.0.0.1:18080" },
    controlFetch: async (/** @type {string} */ _url, /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init) => {
      got = init;
      return ok;
    },
  });
  assert.equal(res, ok);
  assert.deepEqual(got, { method: "HEAD", env: { CONTROL_CONNECT_HOST: "127.0.0.1:18080" } });

  const bad = define({
    options: [],
    usage: () => "",
    run: ({ context }) => context.fetchStream("http://x", {}, "get object"),
  });
  await assert.rejects(
    () => bad.run([], { env: {}, controlFetch: async () => response({ error: "no" }, 404) }),
    /get object failed/,
  );
});

test("context.resolveControl memoizes; resolveNamespace reads values then env", async () => {
  /** @typedef {ReturnType<CommandContext["resolveControl"]>} ResolvedControl */
  let c1 = /** @type {ResolvedControl} */ (/** @type {unknown} */ (null));
  let c2 = /** @type {ResolvedControl} */ (/** @type {unknown} */ (null));
  /** @type {string | undefined} */
  let nsFromFlag;
  /** @type {string | undefined} */
  let nsFromEnv;
  const cmd = define({
    options: ["ns", "control"],
    usage: () => "",
    run: ({ context }) => {
      nsFromFlag = context.resolveNamespace();
      c1 = context.resolveControl();
      c2 = context.resolveControl();
    },
  });
  await cmd.run(
    ["--ns", "demo", "--control-url", "http://ctl.test", "--token", "t"],
    { env: {} },
  );
  assert.equal(nsFromFlag, "demo");
  assert.equal(c1.controlUrl, "http://ctl.test");
  assert.equal(c1, c2); // same object — resolved once

  const envCmd = define({
    options: ["ns"],
    usage: () => "",
    run: ({ context }) => { nsFromEnv = context.resolveNamespace(); },
  });
  await envCmd.run([], { env: { WDL_NS: "envns" } });
  assert.equal(nsFromEnv, "envns");
});

test("context.resolveControl throws without a token", async () => {
  const cmd = define({
    options: ["control"],
    usage: () => "",
    run: ({ context }) => context.resolveControl(),
  });
  await assert.rejects(() => cmd.run([], { env: {} }), /Missing admin token/);
});

test("run errors propagate from the exported runner (main swallows separately)", async () => {
  const cmd = define({
    options: [],
    usage: () => "",
    run: () => { throw new CliError("boom"); },
  });
  await assert.rejects(() => cmd.run([], { env: {} }), /boom/);
});
