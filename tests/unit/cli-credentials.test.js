import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isTokenStoreDisabled, loadCliControlEnv, loadCliDotEnv, protectedEnvKeys, resolveControlContext, resolveControlUrl, resolveNamespace, warnIfInsecureControlUrl } from "../../lib/credentials.js";
import { ESC, assertNoRawTerminalControls } from "./helpers.js";

test("isTokenStoreDisabled honors the flag and WDL_TOKEN_STORE=off", () => {
  assert.equal(isTokenStoreDisabled({}, false), false);
  assert.equal(isTokenStoreDisabled({}, true), true);
  assert.equal(isTokenStoreDisabled({ WDL_TOKEN_STORE: "off" }), true);
  assert.equal(isTokenStoreDisabled({ WDL_TOKEN_STORE: "OFF" }), true);
  assert.equal(isTokenStoreDisabled({ WDL_TOKEN_STORE: "on" }), false);
  assert.equal(isTokenStoreDisabled({ WDL_TOKEN_STORE: "" }), false);
});

function emptyEnv() {
  return /** @type {NodeJS.ProcessEnv} */ ({});
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

test("resolveControlUrl escapes invalid endpoint diagnostics", () => {
  assert.throws(
    () => resolveControlUrl({ "control-url": `ftp://ctl.test/${ESC}[2J\u009b` }, {}),
    (err) => {
      const message = /** @type {Error} */ (err).message;
      assert.match(message, /Invalid control URL/);
      assertNoRawTerminalControls(message, "control URL errors");
      return true;
    }
  );
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

test("warnIfInsecureControlUrl escapes control endpoint text before warning", () => {
  /** @type {string[]} */
  const warnings = [];
  warnIfInsecureControlUrl(
    "http://localhost/\u001b[31m",
    (line) => warnings.push(line),
    { CONTROL_CONNECT_HOST: "evil.example\nsecond" },
  );

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /http:\/\/localhost\/\\u001b\[31m/);
  assert.match(warnings[0], /CONTROL_CONNECT_HOST=evil\.example\\nsecond/);
  assert.equal(warnings[0].includes("\u001b"), false);
  assert.equal(warnings[0].includes("\n"), false);
});

test("warnIfInsecureControlUrl treats local CONTROL_CONNECT_HOST host:port overrides as local", () => {
  for (const connectHost of ["localhost:18080", "dev.local:18080", "[::1]:18080", "http://localhost:18080"]) {
    /** @type {string[]} */
    const warnings = [];
    warnIfInsecureControlUrl(
      "http://admin.test:8080",
      (line) => warnings.push(line),
      { CONTROL_CONNECT_HOST: connectHost },
    );
    assert.deepEqual(warnings, []);
  }
});

test("resolveNamespace prefers explicit namespace before WDL_NS", () => {
  assert.equal(resolveNamespace({ ns: "flag" }, { WDL_NS: "env" }), "flag");
  assert.equal(resolveNamespace({}, { WDL_NS: "env" }), "env");
  assert.equal(resolveNamespace({}, {}), undefined);
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

    /** @type {NodeJS.ProcessEnv} */
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

test("loadCliDotEnv escapes invalid section names", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-env-section-"));
  const file = path.join(dir, ".env");
  try {
    writeFileSync(file, `[BAD${ESC}[2J\u009b]\nADMIN_TOKEN=tok\n`);
    assert.throws(
      () => loadCliDotEnv(emptyEnv(), file),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assert.match(message, /invalid section name/);
        assertNoRawTerminalControls(message, "section errors");
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliDotEnv ignores non-WDL dotenv lines it cannot parse", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-env-"));
  const file = path.join(dir, ".env");
  try {
    writeFileSync(file, [
      "ADMIN_TOKEN=tok",
      "PRIVATE_KEY=\"-----BEGIN PRIVATE KEY-----",
      "not a KEY=value continuation",
      "-----END PRIVATE KEY-----\"",
      "CONTROL_URL=https://ctl.example",
    ].join("\n"));

    const env = emptyEnv();
    assert.deepEqual(loadCliDotEnv(env, file), ["ADMIN_TOKEN", "CONTROL_URL"]);
    assert.equal(env.ADMIN_TOKEN, "tok");
    assert.equal(env.CONTROL_URL, "https://ctl.example");
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
    /** @type {Set<string>} */
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
    /** @type {Set<string>} */
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
    /** @type {Set<string>} */
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

    /** @type {string[]} */
    const warnings = [];
    const env = emptyEnv();
    /** @type {Set<string>} */
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

    /** @type {string[]} */
    const warnings = [];
    const env = emptyEnv();
    /** @type {Set<string>} */
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

test("loadCliDotEnv wraps unreadable .env filesystem errors", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-env-unreadable-"));
  try {
    const file = path.join(dir, `.env${ESC}[2J\nFORGED\rBAD`);
    mkdirSync(file);
    assert.throws(
      () => loadCliDotEnv(emptyEnv(), file),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assert.match(message, /Cannot read \.env file/);
        assert.match(message, /\.env\\u001b\[2J\\nFORGED\\rBAD/);
        assertNoRawTerminalControls(message, ".env read errors");
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadCliControlEnv drops a .env control endpoint when the token is from the shell", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-crossorigin-"));
  try {
    writeFileSync(path.join(dir, ".env"), "CONTROL_URL=https://ctl.attacker.example\n");
    /** @type {NodeJS.ProcessEnv} */
    const env = { ADMIN_TOKEN: "shell-token" };
    /** @type {string[]} */
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
    /** @type {string[]} */
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
    /** @type {string[]} */
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
    /** @type {string[]} */
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

test("protectedEnvKeys protects only non-empty string values", () => {
  const keys = protectedEnvKeys(/** @type {NodeJS.ProcessEnv} */ ({ A: "x", EMPTY: "", MISSING: undefined, B: "y" }));
  assert.deepEqual([...keys].sort(), ["A", "B"]);
});

test("loadCliControlEnv fills control URL and token from the store as a gap-filler", () => {
  /** @type {NodeJS.ProcessEnv} */
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
  /** @type {NodeJS.ProcessEnv} */
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
  /** @type {NodeJS.ProcessEnv} */
  const env = { WDL_NS: "" };
  loadCliControlEnv(env, {
    // Simulate the real loader: only set the .env WDL_NS when it is not protected.
    /**
     * @param {NodeJS.ProcessEnv} [e]
     * @param {string} [_path]
     * @param {{ protectedKeys?: Set<string> }} [options]
     * @returns {string[]}
     */
    loadEnv: (e = process.env, _path, { protectedKeys = new Set() } = {}) => {
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
  /** @type {NodeJS.ProcessEnv} */
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
  /** @type {NodeJS.ProcessEnv} */
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
  /** @type {string[]} */
  const warnings = [];
  loadCliControlEnv(env, {
    nsFromFlag: "acme",
    /**
     * @param {NodeJS.ProcessEnv} [e]
     * @param {string} [_path]
     * @param {{ resolvedNs?: string }} [opts]
     * @returns {string[]}
     */
    loadEnv: (e = process.env, _path, opts = {}) => {
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
  /** @type {string[]} */
  const warnings = [];
  loadCliControlEnv(env, {
    nsFromFlag: "acme",
    /**
     * @param {NodeJS.ProcessEnv} [e]
     * @param {string} [_path]
     * @param {{ resolvedNs?: string }} [opts]
     * @returns {string[]}
     */
    loadEnv: (e = process.env, _path, opts = {}) => {
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
