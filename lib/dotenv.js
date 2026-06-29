// The dotenv/INI dialect WDL uses for project .env files and the token
// store: [section] parsing and double-quote (un)escaping. CLI_DOTENV_KEYS
// limits which keys load; WRANGLER_SCRUB_KEYS is the wrangler child-env
// denylist (superset incl. the legacy ADMIN_URL).

import { CliError } from "./common.js";

export const CLI_DOTENV_KEYS = new Set([
  "ADMIN_TOKEN",
  "CONTROL_CONNECT_HOST",
  "CONTROL_URL",
  "WDL_NS",
]);

// Keys deleted from the Wrangler child env (lib/wrangler/command.js) so WDL
// control-plane config in the env never reaches the bundler or the build scripts
// Wrangler runs. This is the env path only, not a sandbox: build code running as
// the same OS user can still read the on-disk token store (see docs/token.md). A
// superset of CLI_DOTENV_KEYS that also strips the legacy ADMIN_URL alias: it is
// no longer READ for config, but a user may still have it exported, and dropping
// an alias as an input must not turn it into a leak.
export const WRANGLER_SCRUB_KEYS = new Set([...CLI_DOTENV_KEYS, "ADMIN_URL"]);

/**
 * @param {string} line
 * @param {number} lineNumber
 */
export function parseDotEnvSection(line, lineNumber) {
  if (!line.startsWith("[")) return null;
  const match = line.match(/^\[([^\]]*)\]\s*(?:#.*)?$/);
  if (!match) {
    throw new CliError(`Invalid .env line ${lineNumber}: invalid section header`);
  }
  return match[1].trim();
}


/** @param {string} value */
export function parseDotEnvValue(value) {
  if (!value) return "";
  const quote = value[0];
  if (quote === "\"" || quote === "'") {
    const end = findClosingQuote(value, quote);
    if (end === -1) {
      throw new CliError("Invalid .env value: missing closing quote");
    }
    const rest = value.slice(end + 1).trim();
    if (rest && !rest.startsWith("#")) {
      throw new CliError("Invalid .env value: unexpected text after quoted value");
    }

    const inner = value.slice(1, end);
    if (quote === "'") return inner;
    return unescapeDoubleQuoted(inner);
  }
  return value.replace(/\s+#.*$/, "");
}

// Serialize a value into the double-quoted dialect — the inverse of
// parseDotEnvValue / unescapeDoubleQuoted, kept beside them so the round-trip
// invariant stays in one place. Backslash is escaped first so a value with
// quotes / newlines / tabs survives a read→write→read round trip. Used by the
// token store writer (a project `.env` is only ever read, never written).
/** @param {unknown} value */
export function quoteValue(value) {
  const escaped = String(value)
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")
    .replaceAll("\t", "\\t");
  return `"${escaped}"`;
}

// Single-pass unescape for the double-quoted dialect. A left-to-right scan is
// required: chaining replaceAll("\\n", "\n") before replaceAll("\\\\", "\\")
// would turn an escaped backslash followed by a literal "n" (stored as "\\n")
// into a newline, corrupting any value that legitimately contains a backslash
// (e.g. a token). The inverse of quoteValue above.
/** @param {string} s */
function unescapeDoubleQuoted(s) {
  let out = "";
  for (let i = 0; i < s.length; i += 1) {
    if (s[i] === "\\" && i + 1 < s.length) {
      const next = s[i + 1];
      i += 1;
      if (next === "n") out += "\n";
      else if (next === "r") out += "\r";
      else if (next === "t") out += "\t";
      else if (next === "\"") out += "\"";
      else if (next === "\\") out += "\\";
      else out += "\\" + next; // preserve unknown escapes verbatim
    } else {
      out += s[i];
    }
  }
  return out;
}

/**
 * @param {string} value
 * @param {string} quote
 */
function findClosingQuote(value, quote) {
  for (let i = 1; i < value.length; i += 1) {
    if (value[i] !== quote) continue;
    if (quote === "\"" && isEscaped(value, i)) continue;
    return i;
  }
  return -1;
}

/**
 * @param {string} value
 * @param {number} idx
 */
function isEscaped(value, idx) {
  let count = 0;
  for (let i = idx - 1; i >= 0 && value[i] === "\\"; i -= 1) count += 1;
  return count % 2 === 1;
}
