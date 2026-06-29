import { chmodSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, hasErrorCode, isNonEmptyString } from "./common.js";
import { parseDotEnvSection, parseDotEnvValue, quoteValue } from "./dotenv.js";

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
    throw err;
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
    throw new CliError(
      `refusing to write credentials: ${storeDir} is group/world-writable; restrict it with \`chmod 700 ${storeDir}\``
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
  // Tighten an existing file to 0600 BEFORE writing token bytes: writeFileSync's
  // mode only applies when it creates the file, so without this a pre-existing
  // permissive (e.g. 0644) credentials file would receive the secret while still
  // world-readable, with a window until a post-write chmod. A non-ENOENT failure
  // aborts before the token is written.
  try {
    chmodSync(storePath, 0o600);
  } catch (err) {
    if (!hasErrorCode(err) || err.code !== "ENOENT") throw err;
  }
  writeFileSync(storePath, lines.join("\n"), { mode: 0o600 });
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
