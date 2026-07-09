import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTokenCommand } from "../../commands/token.js";
import { readTokenStore, tokenStorePath, writeTokenStore } from "../../lib/token-store.js";
import { ESC, assertNoRawTerminalControls, response } from "./helpers.js";

/**
 * @template T
 * @param {(dir: string) => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withTempXdg(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-token-cmd-"));
  try {
    return await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** @param {string} value @returns {import("../../lib/stdin.js").StdinLike} */
function stdinFrom(value) {
  const stdin = Object.assign(new EventEmitter(), { setEncoding() {} });
  queueMicrotask(() => {
    stdin.emit("data", value);
    stdin.emit("end");
  });
  return stdin;
}

/**
 * The control-fetch surface `fetchWhoami` drives: it always supplies `headers`.
 * @typedef {import("../../lib/control-fetch.js").ControlFetchInit & { headers: import("node:http").OutgoingHttpHeaders }} WhoamiInit
 * @typedef {(url: string, init?: WhoamiInit) => Promise<ReturnType<typeof response>>} FakeControlFetch
 */

/**
 * @param {string} xdg
 * @param {{ stdin?: import("../../lib/stdin.js").StdinLike, controlFetch?: FakeControlFetch }} [opts]
 */
function deps(xdg, { stdin, controlFetch } = {}) {
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const warnings = [];
  /** @type {Array<{ url: string, init: WhoamiInit }>} */
  const calls = [];
  return {
    lines,
    warnings,
    calls,
    deps: {
      /** @type {NodeJS.ProcessEnv} */
      env: { XDG_CONFIG_HOME: xdg },
      /** @param {string} line */
      stdout: (line) => lines.push(line),
      stderr: () => {},
      /** @param {string} line */
      warn: (line) => warnings.push(line),
      stdin,
      controlFetch: controlFetch || (/** @param {string} url @param {WhoamiInit} init */ async (url, init) => {
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

test("token set with --default claims the default in a deliberately-cleared ambiguous store", async () => {
  await withTempXdg(async (xdg) => {
    const p = tokenStorePath({ XDG_CONFIG_HOME: xdg });
    writeTokenStore(p, { defaultNs: null, namespaces: { acme: { ADMIN_TOKEN: "a" }, demo: { ADMIN_TOKEN: "d" } } });
    await runTokenCommand(
      ["set", "--ns", "demo", "--control-url", "https://api.example", "--default"],
      deps(xdg, {
        stdin: stdinFrom("tok\n"),
        controlFetch: async () => response({ ok: true, principal: { kind: "ns", ns: "demo" } }),
      }).deps
    );
    assert.equal(readTokenStore(p).defaultNs, "demo");
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
    const controlFetch = async () => response({ ok: true, principal: { kind: "ns", ns: `other${ESC}[2J` } });
    await assert.rejects(
      () => runTokenCommand(
        ["set", "--ns", "acme", "--control-url", "https://api.example"],
        deps(xdg, { stdin: stdinFrom("tok\n"), controlFetch }).deps
      ),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assertNoRawTerminalControls(message, "principal-mismatch errors");
        assert.match(message, /token principal is namespace/);
        return true;
      }
    );
  });
});

test("token set escapes a masked token suffix containing terminal controls", async () => {
  await withTempXdg(async (xdg) => {
    const { lines, deps: d } = deps(xdg, { stdin: stdinFrom(`tok-secret${ESC}[2J\n`) });
    await runTokenCommand(["set", "--ns", "acme", "--control-url", "https://api.example"], d);
    const out = lines.join("\n");
    assertNoRawTerminalControls(out, "masked token suffix output");
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

test("writeTokenStore replaces a symlink instead of following it", { skip: process.platform === "win32" }, async () => {
  await withTempXdg(async (xdg) => {
    const p = tokenStorePath({ XDG_CONFIG_HOME: xdg });
    mkdirSync(path.dirname(p), { recursive: true });
    const target = path.join(xdg, "outside-credentials");
    writeFileSync(target, "outside\n", { mode: 0o600 });
    symlinkSync(target, p);

    writeTokenStore(p, { defaultNs: "acme", namespaces: { acme: { ADMIN_TOKEN: "secret" } } });

    assert.equal(readFileSync(target, "utf8"), "outside\n");
    assert.equal(lstatSync(p).isSymbolicLink(), false);
    assert.deepEqual(readTokenStore(p), { defaultNs: "acme", namespaces: { acme: { ADMIN_TOKEN: "secret" } } });
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

test("token list escapes terminal controls inside table cells", async () => {
  await withTempXdg(async (xdg) => {
    writeTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg }), {
      defaultNs: "acme",
      namespaces: {
        acme: {
          CONTROL_URL: "https://api.example\nFORGED\rBAD",
          ADMIN_TOKEN: "tok-abcd1234",
          LABEL: `prod${ESC}[2J\nFORGED`,
        },
      },
    });
    const { lines, deps: d } = deps(xdg);
    await runTokenCommand(["list"], d);
    const out = lines.join("\n");

    assertNoRawTerminalControls(out, "token list output");
    assert.match(out, /prod\\u001b\[2J\\nFORGED/);
    assert.match(out, /https:\/\/api\.example\\nFORGED\\rBAD/);
  });
});

test("token list escapes credential-store read errors", async () => {
  await withTempXdg(async (xdg) => {
    const badXdg = path.join(xdg, `bad${ESC}dir\nFORGED\rBAD`);
    writeFileSync(badXdg, "");

    await assert.rejects(
      () => runTokenCommand(["list"], deps(badXdg).deps),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assert.match(message, /failed to read credential store/);
        assert.match(message, /bad\\u001bdir\\nFORGED\\rBAD/);
        assertNoRawTerminalControls(message, "the error");
        return true;
      }
    );
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

test("token use/rm unknown namespaces do not create an empty store directory", async () => {
  await withTempXdg(async (xdg) => {
    const storeDir = path.join(xdg, "wdl");
    await assert.rejects(
      () => runTokenCommand(["use", "ghost"], deps(xdg).deps),
      /no stored token for namespace "ghost"/
    );
    assert.equal(existsSync(storeDir), false);
    await assert.rejects(
      () => runTokenCommand(["rm", "--ns", "ghost"], deps(xdg).deps),
      /no stored token for namespace "ghost"/
    );
    assert.equal(existsSync(storeDir), false);
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
    const bad = `ghost${ESC}[2J`;
    /** @param {unknown} err */
    const noEsc = (err) => {
      assertNoRawTerminalControls(/** @type {Error} */ (err).message, "token not-found errors");
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
    const afterRm = readTokenStore(p);
    assert.deepEqual(Object.keys(afterRm.namespaces), ["demo"]);
    // Two down to one: the survivor is promoted to default, not left null.
    assert.equal(afterRm.defaultNs, "demo");
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
