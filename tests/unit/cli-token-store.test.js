import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  readTokenStore,
  tokenStoreDir,
  tokenStorePath,
  writeTokenStore,
} from "../../lib/token-store.js";
import { quoteValue } from "../../lib/common.js";

function withTempHome(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-token-store-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("tokenStoreDir honors XDG_CONFIG_HOME, then falls back to ~/.config", () => {
  assert.equal(
    tokenStoreDir({ XDG_CONFIG_HOME: "/x/cfg" }, () => "/home/u"),
    path.join("/x/cfg", "wdl")
  );
  assert.equal(
    tokenStoreDir({}, () => "/home/u"),
    path.join("/home/u", ".config", "wdl")
  );
  assert.equal(
    tokenStorePath({ XDG_CONFIG_HOME: "/x/cfg" }, () => "/home/u"),
    path.join("/x/cfg", "wdl", "credentials")
  );
});

test("readTokenStore returns an empty store when the file is absent", () => {
  withTempHome((dir) => {
    assert.deepEqual(readTokenStore(path.join(dir, "credentials")), { defaultNs: null, namespaces: {} });
  });
});

test("writeTokenStore then readTokenStore round-trips namespaces and fields", () => {
  withTempHome((dir) => {
    const p = path.join(dir, "wdl", "credentials");
    const store = {
      defaultNs: null,
      namespaces: {
        acme: { CONTROL_URL: "https://api.example", ADMIN_TOKEN: "tok-acme", LABEL: "production" },
        "acme-staging": { CONTROL_URL: "https://api.example", ADMIN_TOKEN: "tok-stg" },
      },
    };
    writeTokenStore(p, store);
    assert.deepEqual(readTokenStore(p), store);
  });
});

test("writeTokenStore then readTokenStore round-trips the default namespace", () => {
  withTempHome((dir) => {
    const p = path.join(dir, "credentials");
    const store = {
      defaultNs: "acme",
      namespaces: {
        acme: { ADMIN_TOKEN: "tok-acme" },
        demo: { ADMIN_TOKEN: "tok-demo" },
      },
    };
    writeTokenStore(p, store);
    assert.match(readFileSync(p, "utf8"), /^WDL_NS="acme"$/m);
    assert.deepEqual(readTokenStore(p), store);
  });
});

test("writeTokenStore drops a default that has no stored entry", () => {
  withTempHome((dir) => {
    const p = path.join(dir, "credentials");
    writeTokenStore(p, { defaultNs: "ghost", namespaces: { acme: { ADMIN_TOKEN: "t" } } });
    assert.doesNotMatch(readFileSync(p, "utf8"), /WDL_NS=/);
    assert.equal(readTokenStore(p).defaultNs, null);
  });
});

test("writeTokenStore quotes and escapes so odd token characters round-trip", () => {
  withTempHome((dir) => {
    const p = path.join(dir, "credentials");
    const store = {
      defaultNs: null,
      namespaces: {
        acme: { ADMIN_TOKEN: 'tok with "quotes" and =sign #hash', LABEL: "multi\nline note" },
      },
    };
    writeTokenStore(p, store);
    assert.deepEqual(readTokenStore(p), store);
  });
});

test("round-trips a token containing literal backslash escape sequences", () => {
  withTempHome((dir) => {
    const p = path.join(dir, "credentials");
    // The token literally contains `\n`, `\t`, `\\`, `\"` as backslash+char,
    // plus a Windows-style path — none of which must be decoded as control chars.
    const store = {
      defaultNs: null,
      namespaces: {
        acme: { ADMIN_TOKEN: "a\\nb\\tc\\\\d\\\"e", LABEL: "C:\\Users\\x" },
      },
    };
    writeTokenStore(p, store);
    assert.deepEqual(readTokenStore(p), store);
  });
});

test("preserves a namespace named like an Object.prototype key", () => {
  withTempHome((dir) => {
    const p = path.join(dir, "credentials");
    const store = {
      defaultNs: "constructor",
      namespaces: {
        constructor: { ADMIN_TOKEN: "tok-ctor" },
        toString: { ADMIN_TOKEN: "tok-tostr" },
      },
    };
    writeTokenStore(p, store);
    const back = readTokenStore(p);
    assert.deepEqual(Object.keys(back.namespaces).sort(), ["constructor", "toString"]);
    assert.equal(back.namespaces["constructor"].ADMIN_TOKEN, "tok-ctor");
    assert.equal(back.defaultNs, "constructor");
  });
});

test("handles a __proto__ section without polluting the prototype", () => {
  withTempHome((dir) => {
    const p = path.join(dir, "credentials");
    writeFileSync(p, '[__proto__]\nADMIN_TOKEN="x"\n[acme]\nADMIN_TOKEN="a"\n');
    const back = readTokenStore(p);
    assert.deepEqual(Object.keys(back.namespaces).sort(), ["__proto__", "acme"]);
    assert.equal(back.namespaces["__proto__"].ADMIN_TOKEN, "x");
    assert.equal(Object.getPrototypeOf(back.namespaces), Object.prototype, "map prototype untouched");
    assert.equal(/** @type {any} */ ({}).ADMIN_TOKEN, undefined, "Object.prototype not polluted");
  });
});

test("writeTokenStore writes canonical sorted output with a managed-by header", () => {
  withTempHome((dir) => {
    const p = path.join(dir, "credentials");
    writeTokenStore(p, {
      namespaces: {
        zeta: { ADMIN_TOKEN: "z" },
        alpha: { ADMIN_TOKEN: "a", LABEL: "first" },
      },
    });
    const text = readFileSync(p, "utf8");
    assert.match(text, /^# Managed by `wdl token`/);
    assert.ok(text.indexOf("[alpha]") < text.indexOf("[zeta]"), "sections sorted");
    assert.match(text, /\[alpha\]\nADMIN_TOKEN="a"\nLABEL="first"/);
  });
});

test("writeTokenStore sets 0600 file permissions", () => {
  if (process.platform === "win32") return;
  withTempHome((dir) => {
    const p = path.join(dir, "credentials");
    writeTokenStore(p, { namespaces: { acme: { ADMIN_TOKEN: "t" } } });
    assert.equal(statSync(p).mode & 0o777, 0o600);
    // Re-write over an existing file keeps 0600.
    writeTokenStore(p, { namespaces: { acme: { ADMIN_TOKEN: "t2" } } });
    assert.equal(statSync(p).mode & 0o777, 0o600);
    // A pre-existing permissive (0644) file is tightened to 0600 before the
    // token bytes are written, not after.
    writeFileSync(p, "stale", { mode: 0o644 });
    chmodSync(p, 0o644);
    writeTokenStore(p, { namespaces: { acme: { ADMIN_TOKEN: "t3" } } });
    assert.equal(statSync(p).mode & 0o777, 0o600);
  });
});

test("readTokenStore rejects a key outside any section", () => {
  withTempHome((dir) => {
    const p = path.join(dir, "credentials");
    writeFileSync(p, "ADMIN_TOKEN=loose\n");
    assert.throws(() => readTokenStore(p), /outside a \[namespace\] section/);
  });
});

test("readTokenStore reads a base WDL_NS as the default namespace", () => {
  withTempHome((dir) => {
    const p = path.join(dir, "credentials");
    writeFileSync(p, 'WDL_NS="acme"\n[acme]\nADMIN_TOKEN="t"\n');
    assert.deepEqual(readTokenStore(p), { defaultNs: "acme", namespaces: { acme: { ADMIN_TOKEN: "t" } } });
  });
});

test("readTokenStore ignores unknown keys and comments", () => {
  withTempHome((dir) => {
    const p = path.join(dir, "credentials");
    writeFileSync(p, "# note\n[acme]\nADMIN_TOKEN=\"t\"\nUNKNOWN=x\n");
    assert.deepEqual(readTokenStore(p), { defaultNs: null, namespaces: { acme: { ADMIN_TOKEN: "t" } } });
  });
});

test("quoteValue escapes backslash before other sequences", () => {
  assert.equal(quoteValue("a\\b"), '"a\\\\b"');
  assert.equal(quoteValue('q"q'), '"q\\"q"');
});
