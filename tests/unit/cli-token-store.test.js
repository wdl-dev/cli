import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertStoreDirSecure,
  readTokenStore,
  tokenStoreDir,
  tokenStorePath,
  updateTokenStore,
  writeTokenStore,
} from "../../lib/token-store.js";
import { ESC, assertNoRawTerminalControls } from "./helpers.js";

/**
 * @template T
 * @param {(dir: string) => T} fn
 * @returns {T}
 */
function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-token-store-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * @param {string} lockDir
 * @param {string} owner
 */
function writeLockOwner(lockDir, owner) {
  writeFileSync(path.join(lockDir, "owner"), owner, { mode: 0o600 });
}

const TOKEN_STORE_MODULE_URL = new URL("../../lib/token-store.js", import.meta.url).href;
const POSIX_ONLY = { skip: process.platform === "win32" ? "POSIX-only filesystem behavior" : false };

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

test("tokenStoreDir on win32 honors APPDATA", () => {
  assert.equal(
    tokenStoreDir({ APPDATA: "C:\\Users\\u\\AppData\\Roaming" }, () => "C:\\Users\\u", "win32"),
    path.join("C:\\Users\\u\\AppData\\Roaming", "wdl")
  );
});

test("readTokenStore returns an empty store when the file is absent", () => {
  withTempDir((dir) => {
    assert.deepEqual(readTokenStore(path.join(dir, "credentials")), { defaultNs: null, namespaces: {} });
  });
});

test("writeTokenStore then readTokenStore round-trips namespaces and fields", () => {
  withTempDir((dir) => {
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

test("writeTokenStore uses an unguessable temporary filename", () => {
  withTempDir((dir) => {
    const p = path.join(dir, "wdl", "credentials");
    const fixedNow = 1234567890;
    const oldNow = Date.now;
    Date.now = () => fixedNow;
    try {
      const legacyTmpPath = `${p}.${process.pid}.${fixedNow}.tmp`;
      mkdirSync(path.dirname(p), { recursive: true });
      writeFileSync(legacyTmpPath, "stale temp");
      writeTokenStore(p, { namespaces: { acme: { ADMIN_TOKEN: "tok-acme" } } });
      assert.deepEqual(readTokenStore(p), {
        defaultNs: null,
        namespaces: { acme: { ADMIN_TOKEN: "tok-acme" } },
      });
      assert.equal(readFileSync(legacyTmpPath, "utf8"), "stale temp");
    } finally {
      Date.now = oldNow;
    }
  });
});

test("updateTokenStore serializes read-modify-write with a lock directory", () => {
  withTempDir((dir) => {
    const p = path.join(dir, "wdl", "credentials");
    const lockDir = `${p}.lock`;
    updateTokenStore(p, (store) => {
      store.namespaces.acme = { ADMIN_TOKEN: "tok-acme" };
      store.defaultNs = "acme";
    });
    updateTokenStore(p, (store) => {
      store.namespaces.beta = { ADMIN_TOKEN: "tok-beta" };
    });
    assert.deepEqual(readTokenStore(p), {
      defaultNs: "acme",
      namespaces: {
        acme: { ADMIN_TOKEN: "tok-acme" },
        beta: { ADMIN_TOKEN: "tok-beta" },
      },
    });
    assert.throws(
      () => {
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir, { recursive: true });
        try {
          updateTokenStore(p, () => {}, { lockTimeoutMs: 0 });
        } finally {
          rmSync(lockDir, { recursive: true, force: true });
        }
      },
      /credential store is locked/
    );
  });
});

test("updateTokenStore handles concurrent released-lock recovery", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-token-store-"));
  try {
    const p = path.join(dir, "wdl", "credentials");
    const workerCount = 8;
    const workers = Array.from({ length: workerCount }, (_, index) => {
      const ns = `ns-${index}`;
      const token = `tok-${index}`;
      const code = `
import { updateTokenStore } from ${JSON.stringify(TOKEN_STORE_MODULE_URL)};
updateTokenStore(${JSON.stringify(p)}, (store) => {
  store.namespaces[${JSON.stringify(ns)}] = { ADMIN_TOKEN: ${JSON.stringify(token)} };
}, { lockTimeoutMs: 30_000 });
`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", code], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      return new Promise((resolve, reject) => {
        /** @type {Buffer[]} */
        const stdout = [];
        /** @type {Buffer[]} */
        const stderr = [];
        child.stdout.on("data", (chunk) => stdout.push(chunk));
        child.stderr.on("data", (chunk) => stderr.push(chunk));
        child.on("error", reject);
        child.on("close", (code) => {
          if (code === 0) {
            resolve(undefined);
            return;
          }
          reject(new Error([
            `child ${ns} exited ${code}`,
            Buffer.concat(stdout).toString("utf8"),
            Buffer.concat(stderr).toString("utf8"),
          ].join("\n")));
        });
      });
    });

    const results = await Promise.allSettled(workers);
    const failures = results.filter((item) => item.status === "rejected");
    if (failures.length > 0) {
      assert.fail(failures.map((item) =>
        item.status === "rejected" ? String(item.reason?.stack || item.reason) : ""
      ).join("\n"));
    }

    const store = readTokenStore(p);
    assert.equal(Object.keys(store.namespaces).length, workerCount);
    for (let index = 0; index < workerCount; index += 1) {
      assert.equal(store.namespaces[`ns-${index}`]?.ADMIN_TOKEN, `tok-${index}`);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("updateTokenStore retries a read-modify-write when the lock is superseded before commit", () => {
  withTempDir((dir) => {
    const p = path.join(dir, "wdl", "credentials");
    writeTokenStore(p, { namespaces: { existing: { ADMIN_TOKEN: "tok-existing" } } });
    let attempts = 0;

    updateTokenStore(p, (store) => {
      attempts += 1;
      store.namespaces.acme = { ADMIN_TOKEN: "tok-acme" };
      if (attempts === 1) {
        rmSync(`${p}.lock`, { recursive: true, force: true });
        updateTokenStore(p, (innerStore) => {
          innerStore.namespaces.beta = { ADMIN_TOKEN: "tok-beta" };
        });
      }
    });

    assert.equal(attempts, 2);
    assert.deepEqual(readTokenStore(p), {
      defaultNs: null,
      namespaces: {
        acme: { ADMIN_TOKEN: "tok-acme" },
        beta: { ADMIN_TOKEN: "tok-beta" },
        existing: { ADMIN_TOKEN: "tok-existing" },
      },
    });
  });
});

test("updateTokenStore recovers a stale lock directory", () => {
  withTempDir((dir) => {
    const p = path.join(dir, "wdl", "credentials");
    const lockDir = `${p}.lock`;
    mkdirSync(lockDir, { recursive: true });
    const staleTime = new Date(Date.now() - 10_000);
    utimesSync(lockDir, staleTime, staleTime);

    updateTokenStore(p, (store) => {
      store.namespaces.acme = { ADMIN_TOKEN: "tok-acme" };
    }, { lockTimeoutMs: 0, staleLockMs: 1 });

    assert.deepEqual(readTokenStore(p), {
      defaultNs: null,
      namespaces: { acme: { ADMIN_TOKEN: "tok-acme" } },
    });
  });
});

test("updateTokenStore takeover clears stale temp files inside the lock", () => {
  withTempDir((dir) => {
    const p = path.join(dir, "wdl", "credentials");
    const lockDir = `${p}.lock`;
    const staleTmp = path.join(lockDir, "credentials.old-writer.tmp");
    mkdirSync(lockDir, { recursive: true });
    writeLockOwner(lockDir, "0:stale-owner");
    writeFileSync(staleTmp, "stale");
    const staleTime = new Date(Date.now() - 10_000);
    utimesSync(lockDir, staleTime, staleTime);

    updateTokenStore(p, (store) => {
      store.namespaces.acme = { ADMIN_TOKEN: "tok-acme" };
    }, { lockTimeoutMs: 0, staleLockMs: 1 });

    assert.equal(existsSync(staleTmp), false);
    assert.deepEqual(readTokenStore(p), {
      defaultNs: null,
      namespaces: { acme: { ADMIN_TOKEN: "tok-acme" } },
    });
  });
});

test("updateTokenStore creates a usable lock under a restrictive umask", POSIX_ONLY, () => {
  withTempDir((dir) => {
    const p = path.join(dir, "wdl", "credentials");
    const oldUmask = process.umask(0o777);
    try {
      updateTokenStore(p, (store) => {
        store.namespaces.acme = { ADMIN_TOKEN: "tok-acme" };
      });
    } finally {
      process.umask(oldUmask);
    }

    assert.deepEqual(readTokenStore(p), {
      defaultNs: null,
      namespaces: { acme: { ADMIN_TOKEN: "tok-acme" } },
    });
    const owner = readFileSync(path.join(`${p}.lock`, "owner"), "utf8");
    assert.equal(readFileSync(path.join(`${p}.lock`, "released"), "utf8"), owner);
  });
});

test("updateTokenStore does not steal a fresh lock whose owner pid is not visible", () => {
  withTempDir((dir) => {
    const p = path.join(dir, "wdl", "credentials");
    const lockDir = `${p}.lock`;
    mkdirSync(lockDir, { recursive: true });
    writeLockOwner(lockDir, "0:dead-or-remote-test-owner");

    try {
      assert.throws(
        () => updateTokenStore(p, () => {}, { lockTimeoutMs: 0, staleLockMs: 60_000 }),
        /credential store is locked/
      );
      assert.equal(readFileSync(path.join(lockDir, "owner"), "utf8"), "0:dead-or-remote-test-owner");
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  });
});

test("updateTokenStore recovers an old lock whose owner pid appears alive", () => {
  withTempDir((dir) => {
    const p = path.join(dir, "wdl", "credentials");
    const lockDir = `${p}.lock`;
    mkdirSync(lockDir, { recursive: true });
    writeLockOwner(lockDir, `${process.pid}:possibly-reused-test-owner`);
    const staleTime = new Date(Date.now() - 10_000);
    utimesSync(lockDir, staleTime, staleTime);

    updateTokenStore(p, (store) => {
      store.namespaces.acme = { ADMIN_TOKEN: "tok-acme" };
    }, { lockTimeoutMs: 0, staleLockMs: 1 });

    assert.deepEqual(readTokenStore(p), {
      defaultNs: null,
      namespaces: { acme: { ADMIN_TOKEN: "tok-acme" } },
    });
  });
});

test("updateTokenStore recovers a stale lock with an unreadable owner file", POSIX_ONLY, () => {
  withTempDir((dir) => {
    const p = path.join(dir, "wdl", "credentials");
    const lockDir = `${p}.lock`;
    mkdirSync(lockDir, { recursive: true });
    writeLockOwner(lockDir, "0:dead-test-owner");
    chmodSync(path.join(lockDir, "owner"), 0o000);
    const staleTime = new Date(Date.now() - 10_000);
    utimesSync(lockDir, staleTime, staleTime);

    updateTokenStore(p, (store) => {
      store.namespaces.acme = { ADMIN_TOKEN: "tok-acme" };
    }, { lockTimeoutMs: 0, staleLockMs: 1 });

    assert.deepEqual(readTokenStore(p), {
      defaultNs: null,
      namespaces: { acme: { ADMIN_TOKEN: "tok-acme" } },
    });
  });
});

test("updateTokenStore recovers a stale lock with an unreadable release marker", POSIX_ONLY, () => {
  withTempDir((dir) => {
    const p = path.join(dir, "wdl", "credentials");
    const lockDir = `${p}.lock`;
    const owner = "123:released-test-owner";
    mkdirSync(lockDir, { recursive: true });
    writeLockOwner(lockDir, owner);
    const releasedPath = path.join(lockDir, "released");
    writeFileSync(releasedPath, owner, { mode: 0o600 });
    chmodSync(releasedPath, 0o000);
    const staleTime = new Date(Date.now() - 10_000);
    utimesSync(lockDir, staleTime, staleTime);

    try {
      updateTokenStore(p, (store) => {
        store.namespaces.acme = { ADMIN_TOKEN: "tok-acme" };
      }, { lockTimeoutMs: 0, staleLockMs: 1 });
    } finally {
      if (existsSync(releasedPath)) chmodSync(releasedPath, 0o600);
    }

    assert.deepEqual(readTokenStore(p), {
      defaultNs: null,
      namespaces: { acme: { ADMIN_TOKEN: "tok-acme" } },
    });
  });
});

test("updateTokenStore recovers a stale regular-file lock", () => {
  withTempDir((dir) => {
    const p = path.join(dir, "wdl", "credentials");
    const lockDir = `${p}.lock`;
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(lockDir, "not a directory");
    const staleTime = new Date(Date.now() - 10_000);
    utimesSync(lockDir, staleTime, staleTime);

    updateTokenStore(p, (store) => {
      store.namespaces.acme = { ADMIN_TOKEN: "tok-acme" };
    }, { lockTimeoutMs: 0, staleLockMs: 1 });

    assert.deepEqual(readTokenStore(p), {
      defaultNs: null,
      namespaces: { acme: { ADMIN_TOKEN: "tok-acme" } },
    });
  });
});

test("updateTokenStore recovers a dangling-symlink lock at a zero stale threshold", POSIX_ONLY, () => {
  withTempDir((dir) => {
    const p = path.join(dir, "wdl", "credentials");
    const lockDir = `${p}.lock`;
    mkdirSync(path.dirname(p), { recursive: true });
    symlinkSync(path.join(dir, "missing-lock-target"), lockDir);

    updateTokenStore(p, (store) => {
      store.namespaces.acme = { ADMIN_TOKEN: "tok-acme" };
    }, { lockTimeoutMs: 0, staleLockMs: 0 });

    assert.deepEqual(readTokenStore(p), {
      defaultNs: null,
      namespaces: { acme: { ADMIN_TOKEN: "tok-acme" } },
    });
  });
});

test("updateTokenStore recovers a symlink lock at a zero stale threshold without chmodding its target", POSIX_ONLY, () => {
  withTempDir((dir) => {
    const p = path.join(dir, "wdl", "credentials");
    const lockDir = `${p}.lock`;
    const target = path.join(dir, "symlink-target");
    mkdirSync(path.dirname(p), { recursive: true });
    writeFileSync(target, "target", { mode: 0o600 });
    symlinkSync(target, lockDir);

    updateTokenStore(p, (store) => {
      store.namespaces.acme = { ADMIN_TOKEN: "tok-acme" };
    }, { lockTimeoutMs: 0, staleLockMs: 0 });

    assert.equal((statSync(target).mode & 0o777), 0o600);
    assert.deepEqual(readTokenStore(p), {
      defaultNs: null,
      namespaces: { acme: { ADMIN_TOKEN: "tok-acme" } },
    });
    assert.deepEqual(
      readdirSync(path.dirname(p)).filter((name) => name.startsWith(`${path.basename(p)}.lock.recovered-`)),
      []
    );
  });
});

test("updateTokenStore does not spin on a fresh dangling-symlink lock", POSIX_ONLY, () => {
  withTempDir((dir) => {
    const p = path.join(dir, "wdl", "credentials");
    const lockDir = `${p}.lock`;
    mkdirSync(path.dirname(p), { recursive: true });
    symlinkSync(path.join(dir, "missing-lock-target"), lockDir);

    assert.throws(
      () => updateTokenStore(p, () => {}, { lockTimeoutMs: 0, staleLockMs: 60_000 }),
      /credential store is locked/
    );
  });
});

test("updateTokenStore recovers a stale lock with an unreadable directory", POSIX_ONLY, () => {
  withTempDir((dir) => {
    const p = path.join(dir, "wdl", "credentials");
    const lockDir = `${p}.lock`;
    mkdirSync(lockDir, { recursive: true });
    writeLockOwner(lockDir, "0:unreadable-dir-owner");
    const staleTime = new Date(Date.now() - 10_000);
    utimesSync(lockDir, staleTime, staleTime);
    chmodSync(lockDir, 0o000);

    updateTokenStore(p, (store) => {
      store.namespaces.acme = { ADMIN_TOKEN: "tok-acme" };
    }, { lockTimeoutMs: 0, staleLockMs: 1 });

    assert.deepEqual(readTokenStore(p), {
      defaultNs: null,
      namespaces: { acme: { ADMIN_TOKEN: "tok-acme" } },
    });
    assert.deepEqual(
      readdirSync(path.dirname(p)).filter((name) => name.startsWith(`${path.basename(p)}.lock.recovered-`)),
      []
    );
  });
});

test("updateTokenStore refuses to write or release after lock ownership changes", () => {
  withTempDir((dir) => {
    const p = path.join(dir, "wdl", "credentials");
    const lockDir = `${p}.lock`;
    writeTokenStore(p, { namespaces: { existing: { ADMIN_TOKEN: "tok-existing" } } });

    try {
      assert.throws(
        () => updateTokenStore(p, (store) => {
          store.namespaces.acme = { ADMIN_TOKEN: "tok-acme" };
          rmSync(lockDir, { recursive: true, force: true });
          mkdirSync(lockDir, { recursive: true });
          writeLockOwner(lockDir, "new-owner");
        }, { lockTimeoutMs: 0 }),
        /credential store is locked/
      );
      assert.deepEqual(readTokenStore(p), {
        defaultNs: null,
        namespaces: { existing: { ADMIN_TOKEN: "tok-existing" } },
      });
      assert.equal(readFileSync(path.join(lockDir, "owner"), "utf8"), "new-owner");
    } finally {
      rmSync(lockDir, { recursive: true, force: true });
    }
  });
});

test("writeTokenStore then readTokenStore round-trips the default namespace", () => {
  withTempDir((dir) => {
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
  withTempDir((dir) => {
    const p = path.join(dir, "credentials");
    writeTokenStore(p, { defaultNs: "ghost", namespaces: { acme: { ADMIN_TOKEN: "t" } } });
    assert.doesNotMatch(readFileSync(p, "utf8"), /WDL_NS=/);
    assert.equal(readTokenStore(p).defaultNs, null);
  });
});

test("writeTokenStore quotes and escapes so odd token characters round-trip", () => {
  withTempDir((dir) => {
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
  withTempDir((dir) => {
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
  withTempDir((dir) => {
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
  withTempDir((dir) => {
    const p = path.join(dir, "credentials");
    writeFileSync(p, '[__proto__]\nADMIN_TOKEN="x"\n[acme]\nADMIN_TOKEN="a"\n');
    const back = readTokenStore(p);
    assert.deepEqual(Object.keys(back.namespaces).sort(), ["__proto__", "acme"]);
    assert.equal(back.namespaces["__proto__"].ADMIN_TOKEN, "x");
    assert.equal(Object.getPrototypeOf(back.namespaces), Object.prototype, "map prototype untouched");
    assert.equal(/** @type {Record<string, unknown>} */ ({}).ADMIN_TOKEN, undefined, "Object.prototype not polluted");
  });
});

test("writeTokenStore writes canonical sorted output with a managed-by header", () => {
  withTempDir((dir) => {
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

test("writeTokenStore sets 0600 file and 0700 dir permissions", POSIX_ONLY, () => {
  withTempDir((dir) => {
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
    // The dir is 0700, and a pre-existing 0755 dir is tightened too.
    const storeDir = path.dirname(p);
    assert.equal(statSync(storeDir).mode & 0o777, 0o700);
    chmodSync(storeDir, 0o755);
    writeTokenStore(p, { namespaces: { acme: { ADMIN_TOKEN: "t4" } } });
    assert.equal(statSync(storeDir).mode & 0o777, 0o700);
    // A freshly created store dir (the mkdir branch, not just the tighten branch).
    const fresh = path.join(dir, "fresh", "credentials");
    writeTokenStore(fresh, { namespaces: { acme: { ADMIN_TOKEN: "t" } } });
    assert.equal(statSync(path.dirname(fresh)).mode & 0o777, 0o700);
  });
});

test("assertStoreDirSecure refuses a group/world-writable store dir", POSIX_ONLY, () => {
  /** @type {string[]} */
  const made = [];
  /** @param {number} mode */
  const mkdir = (mode) => {
    const d = mkdtempSync(path.join(tmpdir(), "wdl-store-secure-"));
    chmodSync(d, mode);
    made.push(d);
    return d;
  };
  try {
    assert.doesNotThrow(() => assertStoreDirSecure(mkdir(0o700)));
    assert.doesNotThrow(() => assertStoreDirSecure(mkdir(0o755))); // read/exec, not writable
    assert.throws(() => assertStoreDirSecure(mkdir(0o770)), /group\/world-writable/);
    assert.throws(() => assertStoreDirSecure(mkdir(0o777)), /group\/world-writable/);
    const bad = path.join(mkdtempSync(path.join(tmpdir(), "wdl-store-secure-")), `bad${ESC}dir\nFORGED\rBAD`);
    mkdirSync(bad);
    chmodSync(bad, 0o777);
    made.push(path.dirname(bad));
    assert.throws(
      () => assertStoreDirSecure(bad),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assert.match(message, /bad\\u001bdir\\nFORGED\\rBAD/);
        assertNoRawTerminalControls(message, "the error");
        return true;
      }
    );
    // The win32 branch never inspects POSIX mode bits.
    assert.doesNotThrow(() => assertStoreDirSecure(mkdir(0o777), "win32"));
  } finally {
    for (const d of made) rmSync(d, { recursive: true, force: true });
  }
});

test("updateTokenStore escapes write-side filesystem errors", () => {
  withTempDir((dir) => {
    const badXdg = path.join(dir, `bad${ESC}dir\nFORGED\rBAD`);
    writeFileSync(badXdg, "");
    const p = path.join(badXdg, "wdl", "credentials");

    assert.throws(
      () => updateTokenStore(p, (store) => {
        store.namespaces.acme = { ADMIN_TOKEN: "tok" };
      }),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assert.match(message, /failed to update credential store/);
        assert.match(message, /bad\\u001bdir\\nFORGED\\rBAD/);
        assertNoRawTerminalControls(message, "the error");
        return true;
      }
    );
  });
});

test("writeTokenStore escapes write-side filesystem errors", () => {
  withTempDir((dir) => {
    const badXdg = path.join(dir, `bad${ESC}dir\nFORGED\rBAD`);
    writeFileSync(badXdg, "");
    const p = path.join(badXdg, "wdl", "credentials");

    assert.throws(
      () => writeTokenStore(p, { defaultNs: null, namespaces: { acme: { ADMIN_TOKEN: "tok" } } }),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assert.match(message, /failed to write credential store/);
        assert.match(message, /bad\\u001bdir\\nFORGED\\rBAD/);
        assertNoRawTerminalControls(message, "the error");
        return true;
      }
    );
  });
});

test("readTokenStore rejects a key outside any section", () => {
  withTempDir((dir) => {
    const p = path.join(dir, "credentials");
    writeFileSync(p, "ADMIN_TOKEN=loose\n");
    assert.throws(() => readTokenStore(p), /outside a \[namespace\] section/);
  });
});

test("readTokenStore reads a base WDL_NS as the default namespace", () => {
  withTempDir((dir) => {
    const p = path.join(dir, "credentials");
    writeFileSync(p, 'WDL_NS="acme"\n[acme]\nADMIN_TOKEN="t"\n');
    assert.deepEqual(readTokenStore(p), { defaultNs: "acme", namespaces: { acme: { ADMIN_TOKEN: "t" } } });
  });
});

test("readTokenStore ignores unknown keys and comments", () => {
  withTempDir((dir) => {
    const p = path.join(dir, "credentials");
    writeFileSync(p, "# note\n[acme]\nADMIN_TOKEN=\"t\"\nUNKNOWN=x\n");
    assert.deepEqual(readTokenStore(p), { defaultNs: null, namespaces: { acme: { ADMIN_TOKEN: "t" } } });
  });
});
