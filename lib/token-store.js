import { randomUUID } from "node:crypto";
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, hasErrorCode, isNonEmptyString } from "./common.js";
import { parseDotEnvSection, parseDotEnvValue, quoteValue } from "./dotenv.js";
import { escapeTerminalText, shellArgForDisplay } from "./output.js";

// The global credential store is the lowest-precedence layer of the same
// credential model as a project `.env`: a `dotenv`/INI-subset file in the
// user's config dir, command-managed by `wdl token`. Each `[namespace]`
// section is self-contained (its own control URL + token) because different
// namespaces can live on different control planes. `LABEL` is an optional
// human note shown by `wdl token list`.
//
// A base `WDL_NS` line (before any section) names the default namespace, used
// when no --ns/WDL_NS selects one — the store's analogue of a base WDL_NS in a
// project `.env`. The parsed store is `{ defaultNs, namespaces }`.
const STORE_KEYS = ["CONTROL_URL", "ADMIN_TOKEN", "LABEL"];
const LOCK_WAIT_MS = 25;
const DEFAULT_LOCK_TIMEOUT_MS = 5_000;
// Store mutations hold the lock only around synchronous disk I/O. A lock older
// than this is recoverable even if its PID appears alive; the owner nonce and
// mtime are refreshed on the final commit path so a superseded writer normally
// fails before replacing the store.
const DEFAULT_STALE_LOCK_MS = 60_000;
const LOCK_OWNER_FILE = "owner";
const LOCK_RELEASED_FILE = "released";
const LOCK_CONTENTION_CODE = "WDL_LOCK_CONTENTION";
const LOCK_SUPERSEDED_CODE = "WDL_LOCK_SUPERSEDED";
const UPDATE_RETRY_LIMIT = 8;
const LOCK_WAIT = new Int32Array(new SharedArrayBuffer(4));

/**
 * The parsed credential store: an optional default-namespace pointer plus the
 * per-`[namespace]` sections (each a flat key/value map).
 * @typedef {{ defaultNs?: string | null, namespaces?: Record<string, Record<string, string>> }} TokenStore
 */

// Resolve the per-user config directory: %APPDATA%\wdl on Windows, else
// $XDG_CONFIG_HOME/wdl or ~/.config/wdl. `homedir` is injectable for tests.
/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {() => string} [homedir]
 * @param {NodeJS.Platform} [platform]
 */
export function tokenStoreDir(env = process.env, homedir = os.homedir, platform = process.platform) {
  if (platform === "win32" && env.APPDATA) {
    return path.join(env.APPDATA, "wdl");
  }
  const base =
    isNonEmptyString(env.XDG_CONFIG_HOME)
      ? env.XDG_CONFIG_HOME
      : path.join(homedir(), ".config");
  return path.join(base, "wdl");
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {() => string} [homedir]
 * @param {NodeJS.Platform} [platform]
 */
export function tokenStorePath(env = process.env, homedir = os.homedir, platform = process.platform) {
  return path.join(tokenStoreDir(env, homedir, platform), "credentials");
}

// Parse the store into { defaultNs, namespaces: { ns: { CONTROL_URL,
// ADMIN_TOKEN, LABEL } } } using the same section/value dialect primitives as
// project `.env`, so the two formats never diverge. A missing file is an empty
// store ({ defaultNs: null, namespaces: {} }).
/**
 * @param {string} storePath
 * @returns {{ defaultNs: string | null, namespaces: Record<string, Record<string, string>> }}
 */
export function readTokenStore(storePath) {
  /** @type {string} */
  let text;
  try {
    text = readFileSync(storePath, "utf8");
  } catch (err) {
    if (hasErrorCode(err) && err.code === "ENOENT") return { defaultNs: null, namespaces: {} };
    throw new CliError(
      `failed to read credential store ${escapeTerminalText(storePath)}: ${formatTokenStoreError(err)}`
    );
  }

  /** @type {Record<string, Record<string, string>>} */
  const namespaces = {};
  /** @type {string | null} */
  let defaultNs = null;
  /** @type {string | null} */
  let section = null;
  for (const [idx, rawLine] of text.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const nextSection = parseDotEnvSection(line, idx + 1);
    if (nextSection !== null) {
      section = nextSection;
      // defineProperty, never `namespaces[section] = {}`: a "__proto__" section
      // would invoke the prototype setter (dropping the section), and a
      // "constructor"/"toString" one would collide with an inherited member.
      // defineProperty creates the own data entry regardless, prototype intact.
      if (!Object.hasOwn(namespaces, section)) {
        Object.defineProperty(namespaces, section, { value: {}, writable: true, enumerable: true, configurable: true });
      }
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) {
      throw new CliError(`Invalid credentials line ${idx + 1}: expected KEY=value`);
    }
    const key = line.slice(0, eq).trim();
    const value = parseDotEnvValue(line.slice(eq + 1).trim());
    if (section === null) {
      // The only key allowed before any [namespace] is the default-namespace
      // pointer, the store's analogue of a base WDL_NS in a project `.env`.
      if (key === "WDL_NS") {
        defaultNs = value;
        continue;
      }
      throw new CliError(`Invalid credentials line ${idx + 1}: key outside a [namespace] section`);
    }
    if (!STORE_KEYS.includes(key)) continue;
    namespaces[section][key] = value;
  }
  return { defaultNs, namespaces };
}

/** @param {unknown} err */
function formatTokenStoreError(err) {
  const message = err instanceof Error && err.message ? err.message : String(err);
  return escapeTerminalText(message);
}

/**
 * @param {unknown} err
 * @param {string} prefix
 */
function wrapTokenStoreFsError(err, prefix) {
  if (err instanceof CliError) return err;
  if (hasErrorCode(err)) return new CliError(`${prefix}: ${formatTokenStoreError(err)}`);
  return err;
}

// A 0600 credentials file is not enough on its own: in a group/world-writable
// dir another user can delete, replace, or symlink-swap the fixed-path file. So
// refuse to write into a dir anyone else can write. (POSIX only — Windows mode
// bits are not meaningful here.)
/**
 * @param {string} storeDir
 * @param {NodeJS.Platform} [platform]
 */
export function assertStoreDirSecure(storeDir, platform = process.platform) {
  if (platform === "win32") return;
  if ((statSync(storeDir).mode & 0o022) !== 0) {
    const escapedDir = escapeTerminalText(storeDir);
    const quotedDir = shellArgForDisplay(storeDir);
    throw new CliError(
      `refusing to write credentials: ${escapedDir} is group/world-writable; restrict it with \`chmod 700 ${quotedDir}\``
    );
  }
}

// Serialize the store back to the same dialect — every value double-quoted and
// escaped so it round-trips through parseDotEnvValue — and write it with 0600
// perms (0700 dir). The file is command-owned, so it is rewritten canonically
// (default first, then sorted sections, fixed key order); user comments are not
// preserved (edit a project `.env` for hand-managed notes).
/**
 * @param {string} storePath
 * @param {TokenStore} store
 */
export function writeTokenStore(storePath, store) {
  try {
    writeTokenStoreFile(storePath, store);
  } catch (err) {
    throw wrapTokenStoreFsError(err, "failed to write credential store");
  }
}

/**
 * @param {string} storePath
 * @param {TokenStore} store
 * @param {{ beforeCommit?: () => void, tempDir?: string }} [options]
 */
function writeTokenStoreFile(storePath, store, { beforeCommit = () => {}, tempDir = path.dirname(storePath) } = {}) {
  const namespaces = store.namespaces || {};
  const lines = [
    "# Managed by `wdl token`. Do not hand-edit — use a project .env for overrides.",
    "",
  ];
  // Write the default-namespace pointer only when it has a stored entry, so the
  // file never carries a dangling default. Mirrors a base WDL_NS in a `.env`.
  if (store.defaultNs && Object.hasOwn(namespaces, store.defaultNs)) {
    lines.push(`WDL_NS=${quoteValue(store.defaultNs)}`, "");
  }
  for (const ns of Object.keys(namespaces).sort()) {
    lines.push(`[${ns}]`);
    for (const key of STORE_KEYS) {
      const value = namespaces[ns][key];
      if (value == null || value === "") continue;
      lines.push(`${key}=${quoteValue(value)}`);
    }
    lines.push("");
  }
  const storeDir = path.dirname(storePath);
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  // Best-effort tighten a pre-existing dir (mkdirSync's mode only applies on
  // creation). Tolerate a chmod failure (root-owned dir / no-chmod mount) — the
  // assertion below enforces the property that actually matters.
  try {
    chmodSync(storeDir, 0o700);
  } catch {
    // best-effort
  }
  assertStoreDirSecure(storeDir);
  const tmpPath = path.join(tempDir, `${path.basename(storePath)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    writeFileSync(tmpPath, lines.join("\n"), { mode: 0o600, flag: "wx" });
    chmodSync(tmpPath, 0o600);
    beforeCommit();
    renameSync(tmpPath, storePath);
    try {
      chmodSync(storePath, 0o600);
    } catch {
      // The file was created 0600 before the atomic replace. A post-commit
      // chmod failure must not make a persisted credential mutation look
      // failed to the caller.
    }
  } catch (err) {
    rmSync(tmpPath, { force: true });
    throw err;
  }
}

/**
 * Mutates the store under the lock. The update callback may be re-run if
 * another writer supersedes the lock before commit; keep it to deterministic
 * store mutation.
 *
 * @template R
 * @param {string} storePath
 * @param {(store: ReturnType<typeof readTokenStore>) => R} update
 * @param {{ lockTimeoutMs?: number, staleLockMs?: number }} [options]
 * @returns {R}
 */
export function updateTokenStore(
  storePath,
  update,
  {
    lockTimeoutMs = DEFAULT_LOCK_TIMEOUT_MS,
    staleLockMs = DEFAULT_STALE_LOCK_MS,
  } = {}
) {
  /** @type {R | undefined} */
  let result;
  for (let attempt = 0; attempt < UPDATE_RETRY_LIMIT; attempt += 1) {
    try {
      withTokenStoreLock(storePath, lockTimeoutMs, staleLockMs, (owner) => {
        const store = readTokenStore(storePath);
        result = update(store);
        refreshTokenStoreLockOwner(storePath, owner);
        try {
          writeTokenStoreFile(storePath, store, {
            beforeCommit: () => refreshTokenStoreLockOwner(storePath, owner),
            tempDir: `${storePath}.lock`,
          });
        } catch (err) {
          if (hasErrorCode(err) && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
            throw tokenStoreLockSupersededError();
          }
          throw err;
        }
      });
      return /** @type {R} */ (result);
    } catch (err) {
      if (!isTokenStoreLockSupersededError(err) || attempt === UPDATE_RETRY_LIMIT - 1) {
        throw wrapTokenStoreFsError(err, "failed to update credential store");
      }
      result = undefined;
      Atomics.wait(LOCK_WAIT, 0, 0, LOCK_WAIT_MS);
    }
  }
  throw tokenStoreLockSupersededError();
}

/**
 * @param {string} storePath
 * @param {number} lockTimeoutMs
 * @param {number} staleLockMs
 * @param {(owner: string) => void} fn
 */
function withTokenStoreLock(storePath, lockTimeoutMs, staleLockMs, fn) {
  const storeDir = path.dirname(storePath);
  prepareTokenStoreDir(storeDir);
  const lockDir = `${storePath}.lock`;
  const owner = acquireTokenStoreLock(lockDir, lockTimeoutMs, staleLockMs);
  try {
    fn(owner);
  } finally {
    releaseTokenStoreLock(lockDir, owner);
  }
}

/** @param {string} storeDir */
function prepareTokenStoreDir(storeDir) {
  mkdirSync(storeDir, { recursive: true, mode: 0o700 });
  try {
    chmodSync(storeDir, 0o700);
  } catch {
    // best-effort
  }
  assertStoreDirSecure(storeDir);
}

/**
 * @param {string} lockDir
 * @param {number} lockTimeoutMs
 * @param {number} staleLockMs
 * @returns {string}
 */
function acquireTokenStoreLock(lockDir, lockTimeoutMs, staleLockMs) {
  const deadline = Date.now() + Math.max(0, lockTimeoutMs);
  const owner = `${process.pid}:${randomUUID()}`;
  while (true) {
    try {
      createTokenStoreLock(lockDir, owner);
      return owner;
    } catch (err) {
      if (!isTokenStoreLockContentionError(err)) throw err;
      if (hasErrorCode(err) && err.code === "EEXIST" &&
          recoverTokenStoreLock(lockDir, owner, staleLockMs)) {
        return owner;
      }
      if (Date.now() >= deadline) {
        throw new CliError(
          "credential store is locked by another wdl token command; retry after it finishes"
        );
      }
      Atomics.wait(LOCK_WAIT, 0, 0, LOCK_WAIT_MS);
    }
  }
}

/**
 * @param {string} lockDir
 * @param {string} owner
 */
function createTokenStoreLock(lockDir, owner) {
  mkdirSync(lockDir, { mode: 0o700 });
  /** @type {import("node:fs").Stats | null} */
  let created = null;
  try {
    created = lstatSync(lockDir);
    chmodSync(lockDir, 0o700);
    writeFileSync(lockOwnerPath(lockDir), owner, { mode: 0o600, flag: "wx" });
    chmodSync(lockOwnerPath(lockDir), 0o600);
  } catch (err) {
    if (created) removeCreatedTokenStoreLock(lockDir, created, owner);
    if (isLockPathContentionFsError(err)) throw tokenStoreLockContentionError(err);
    throw err;
  }
}

/**
 * @param {string} lockDir
 * @param {string} owner
 * @param {number} staleLockMs
 */
function recoverTokenStoreLock(lockDir, owner, staleLockMs) {
  const recoveredPath = moveReleasedTokenStoreLock(lockDir) ||
    moveStaleTokenStoreLock(lockDir, staleLockMs);
  if (!recoveredPath) return false;
  try {
    createTokenStoreLock(lockDir, owner);
    return true;
  } catch (err) {
    if (isTokenStoreLockContentionError(err)) return false;
    throw err;
  } finally {
    cleanupRecoveredTokenStoreLock(recoveredPath);
  }
}

/** @param {unknown} err */
function isTokenStoreLockContentionError(err) {
  return hasErrorCode(err) && (
    err.code === "EEXIST" ||
    err.code === LOCK_CONTENTION_CODE
  );
}

/** @param {unknown} err */
function isLockPathContentionFsError(err) {
  return hasErrorCode(err) && (err.code === "ENOENT" || err.code === "ENOTDIR");
}

/** @param {unknown} err */
function tokenStoreLockContentionError(err) {
  const wrapped = new Error(err instanceof Error && err.message ? err.message : "credential store lock contention");
  Object.defineProperty(wrapped, "code", { value: LOCK_CONTENTION_CODE });
  return wrapped;
}

/** @param {unknown} err */
function isTokenStoreLockSupersededError(err) {
  return hasErrorCode(err) && err.code === LOCK_SUPERSEDED_CODE;
}

function tokenStoreLockSupersededError() {
  const err = new CliError("credential store lock was superseded before write; retry the wdl token command");
  Object.defineProperty(err, "code", { value: LOCK_SUPERSEDED_CODE });
  return err;
}

/**
 * @param {string} lockDir
 * @returns {string | false}
 */
function moveReleasedTokenStoreLock(lockDir) {
  try {
    const observed = lstatSync(lockDir);
    if (!observed.isDirectory()) return false;
    const observedOwner = readTokenStoreLockOwner(lockDir);
    if (observedOwner === null) return false;
    if (readTokenStoreLockRelease(lockDir) !== observedOwner) return false;
    return moveObservedTokenStoreLock(lockDir, observed, {
      owner: observedOwner,
      release: observedOwner,
      requireUnchangedMtime: false,
    });
  } catch (err) {
    if (hasErrorCode(err) && err.code === "ENOENT") return false;
    if (isLockRecoveryFsError(err)) throw tokenStoreLockRecoveryError(err);
    throw err;
  }
}

/**
 * @param {string} lockDir
 * @param {number} staleLockMs
 * @returns {string | false}
 */
function moveStaleTokenStoreLock(lockDir, staleLockMs) {
  const maxAgeMs = Math.max(0, staleLockMs);
  try {
    const observed = lstatSync(lockDir);
    const ageMs = Date.now() - observed.mtimeMs;
    if (maxAgeMs > 0 && ageMs < maxAgeMs) return false;
    if (!observed.isDirectory()) {
      return moveObservedNonDirectoryLock(lockDir, observed);
    }
    const observedOwner = readTokenStoreLockOwner(lockDir);
    return moveObservedTokenStoreLock(lockDir, observed, {
      owner: observedOwner,
      release: undefined,
      requireUnchangedMtime: true,
    });
  } catch (err) {
    if (hasErrorCode(err) && err.code === "ENOENT") return false;
    if (isLockRecoveryFsError(err)) throw tokenStoreLockRecoveryError(err);
    throw err;
  }
}

/**
 * @param {string} lockDir
 * @param {import("node:fs").Stats} created
 * @param {string} owner
 */
function removeCreatedTokenStoreLock(lockDir, created, owner) {
  try {
    const current = lstatSync(lockDir);
    if (current.dev !== created.dev || current.ino !== created.ino || !current.isDirectory()) return;
    const currentOwner = readTokenStoreLockOwner(lockDir);
    if (currentOwner !== null && currentOwner !== owner) return;
    rmSync(lockDir, { recursive: true, force: true });
  } catch (err) {
    if (hasErrorCode(err) && err.code === "ENOENT") return;
    if (hasErrorCode(err) && err.code === "ENOTDIR") return;
    throw err;
  }
}

/**
 * @param {string} storePath
 * @param {string} owner
 */
function assertTokenStoreLockOwner(storePath, owner) {
  const lockDir = `${storePath}.lock`;
  if (readTokenStoreLockOwner(lockDir) === owner) return;
  throw tokenStoreLockSupersededError();
}

/**
 * @param {string} storePath
 * @param {string} owner
 */
function refreshTokenStoreLockOwner(storePath, owner) {
  const lockDir = `${storePath}.lock`;
  assertTokenStoreLockOwner(storePath, owner);
  try {
    const now = new Date();
    utimesSync(lockDir, now, now);
  } catch (err) {
    if (hasErrorCode(err) && err.code === "ENOENT") {
      throw tokenStoreLockSupersededError();
    }
    throw err;
  }
  assertTokenStoreLockOwner(storePath, owner);
}

/**
 * @param {string} lockDir
 * @param {import("node:fs").Stats} observed
 * @param {{ owner: string | null, release?: string, requireUnchangedMtime: boolean }} expected
 * @returns {string | false}
 */
function moveObservedTokenStoreLock(lockDir, observed, expected) {
  try {
    const current = lstatSync(lockDir);
    if (current.dev !== observed.dev || current.ino !== observed.ino) return false;
    if (expected.requireUnchangedMtime && current.mtimeMs !== observed.mtimeMs) return false;
    if (!current.isDirectory()) return false;
    if (readTokenStoreLockOwner(lockDir) !== expected.owner) return false;
    if (expected.release !== undefined &&
        (expected.owner === null || readTokenStoreLockRelease(lockDir) !== expected.release)) {
      return false;
    }
    const final = lstatSync(lockDir);
    if (final.dev !== observed.dev || final.ino !== observed.ino) return false;
    if (expected.requireUnchangedMtime && final.mtimeMs !== observed.mtimeMs) return false;
    if (!final.isDirectory()) return false;
    const recoveredPath = recoveredTokenStoreLockPath(lockDir);
    renameSync(lockDir, recoveredPath);
    return recoveredPath;
  } catch (err) {
    if (hasErrorCode(err) && err.code === "ENOENT") return false;
    throw err;
  }
}

/**
 * @param {string} lockPath
 * @param {import("node:fs").Stats} observed
 * @returns {string | false}
 */
function moveObservedNonDirectoryLock(lockPath, observed) {
  try {
    const current = lstatSync(lockPath);
    if (current.dev !== observed.dev || current.ino !== observed.ino) return false;
    if (current.isDirectory()) return false;
    const recoveredPath = recoveredTokenStoreLockPath(lockPath);
    renameSync(lockPath, recoveredPath);
    return recoveredPath;
  } catch (err) {
    if (hasErrorCode(err) && err.code === "ENOENT") return false;
    if (hasErrorCode(err) && (err.code === "EISDIR" || err.code === "EPERM")) return false;
    throw err;
  }
}

/** @param {string} lockPath */
function recoveredTokenStoreLockPath(lockPath) {
  return `${lockPath}.recovered-${process.pid}-${randomUUID()}`;
}

/** @param {string} recoveredPath */
function cleanupRecoveredTokenStoreLock(recoveredPath) {
  try {
    if (lstatSync(recoveredPath).isDirectory()) chmodSync(recoveredPath, 0o700);
    rmSync(recoveredPath, { recursive: true, force: true });
  } catch (err) {
    if (hasErrorCode(err) && err.code === "ENOENT") return;
    // best-effort cleanup for an old stale lock; the new active lock has already
    // been created, so an unrecoverable cleanup path should not break the
    // credential-store mutation.
  }
}

/** @param {string} lockDir */
function lockOwnerPath(lockDir) {
  return path.join(lockDir, LOCK_OWNER_FILE);
}

/**
 * @param {string} lockDir
 */
function lockReleasedPath(lockDir) {
  return path.join(lockDir, LOCK_RELEASED_FILE);
}

/**
 * @param {string} lockDir
 * @returns {string | null}
 */
function readTokenStoreLockOwner(lockDir) {
  try {
    return readFileSync(lockOwnerPath(lockDir), "utf8");
  } catch (err) {
    if (hasErrorCode(err) && err.code === "ENOENT") return null;
    if (hasErrorCode(err) && err.code === "ENOTDIR") return null;
    // A crash between owner-file creation and chmod can leave an unreadable
    // file under a stale lock. Treat it as ownerless; stale takeover still
    // applies the age check before replacing the owner.
    if (hasErrorCode(err) && (err.code === "EACCES" || err.code === "EPERM")) return null;
    throw err;
  }
}

/**
 * @param {string} lockDir
 * @returns {string | null}
 */
function readTokenStoreLockRelease(lockDir) {
  try {
    return readFileSync(lockReleasedPath(lockDir), "utf8");
  } catch (err) {
    if (hasErrorCode(err) && err.code === "ENOENT") return null;
    if (hasErrorCode(err) && err.code === "ENOTDIR") return null;
    // A crash or restrictive umask can leave the release marker unreadable.
    // Treat it as unconfirmed release; stale takeover can still recover the
    // lock after the directory age check without leaking a raw filesystem error.
    if (hasErrorCode(err) && (err.code === "EACCES" || err.code === "EPERM")) return null;
    throw err;
  }
}

/** @param {unknown} err */
function isLockRecoveryFsError(err) {
  return hasErrorCode(err) && (
    err.code === "EACCES" ||
    err.code === "EPERM" ||
    err.code === "ENOTDIR"
  );
}

/** @param {unknown} err */
function tokenStoreLockRecoveryError(err) {
  const message = err instanceof Error && err.message ? err.message : String(err);
  return new CliError(
    `credential store lock could not be recovered; remove the stale lock and retry: ${escapeTerminalText(message)}`
  );
}

/**
 * @param {string} lockDir
 * @param {string} owner
 */
function releaseTokenStoreLock(lockDir, owner) {
  try {
    if (readTokenStoreLockOwner(lockDir) !== owner) return;
    const releasedPath = lockReleasedPath(lockDir);
    writeFileSync(releasedPath, owner, { mode: 0o600 });
    chmodSync(releasedPath, 0o600);
  } catch {
    // The store mutation has already committed. Do not turn a best-effort
    // release marker failure into a false failed write; stale recovery will
    // reclaim an unreleased owner lock if needed.
  }
}

// The `readStore` loadCliControlEnv expects: the real disk reader, or a no-op
// when the store is disabled (--no-token-store / WDL_TOKEN_STORE=off). Shared so
// the bin dispatcher and config-state never drift on what "disabled" reads.
/**
 * @param {boolean} disabled
 * @returns {(env: NodeJS.ProcessEnv) => TokenStore}
 */
export function tokenStoreReader(disabled) {
  return disabled ? () => ({}) : (env) => readTokenStore(tokenStorePath(env));
}
