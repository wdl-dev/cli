import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTokenCommand } from "../../commands/token.js";
import { loadCliControlEnv, protectedEnvKeys, readSecretStdin, readTtyLine } from "../../lib/common.js";
import { readTokenStore, tokenStorePath, writeTokenStore } from "../../lib/token-store.js";
import { response } from "./helpers.js";

async function withTempXdg(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-token-cmd-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function stdinFrom(value) {
  const stdin = Object.assign(new EventEmitter(), { setEncoding() {} });
  queueMicrotask(() => {
    stdin.emit("data", value);
    stdin.emit("end");
  });
  return stdin;
}

/** @param {string} xdg @param {{ stdin?: any, controlFetch?: Function }} [opts] */
function deps(xdg, { stdin, controlFetch } = {}) {
  const lines = [];
  const warnings = [];
  const calls = [];
  return {
    lines,
    warnings,
    calls,
    deps: {
      env: { XDG_CONFIG_HOME: xdg },
      stdout: (line) => lines.push(line),
      stderr: () => {},
      warn: (line) => warnings.push(line),
      stdin,
      controlFetch: controlFetch || (async (url, init = {}) => {
        calls.push({ url, init });
        return response({ ok: true, principal: { kind: "ns", ns: "acme" } });
      }),
    },
  };
}

// --- wdl token set ---

test("token set reads stdin, validates via /whoami, and stores the credential", async () => {
  await withTempXdg(async (xdg) => {
    const { lines, calls, deps: d } = deps(xdg, { stdin: stdinFrom("tok-secret-1234\n") });
    await runTokenCommand(["set", "--ns", "acme", "--control-url", "https://api.example"], d);

    assert.match(calls[0].url, /https:\/\/api\.example\/whoami$/);
    assert.equal(calls[0].init.headers["x-admin-token"], "tok-secret-1234");

    const store = readTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg }));
    assert.deepEqual(store.namespaces.acme, { CONTROL_URL: "https://api.example", ADMIN_TOKEN: "tok-secret-1234" });
    assert.equal(store.defaultNs, "acme", "the first stored namespace becomes the default");
    assert.match(lines.join("\n"), /Stored token for acme @ https:\/\/api\.example \(\*\*\*\*1234\)/);
    assert.match(lines.join("\n"), /acme is now the default namespace/);
  });
});

test("token set makes only the first namespace the default; later sets do not steal it", async () => {
  await withTempXdg(async (xdg) => {
    await runTokenCommand(
      ["set", "--ns", "acme", "--control-url", "https://api.example"],
      deps(xdg, { stdin: stdinFrom("tok-1\n") }).deps
    );
    const second = deps(xdg, {
      stdin: stdinFrom("tok-2\n"),
      controlFetch: async () => response({ ok: true, principal: { kind: "ns", ns: "demo" } }),
    });
    await runTokenCommand(["set", "--ns", "demo", "--control-url", "https://api.example"], second.deps);

    assert.equal(readTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg })).defaultNs, "acme");
    assert.doesNotMatch(second.lines.join("\n"), /default namespace/, "a non-first set is silent about the default");
  });
});

test("token set --default makes an existing namespace the default", async () => {
  await withTempXdg(async (xdg) => {
    await runTokenCommand(
      ["set", "--ns", "acme", "--control-url", "https://api.example"],
      deps(xdg, { stdin: stdinFrom("tok-1\n") }).deps
    );
    await runTokenCommand(
      ["set", "--ns", "demo", "--control-url", "https://api.example", "--default"],
      deps(xdg, {
        stdin: stdinFrom("tok-2\n"),
        controlFetch: async () => response({ ok: true, principal: { kind: "ns", ns: "demo" } }),
      }).deps
    );
    assert.equal(readTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg })).defaultNs, "demo");
  });
});

test("token set creates a __proto__ namespace without hitting the prototype setter", async () => {
  await withTempXdg(async (xdg) => {
    await runTokenCommand(
      ["set", "--ns", "__proto__", "--control-url", "https://api.example"],
      deps(xdg, {
        stdin: stdinFrom("tok-proto\n"),
        controlFetch: async () => response({ ok: true, principal: { kind: "ns", ns: "__proto__" } }),
      }).deps
    );
    const store = readTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg }));
    assert.equal(Object.hasOwn(store.namespaces, "__proto__"), true);
    assert.equal(store.namespaces["__proto__"].ADMIN_TOKEN, "tok-proto");
    assert.equal(store.defaultNs, "__proto__");
  });
});

test("token set does not claim a deliberately-cleared default in an ambiguous store", async () => {
  await withTempXdg(async (xdg) => {
    const p = tokenStorePath({ XDG_CONFIG_HOME: xdg });
    // Default null but 2+ namespaces (e.g. the default was removed from an
    // ambiguous set); a later set without --default must not steal the default.
    writeTokenStore(p, { defaultNs: null, namespaces: { acme: { ADMIN_TOKEN: "a" }, demo: { ADMIN_TOKEN: "d" } } });
    await runTokenCommand(
      ["set", "--ns", "demo", "--control-url", "https://api.example"],
      deps(xdg, {
        stdin: stdinFrom("tok\n"),
        controlFetch: async () => response({ ok: true, principal: { kind: "ns", ns: "demo" } }),
      }).deps
    );
    assert.equal(readTokenStore(p).defaultNs, null);
  });
});

test("token set stores and preserves a --label", async () => {
  await withTempXdg(async (xdg) => {
    await runTokenCommand(
      ["set", "--ns", "acme", "--control-url", "https://api.example", "--label", "production"],
      deps(xdg, { stdin: stdinFrom("tok-1\n") }).deps
    );
    let store = readTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg }));
    assert.equal(store.namespaces.acme.LABEL, "production");

    // Re-set without --label keeps the existing label.
    await runTokenCommand(
      ["set", "--ns", "acme", "--control-url", "https://api.example"],
      deps(xdg, { stdin: stdinFrom("tok-2\n") }).deps
    );
    store = readTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg }));
    assert.equal(store.namespaces.acme.LABEL, "production");
    assert.equal(store.namespaces.acme.ADMIN_TOKEN, "tok-2");
  });
});

test("token set does not store a token that fails /whoami", async () => {
  await withTempXdg(async (xdg) => {
    const controlFetch = async () => response({ error: "unauthorized" }, 401);
    await assert.rejects(
      () => runTokenCommand(
        ["set", "--ns", "acme", "--control-url", "https://api.example"],
        deps(xdg, { stdin: stdinFrom("bad-token\n"), controlFetch }).deps
      ),
      /whoami/
    );
    assert.deepEqual(readTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg })), { defaultNs: null, namespaces: {} });
  });
});

test("token set requires --ns and a control URL", async () => {
  await withTempXdg(async (xdg) => {
    await assert.rejects(
      () => runTokenCommand(["set", "--control-url", "https://api.example"], deps(xdg, { stdin: stdinFrom("t\n") }).deps),
      /requires --ns/
    );
    await assert.rejects(
      () => runTokenCommand(["set", "--ns", "acme"], deps(xdg, { stdin: stdinFrom("t\n") }).deps),
      /needs the control URL/
    );
  });
});

test("token set rejects a token whose principal namespace differs from --ns", async () => {
  await withTempXdg(async (xdg) => {
    const controlFetch = async () => response({ ok: true, principal: { kind: "ns", ns: "other" } });
    await assert.rejects(
      () => runTokenCommand(
        ["set", "--ns", "acme", "--control-url", "https://api.example"],
        deps(xdg, { stdin: stdinFrom("tok\n"), controlFetch }).deps
      ),
      /namespace "other", not "acme"/
    );
    assert.deepEqual(readTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg })), { defaultNs: null, namespaces: {} });
  });
});

test("token set rejects a token that is not scoped to a namespace", async () => {
  await withTempXdg(async (xdg) => {
    const controlFetch = async () => response({ ok: true, principal: { kind: "operator" } });
    await assert.rejects(
      () => runTokenCommand(
        ["set", "--ns", "acme", "--control-url", "https://api.example"],
        deps(xdg, { stdin: stdinFrom("tok\n"), controlFetch }).deps
      ),
      /not scoped to namespace "acme"/
    );
    assert.deepEqual(readTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg })), { defaultNs: null, namespaces: {} });
  });
});

test("token set rejects a namespace that is not a valid section name", async () => {
  await withTempXdg(async (xdg) => {
    await assert.rejects(
      () => runTokenCommand(
        ["set", "--ns", "evil]x", "--control-url", "https://api.example"],
        deps(xdg, { stdin: stdinFrom("tok\n") }).deps
      ),
      /invalid namespace/
    );
    assert.deepEqual(readTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg })), { defaultNs: null, namespaces: {} });
  });
});

test("token set escapes terminal controls in a principal-mismatch error", async () => {
  await withTempXdg(async (xdg) => {
    const esc = String.fromCharCode(27);
    const controlFetch = async () => response({ ok: true, principal: { kind: "ns", ns: `other${esc}[2J` } });
    await assert.rejects(
      () => runTokenCommand(
        ["set", "--ns", "acme", "--control-url", "https://api.example"],
        deps(xdg, { stdin: stdinFrom("tok\n"), controlFetch }).deps
      ),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assert.doesNotMatch(message, new RegExp(esc), "raw ESC must not be in the error");
        assert.match(message, /token principal is namespace/);
        return true;
      }
    );
  });
});

test("token set escapes a masked token suffix containing terminal controls", async () => {
  await withTempXdg(async (xdg) => {
    const esc = String.fromCharCode(27);
    const { lines, deps: d } = deps(xdg, { stdin: stdinFrom(`tok-secret${esc}[2J\n`) });
    await runTokenCommand(["set", "--ns", "acme", "--control-url", "https://api.example"], d);
    const out = lines.join("\n");
    assert.doesNotMatch(out, new RegExp(esc), "raw ESC must not reach stdout via the masked suffix");
    assert.match(out, /Stored token for acme/);
  });
});

test("token set warns before sending the token to a plain-http non-local host", async () => {
  await withTempXdg(async (xdg) => {
    const { warnings, deps: d } = deps(xdg, { stdin: stdinFrom("tok\n") });
    await runTokenCommand(["set", "--ns", "acme", "--control-url", "http://example.com"], d);
    assert.match(warnings.join("\n"), /plain http on a non-local host/);
  });
});

test("token does not accept a --token flag (the token comes from stdin)", async () => {
  await withTempXdg(async (xdg) => {
    await assert.rejects(
      () => runTokenCommand(
        ["set", "--ns", "acme", "--control-url", "https://api.example", "--token", "x"],
        deps(xdg, { stdin: stdinFrom("tok\n") }).deps
      ),
      /Unknown option|--token/
    );
  });
});

// --- wdl token list / rm ---

test("token list formats stored namespaces with masked tokens and marks the default", async () => {
  await withTempXdg(async (xdg) => {
    writeTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg }), {
      defaultNs: "acme",
      namespaces: {
        acme: { CONTROL_URL: "https://api.example", ADMIN_TOKEN: "tok-abcd1234", LABEL: "production" },
        demo: { CONTROL_URL: "https://api.example", ADMIN_TOKEN: "tok-zzzz9999" },
      },
    });
    const { lines, deps: d } = deps(xdg);
    await runTokenCommand(["list"], d);
    const out = lines.join("\n");
    assert.match(out, /NAMESPACE\s+LABEL\s+CONTROL URL\s+TOKEN/);
    assert.match(out, /\*\s+acme\s+production\s+https:\/\/api\.example\s+\*\*\*\*1234/);
    assert.match(out, /default namespace \(used when --ns is omitted\)/);
    assert.doesNotMatch(out, /tok-abcd1234/, "raw token must not be printed");
  });
});

test("token use switches the default namespace and rejects an unstored one", async () => {
  await withTempXdg(async (xdg) => {
    const p = tokenStorePath({ XDG_CONFIG_HOME: xdg });
    writeTokenStore(p, {
      defaultNs: "acme",
      namespaces: { acme: { ADMIN_TOKEN: "a" }, demo: { ADMIN_TOKEN: "d" } },
    });
    const { lines, deps: d } = deps(xdg);
    await runTokenCommand(["use", "demo"], d);
    assert.equal(readTokenStore(p).defaultNs, "demo");
    assert.match(lines.join("\n"), /Default namespace set to demo/);

    await assert.rejects(
      () => runTokenCommand(["use", "ghost"], deps(xdg).deps),
      /no stored token for namespace "ghost"/
    );
  });
});

test("token list prints a placeholder when empty", async () => {
  await withTempXdg(async (xdg) => {
    const { lines, deps: d } = deps(xdg);
    await runTokenCommand(["list"], d);
    assert.deepEqual(lines, ["(no stored tokens)"]);
  });
});

test("token use/rm escape terminal controls in the not-found error", async () => {
  await withTempXdg(async (xdg) => {
    const esc = String.fromCharCode(27);
    const bad = `ghost${esc}[2J`;
    const noEsc = (err) => {
      assert.doesNotMatch(/** @type {Error} */ (err).message, new RegExp(esc), "raw ESC must not reach the error");
      return true;
    };
    await assert.rejects(() => runTokenCommand(["use", bad], deps(xdg).deps), noEsc);
    await assert.rejects(() => runTokenCommand(["rm", "--ns", bad], deps(xdg).deps), noEsc);
  });
});

test("token rm removes a stored namespace and errors when absent", async () => {
  await withTempXdg(async (xdg) => {
    const p = tokenStorePath({ XDG_CONFIG_HOME: xdg });
    writeTokenStore(p, { namespaces: { acme: { ADMIN_TOKEN: "t" }, demo: { ADMIN_TOKEN: "d" } } });

    const { lines, deps: d } = deps(xdg);
    await runTokenCommand(["rm", "--ns", "acme"], d);
    assert.deepEqual(Object.keys(readTokenStore(p).namespaces), ["demo"]);
    assert.match(lines.join("\n"), /does not revoke it on the control plane/);

    await assert.rejects(
      () => runTokenCommand(["rm", "--ns", "acme"], deps(xdg).deps),
      /no stored token for namespace "acme"/
    );
  });
});

test("token rm requires an explicit --ns and ignores ambient WDL_NS", async () => {
  await withTempXdg(async (xdg) => {
    const p = tokenStorePath({ XDG_CONFIG_HOME: xdg });
    writeTokenStore(p, { defaultNs: "acme", namespaces: { acme: { ADMIN_TOKEN: "a" } } });

    const { deps: d } = deps(xdg);
    // A stray WDL_NS must NOT make a bare `rm` delete that namespace's token.
    d.env.WDL_NS = "acme";
    await assert.rejects(() => runTokenCommand(["rm"], d), /requires an explicit --ns/);
    assert.deepEqual(Object.keys(readTokenStore(p).namespaces), ["acme"], "store untouched");
  });
});

test("token set requires an explicit --ns and ignores ambient WDL_NS", async () => {
  await withTempXdg(async (xdg) => {
    // Default controlFetch authenticates the token as namespace "acme", so
    // without the guard a WDL_NS=acme would let this store under acme.
    const { deps: d } = deps(xdg, { stdin: stdinFrom("tok\n") });
    d.env.WDL_NS = "acme";
    await assert.rejects(
      () => runTokenCommand(["set", "--control-url", "https://api.example"], d),
      /requires --ns/
    );
    assert.deepEqual(readTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg })), { defaultNs: null, namespaces: {} });
  });
});

test("token use requires an explicit namespace and ignores ambient WDL_NS", async () => {
  await withTempXdg(async (xdg) => {
    const p = tokenStorePath({ XDG_CONFIG_HOME: xdg });
    writeTokenStore(p, { defaultNs: "demo", namespaces: { acme: { ADMIN_TOKEN: "a" }, demo: { ADMIN_TOKEN: "d" } } });
    const { deps: d } = deps(xdg);
    // A stray WDL_NS must NOT make a bare `use` switch the default.
    d.env.WDL_NS = "acme";
    await assert.rejects(() => runTokenCommand(["use"], d), /requires a namespace/);
    assert.equal(readTokenStore(p).defaultNs, "demo", "default unchanged");
  });
});

test("token rm of the default promotes a sole survivor, clears it when ambiguous", async () => {
  await withTempXdg(async (xdg) => {
    const p = tokenStorePath({ XDG_CONFIG_HOME: xdg });
    writeTokenStore(p, {
      defaultNs: "acme",
      namespaces: { acme: { ADMIN_TOKEN: "a" }, demo: { ADMIN_TOKEN: "d" }, prod: { ADMIN_TOKEN: "p" } },
    });

    // Three stored, default removed → two remain → ambiguous → default cleared.
    await runTokenCommand(["rm", "--ns", "acme"], deps(xdg).deps);
    assert.equal(readTokenStore(p).defaultNs, null);

    // Re-point the default, then remove down to one → the survivor is promoted.
    await runTokenCommand(["use", "demo"], deps(xdg).deps);
    await runTokenCommand(["rm", "--ns", "demo"], deps(xdg).deps);
    assert.equal(readTokenStore(p).defaultNs, "prod");
  });
});

test("token rm promotes the sole survivor even after the default was already cleared", async () => {
  await withTempXdg(async (xdg) => {
    const p = tokenStorePath({ XDG_CONFIG_HOME: xdg });
    writeTokenStore(p, {
      defaultNs: "acme",
      namespaces: { acme: { ADMIN_TOKEN: "a" }, demo: { ADMIN_TOKEN: "d" }, prod: { ADMIN_TOKEN: "p" } },
    });
    await runTokenCommand(["rm", "--ns", "acme"], deps(xdg).deps); // default cleared, 2 remain
    assert.equal(readTokenStore(p).defaultNs, null);
    await runTokenCommand(["rm", "--ns", "demo"], deps(xdg).deps); // non-default removed, prod alone
    assert.equal(readTokenStore(p).defaultNs, "prod", "sole survivor promoted even with no prior default");
  });
});

test("token rejects unknown subcommands", async () => {
  await withTempXdg(async (xdg) => {
    await assert.rejects(() => runTokenCommand(["frobnicate"], deps(xdg).deps), /Usage:/);
  });
});

test("token use/list/rm handle a namespace named like an Object.prototype key", async () => {
  await withTempXdg(async (xdg) => {
    const p = tokenStorePath({ XDG_CONFIG_HOME: xdg });
    writeTokenStore(p, { namespaces: { constructor: { ADMIN_TOKEN: "c" }, acme: { ADMIN_TOKEN: "a" } } });

    await runTokenCommand(["use", "constructor"], deps(xdg).deps);
    assert.equal(readTokenStore(p).defaultNs, "constructor");

    const { lines, deps: d } = deps(xdg);
    await runTokenCommand(["list"], d);
    assert.match(lines.join("\n"), /\*\s+constructor/);

    await runTokenCommand(["rm", "--ns", "constructor"], deps(xdg).deps);
    assert.equal(Object.hasOwn(readTokenStore(p).namespaces, "constructor"), false);
  });
});

// --- hidden TTY input ---

test("readTtyLine hides input by switching the TTY to raw mode", async () => {
  const rawCalls = [];
  const stderr = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setEncoding() {},
    setRawMode(v) { rawCalls.push(v); },
    pause() {},
  });
  const pending = readTtyLine(stdin, { prompt: "tok: ", stderr: (s) => stderr.push(s), hidden: true });
  queueMicrotask(() => {
    stdin.emit("data", "sec");
    stdin.emit("data", "X" + String.fromCharCode(127)); // typo, then backspace removes it
    stdin.emit("data", "ret" + String.fromCharCode(13)); // Enter
  });
  assert.equal(await pending, "secret");
  assert.deepEqual(rawCalls, [true, false], "raw mode (echo off) enabled, then restored");
});

test("readTtyLine fails closed when a TTY cannot hide input", async () => {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setEncoding() {},
    pause() {},
    // no setRawMode: cannot disable echo, so hidden input must reject, not leak
  });
  await assert.rejects(
    () => readTtyLine(stdin, { prompt: "tok: ", stderr: () => {}, hidden: true }),
    /cannot hide input/
  );
});

test("readSecretStdin reads a piped value to EOF, trimming one trailing newline", async () => {
  const stdin = Object.assign(new EventEmitter(), { setEncoding() {} });
  queueMicrotask(() => {
    stdin.emit("data", "sec");
    stdin.emit("data", "ret\n");
    stdin.emit("end");
  });
  assert.equal(await readSecretStdin(stdin), "secret");
});

test("readSecretStdin trims only one trailing newline (multi-line value)", async () => {
  const stdin = Object.assign(new EventEmitter(), { setEncoding() {} });
  queueMicrotask(() => {
    stdin.emit("data", "a\nb\n\n");
    stdin.emit("end");
  });
  assert.equal(await readSecretStdin(stdin), "a\nb\n");
});

test("readSecretStdin hides input on a TTY via raw mode", async () => {
  const rawCalls = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setEncoding() {},
    setRawMode(v) { rawCalls.push(v); },
    pause() {},
  });
  queueMicrotask(() => {
    stdin.emit("data", "tok");
    stdin.emit("data", "en\r");
  });
  assert.equal(await readSecretStdin(stdin, { stderr: () => {} }), "token");
  assert.deepEqual(rawCalls, [true, false], "raw mode (echo off) enabled, then restored");
});

test("readTtyLine escapes terminal controls in the prompt at the write point", async () => {
  const errs = [];
  const stdin = Object.assign(new EventEmitter(), { setEncoding() {}, pause() {} });
  queueMicrotask(() => stdin.emit("data", "y\n"));
  await readTtyLine(stdin, { prompt: `confirm ${String.fromCharCode(27)}[2J?`, stderr: (s) => errs.push(s) });
  assert.doesNotMatch(errs.join(""), new RegExp(String.fromCharCode(27)), "raw ESC from the prompt must not reach stderr");
});

test("protectedEnvKeys protects only non-empty string values", () => {
  const keys = protectedEnvKeys(/** @type {any} */ ({ A: "x", EMPTY: "", MISSING: undefined, B: "y" }));
  assert.deepEqual([...keys].sort(), ["A", "B"]);
});

// --- resolution integration (the global store as the lowest-precedence layer) ---

test("loadCliControlEnv fills control URL and token from the store as a gap-filler", () => {
  const env = { WDL_NS: "acme" };
  loadCliControlEnv(env, {
    nsFromFlag: "acme",
    loadEnv: () => [],
    readStore: () => ({ namespaces: { acme: { CONTROL_URL: "https://store.example", ADMIN_TOKEN: "store-tok" } } }),
  });
  assert.equal(env.CONTROL_URL, "https://store.example");
  assert.equal(env.ADMIN_TOKEN, "store-tok");
});

test("loadCliControlEnv selects the store's default namespace when nothing else does", () => {
  const env = /** @type {NodeJS.ProcessEnv} */ ({});
  loadCliControlEnv(env, {
    loadEnv: () => [],
    readStore: () => ({
      defaultNs: "acme",
      namespaces: { acme: { CONTROL_URL: "https://store.example", ADMIN_TOKEN: "store-tok" } },
    }),
  });
  assert.equal(env.WDL_NS, "acme", "the default namespace is materialized for downstream resolution");
  assert.equal(env.CONTROL_URL, "https://store.example");
  assert.equal(env.ADMIN_TOKEN, "store-tok");
});

test("loadCliControlEnv lets an explicit namespace override the store default", () => {
  const env = { WDL_NS: "demo" };
  loadCliControlEnv(env, {
    loadEnv: () => [],
    readStore: () => ({
      defaultNs: "acme",
      namespaces: {
        acme: { CONTROL_URL: "https://acme.example", ADMIN_TOKEN: "acme-tok" },
        demo: { CONTROL_URL: "https://demo.example", ADMIN_TOKEN: "demo-tok" },
      },
    }),
  });
  assert.equal(env.WDL_NS, "demo", "shell WDL_NS wins over the store default");
  assert.equal(env.CONTROL_URL, "https://demo.example");
  assert.equal(env.ADMIN_TOKEN, "demo-tok");
});

test("loadCliControlEnv lets a project .env namespace beat the store default over an empty shell WDL_NS", () => {
  const env = { WDL_NS: "" };
  loadCliControlEnv(env, {
    // Simulate the real loader: only set the .env WDL_NS when it is not protected.
    loadEnv: (e, _path, { protectedKeys }) => {
      if (protectedKeys.has("WDL_NS")) return [];
      e.WDL_NS = "acme";
      return ["WDL_NS"];
    },
    readStore: () => ({
      defaultNs: "demo",
      namespaces: {
        acme: { CONTROL_URL: "https://acme.example", ADMIN_TOKEN: "acme-tok" },
        demo: { CONTROL_URL: "https://demo.example", ADMIN_TOKEN: "demo-tok" },
      },
    }),
  });
  assert.equal(env.WDL_NS, "acme", "the project .env namespace wins over the store default");
  assert.equal(env.CONTROL_URL, "https://acme.example", "creds come from acme, not the demo default");
  assert.equal(env.ADMIN_TOKEN, "acme-tok");
});

test("loadCliControlEnv ignores a store default with no stored entry", () => {
  const env = /** @type {NodeJS.ProcessEnv} */ ({});
  loadCliControlEnv(env, {
    loadEnv: () => [],
    readStore: () => ({ defaultNs: "ghost", namespaces: { acme: { ADMIN_TOKEN: "a" } } }),
  });
  assert.equal(env.WDL_NS, undefined, "a dangling default does not select a namespace");
  assert.equal(env.ADMIN_TOKEN, undefined);
});

test("loadCliControlEnv lets shell env win over the store (gap-fill only)", () => {
  const env = { WDL_NS: "acme", ADMIN_TOKEN: "shell-tok" };
  loadCliControlEnv(env, {
    nsFromFlag: "acme",
    protectedKeys: new Set(["ADMIN_TOKEN"]),
    loadEnv: () => [],
    readStore: () => ({ namespaces: { acme: { CONTROL_URL: "https://store.example", ADMIN_TOKEN: "store-tok" } } }),
  });
  assert.equal(env.ADMIN_TOKEN, "shell-tok", "shell token is not overwritten");
  assert.equal(env.CONTROL_URL, "https://store.example", "the empty control URL slot is filled");
});

test("loadCliControlEnv does not fill a flag-covered slot from the store", () => {
  const env = { WDL_NS: "acme" };
  // --control-url supplies the endpoint, so the store fills only the token and
  // never writes its own CONTROL_URL into env.
  loadCliControlEnv(env, {
    nsFromFlag: "acme",
    controlUrlFromFlag: true,
    loadEnv: () => [],
    readStore: () => ({ namespaces: { acme: { CONTROL_URL: "https://store.example", ADMIN_TOKEN: "store-tok" } } }),
  });
  assert.equal(env.CONTROL_URL, undefined, "flag-covered endpoint is not shadowed by the store");
  assert.equal(env.ADMIN_TOKEN, "store-tok", "the uncovered token slot is still filled");
});

test("loadCliControlEnv does not read the store when ns and credentials are present", () => {
  const env = { WDL_NS: "acme", CONTROL_URL: "https://shell.example", ADMIN_TOKEN: "shell-tok" };
  let reads = 0;
  loadCliControlEnv(env, {
    nsFromFlag: "acme",
    loadEnv: () => [],
    readStore: () => { reads += 1; return {}; },
  });
  assert.equal(reads, 0, "the store is the lowest layer and untouched when nothing needs it");
});

test("loadCliControlEnv ignores a corrupt store when flags cover the credentials", () => {
  let reads = 0;
  // ns + both creds come from flags, so the store is never consulted and a
  // corrupt ~/.config/wdl/credentials cannot abort the command.
  loadCliControlEnv(/** @type {NodeJS.ProcessEnv} */ ({}), {
    nsFromFlag: "acme",
    tokenFromFlag: true,
    controlUrlFromFlag: true,
    loadEnv: () => [],
    readStore: () => { reads += 1; throw new Error("Invalid credentials line 3"); },
  });
  assert.equal(reads, 0, "store never read");
});

test("loadCliControlEnv surfaces a corrupt store when it is the credential source", () => {
  assert.throws(
    () => loadCliControlEnv(/** @type {NodeJS.ProcessEnv} */ ({}), {
      nsFromFlag: "acme",
      loadEnv: () => [],
      readStore: () => { throw new Error("Invalid credentials line 3"); },
    }),
    /Invalid credentials/
  );
});

test("loadCliControlEnv tolerates a corrupt store when no namespace is needed", () => {
  // No --ns/WDL_NS: the optional default-namespace lookup must not let a corrupt
  // store abort a command that needs none (e.g. whoami --control-url … --token …).
  const env = /** @type {NodeJS.ProcessEnv} */ ({});
  assert.doesNotThrow(() =>
    loadCliControlEnv(env, {
      loadEnv: () => [],
      readStore: () => { throw new Error("Invalid credentials line 3"); },
    })
  );
  assert.equal(env.WDL_NS, undefined);
});

test("an empty .env ADMIN_TOKEN does not mark a .env endpoint same-source", () => {
  // Malicious cwd .env: a control endpoint + an EMPTY `ADMIN_TOKEN=` placeholder.
  // The empty token must not make the endpoint same-source.
  const env = /** @type {NodeJS.ProcessEnv} */ ({});
  const warnings = [];
  loadCliControlEnv(env, {
    nsFromFlag: "acme",
    loadEnv: (e, _path, opts) => {
      if (!opts.resolvedNs) {
        e.CONTROL_URL = "https://evil.example";
        e.ADMIN_TOKEN = "";
        return ["CONTROL_URL", "ADMIN_TOKEN"];
      }
      return [];
    },
    readStore: () => ({ namespaces: { acme: { CONTROL_URL: "https://good.example", ADMIN_TOKEN: "store-tok" } } }),
    onCrossOrigin: (line) => warnings.push(line),
  });
  assert.equal(env.CONTROL_URL, "https://good.example", "evil endpoint dropped, store endpoint used");
  assert.equal(env.ADMIN_TOKEN, "store-tok");
  assert.equal(warnings.length, 1);
});

test("a project .env endpoint is still dropped when the token comes from the store", () => {
  // Malicious cwd .env supplies an endpoint but no token; the store supplies the
  // token (and a trusted endpoint). The guard must drop the project endpoint
  // before the store fills it, so the store token is never sent to the .env host.
  const env = /** @type {NodeJS.ProcessEnv} */ ({});
  const warnings = [];
  loadCliControlEnv(env, {
    nsFromFlag: "acme",
    loadEnv: (e, _path, opts) => {
      if (!opts.resolvedNs) {
        e.CONTROL_URL = "https://evil.example";
        return ["CONTROL_URL"];
      }
      return [];
    },
    readStore: () => ({ namespaces: { acme: { CONTROL_URL: "https://good.example", ADMIN_TOKEN: "store-tok" } } }),
    onCrossOrigin: (line) => warnings.push(line),
  });
  assert.equal(env.CONTROL_URL, "https://good.example", "evil endpoint dropped, store endpoint used");
  assert.equal(env.ADMIN_TOKEN, "store-tok");
  assert.equal(warnings.length, 1);
});
