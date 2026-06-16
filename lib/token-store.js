import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { CliError, parseDotEnvSection, parseDotEnvValue, quoteValue } from "./common.js";

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

// Resolve the per-user config directory: %APPDATA%\wdl on Windows, else
// $XDG_CONFIG_HOME/wdl or ~/.config/wdl. `homedir` is injectable for tests.
export function tokenStoreDir(env = process.env, homedir = os.homedir) {
  if (process.platform === "win32" && env.APPDATA) {
    return path.join(env.APPDATA, "wdl");
  }
  const base =
    typeof env.XDG_CONFIG_HOME === "string" && env.XDG_CONFIG_HOME.length > 0
      ? env.XDG_CONFIG_HOME
      : path.join(homedir(), ".config");
  return path.join(base, "wdl");
}

export function tokenStorePath(env = process.env, homedir = os.homedir) {
  return path.join(tokenStoreDir(env, homedir), "credentials");
}

// Parse the store into { defaultNs, namespaces: { ns: { CONTROL_URL,
// ADMIN_TOKEN, LABEL } } } using the same section/value dialect primitives as
// project `.env`, so the two formats never diverge. A missing file is an empty
// store ({ defaultNs: null, namespaces: {} }).
/** @returns {{ defaultNs: string | null, namespaces: Record<string, Record<string, string>> }} */
export function readTokenStore(storePath) {
  let text;
  try {
    text = readFileSync(storePath, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return { defaultNs: null, namespaces: {} };
    throw err;
  }

  /** @type {Record<string, Record<string, string>>} */
  const namespaces = {};
  /** @type {string | null} */
  let defaultNs = null;
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

// Serialize the store back to the same dialect — every value double-quoted and
// escaped so it round-trips through parseDotEnvValue — and write it with 0600
// perms (0700 dir). The file is command-owned, so it is rewritten canonically
// (default first, then sorted sections, fixed key order); user comments are not
// preserved (edit a project `.env` for hand-managed notes).
/** @param {{ defaultNs?: string | null, namespaces?: Record<string, Record<string, string>> }} store */
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
  mkdirSync(path.dirname(storePath), { recursive: true, mode: 0o700 });
  // Tighten an existing file to 0600 BEFORE writing token bytes: writeFileSync's
  // mode only applies when it creates the file, so without this a pre-existing
  // permissive (e.g. 0644) credentials file would receive the secret while still
  // world-readable, with a window until a post-write chmod. A non-ENOENT failure
  // aborts before the token is written.
  try {
    chmodSync(storePath, 0o600);
  } catch (err) {
    if (!err || err.code !== "ENOENT") throw err;
  }
  writeFileSync(storePath, lines.join("\n"), { mode: 0o600 });
}
