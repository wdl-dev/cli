import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runTokenCommand } from "../../commands/token.js";
import { loadCliControlEnv } from "../../lib/common.js";
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

test("token rejects unknown subcommands", async () => {
  await withTempXdg(async (xdg) => {
    await assert.rejects(() => runTokenCommand(["frobnicate"], deps(xdg).deps), /Usage:/);
  });
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
