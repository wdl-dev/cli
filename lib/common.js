import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { escapeTerminalText, formatDiagnosticValue } from "./output.js";

export class CliError extends Error {
  /**
   * @param {string} message
   * @param {number} [exitCode]
   */
  constructor(message, exitCode = 1) {
    super(message);
    /** @type {number} */
    this.exitCode = exitCode;
  }
}

/**
 * @param {string} label
 * @param {unknown} arg
 * @returns {CliError}
 */
export function unexpectedArgument(label, arg) {
  return new CliError(`${escapeTerminalText(label)} received unexpected argument: ${escapeTerminalText(arg)}`);
}

// The project's "set" predicate: a value is set only when it is a non-empty
// string; "" or a non-string (undefined, a missing/boolean flag) counts as
// absent. Centralized so the rule can't drift between its callers.
/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

/**
 * @param {{ usage: string[], description?: string, commands?: string[], options?: string[] }} spec
 */
export function formatHelp({ usage, description, commands = [], options = [] }) {
  const lines = ["Usage:"];
  for (const line of usage) lines.push(`  ${line}`);

  if (description) {
    lines.push("", "Description:", `  ${description}`);
  }

  if (commands.length > 0) {
    lines.push("", "Commands:");
    for (const line of commands) lines.push(`  ${line}`);
  }

  if (options.length > 0) {
    lines.push("", "Options:");
    for (const line of options) lines.push(`  ${line}`);
  }

  return lines.join("\n");
}

/**
 * A single parsed CLI option spec: its parseArgs config plus the help line.
 * @typedef {object} CliOptionSpec
 * @property {import("node:util").ParseArgsOptionsConfig} parseOptions
 * @property {string | null} help
 */

/**
 * An entry in an `options` list: either a preset name or an option spec.
 * @typedef {string | CliOptionSpec} OptionListItem
 */

/**
 * @param {{ namespace?: boolean, controlUrl?: boolean, token?: boolean, noTokenStore?: boolean, json?: boolean, help?: boolean }} [options]
 */
export function commonCliOptions({ namespace = true, controlUrl = true, token = true, noTokenStore = true, json = false, help = true } = {}) {
  return optionHelp(commonCliOptionSpecs({ namespace, controlUrl, token, noTokenStore, json, help }));
}

/**
 * @param {{ namespace?: boolean, controlUrl?: boolean, token?: boolean, noTokenStore?: boolean, json?: boolean, help?: boolean }} [options]
 */
export function commonCliOptionSpecs({ namespace = true, controlUrl = true, token = true, noTokenStore = true, json = false, help = true } = {}) {
  const specs = [];
  if (namespace) specs.push(OPTION_DEFS.ns);
  if (controlUrl) specs.push(OPTION_DEFS.controlUrl);
  if (token) specs.push(OPTION_DEFS.token);
  if (noTokenStore) specs.push(OPTION_DEFS.noTokenStore);
  if (json) specs.push(OPTION_DEFS.json);
  if (help) specs.push(OPTION_DEFS.help);
  return specs;
}

const OPTION_HELP_WIDTH = 21;

/**
 * @param {string} flag
 * @param {string | null} description
 */
export function formatOption(flag, description) {
  return `${flag}${" ".repeat(Math.max(1, OPTION_HELP_WIDTH - flag.length))}${description}`;
}

/**
 * @param {string} name
 * @param {import("node:util").ParseArgsOptionsConfig[string]} parseConfig
 * @param {string | null} flag
 * @param {string | null} description
 * @returns {CliOptionSpec}
 */
export function defineCliOption(name, parseConfig, flag, description) {
  return {
    parseOptions: { [name]: parseConfig },
    help: flag ? formatOption(flag, description) : null,
  };
}

/**
 * @param {string} name
 * @param {import("node:util").ParseArgsOptionsConfig[string]} parseConfig
 * @returns {CliOptionSpec}
 */
export function defineHiddenCliOption(name, parseConfig) {
  return defineCliOption(name, parseConfig, null, null);
}

const OPTION_DEFS = {
  ns: defineCliOption("ns", { type: "string" }, "--ns <ns>", "Namespace (env: WDL_NS)."),
  env: defineCliOption("env", { type: "string" }, "--env <name>", "Wrangler environment (env: CLOUDFLARE_ENV)."),
  controlUrl: defineCliOption("control-url", { type: "string" }, "--control-url <url>", "Control URL (env: CONTROL_URL)."),
  token: defineCliOption("token", { type: "string" }, "--token <tok>", "Admin token (env: ADMIN_TOKEN)."),
  json: defineCliOption("json", { type: "boolean" }, "--json", "Print the raw control response."),
  yes: defineCliOption("yes", { type: "boolean" }, "--yes", "Confirm destructive actions."),
  noTokenStore: defineCliOption("no-token-store", { type: "boolean" }, "--no-token-store", "Ignore the global token store; resolve credentials from flag/env/.env only (env: WDL_TOKEN_STORE=off)."),
  help: defineCliOption("help", { type: "boolean", short: "h" }, "-h, --help", "Show this help."),
};

const CLI_OPTION_PRESETS = {
  ns: [OPTION_DEFS.ns],
  env: [OPTION_DEFS.env],
  control: [OPTION_DEFS.controlUrl, OPTION_DEFS.token, OPTION_DEFS.noTokenStore],
  // Control-plane endpoint flags without --token, for commands that read the
  // token elsewhere (e.g. `wdl token set` reads it from stdin).
  endpoint: [OPTION_DEFS.controlUrl],
  json: [OPTION_DEFS.json],
  yes: [OPTION_DEFS.yes],
  help: [OPTION_DEFS.help],
};

/**
 * @param {Iterable<OptionListItem>} options
 * @returns {import("node:util").ParseArgsOptionsConfig}
 */
export function optionParseOptions(options) {
  /** @type {import("node:util").ParseArgsOptionsConfig} */
  const out = {};
  for (const item of options) {
    if (typeof item === "string") {
      const specs = presetSpecs(item);
      if (!specs) throw new Error(`unknown option preset "${item}"`);
      Object.assign(out, optionParseOptions(specs));
      continue;
    }
    if (isCliOptionSpec(item)) {
      Object.assign(out, item.parseOptions);
      continue;
    }
    throw new Error("option entries must be preset names or option specs");
  }
  return out;
}

/**
 * @param {Iterable<OptionListItem>} options
 * @returns {string[]}
 */
export function optionHelp(options) {
  /** @type {string[]} */
  const lines = [];
  for (const item of options) {
    if (typeof item === "string") {
      const specs = presetSpecs(item);
      if (!specs) throw new Error(`unknown option preset "${item}"`);
      lines.push(...optionHelp(specs));
      continue;
    }
    if (!isCliOptionSpec(item)) throw new Error("help option entries must be preset names or option specs");
    if (item.help) lines.push(item.help);
  }
  return lines;
}

/**
 * @param {string} name
 * @returns {CliOptionSpec[] | undefined}
 */
function presetSpecs(name) {
  return Object.hasOwn(CLI_OPTION_PRESETS, name)
    ? CLI_OPTION_PRESETS[/** @type {keyof typeof CLI_OPTION_PRESETS} */ (name)]
    : undefined;
}

/**
 * @param {unknown} item
 * @returns {item is CliOptionSpec}
 */
function isCliOptionSpec(item) {
  return Boolean(item && typeof item === "object" && Object.hasOwn(item, "parseOptions"));
}

/**
 * Narrow an unknown caught value to an error carrying a string `code`
 * (e.g. Node fs errors with `code === "ENOENT"`).
 * @param {unknown} err
 * @returns {err is { code: string }}
 */
export function hasErrorCode(err) {
  return Boolean(err) && typeof err === "object" && typeof (/** @type {{ code?: unknown }} */ (err)).code === "string";
}

/** @param {unknown} err */
export function handleCliError(err) {
  if (err instanceof CliError) {
    console.error(`error: ${err.message}`);
    process.exit(err.exitCode);
  }
  if (isParseArgsError(err)) {
    console.error(`error: ${escapeTerminalText(err.message)}`);
    process.exit(1);
  }
  throw err;
}

/**
 * @param {(argv: string[]) => Promise<unknown> | unknown} run
 * @param {string[]} [argv]
 */
export async function runCliMain(run, argv = process.argv.slice(2)) {
  try {
    await run(argv);
  } catch (err) {
    handleCliError(err);
  }
}

/**
 * @param {unknown} requested
 * @param {string | (() => string)} usageText
 * @param {(line: string) => void} [stdout]
 */
export function printHelpIfRequested(requested, usageText, stdout = (line) => console.log(line)) {
  if (!requested) return false;
  stdout(typeof usageText === "function" ? usageText() : usageText);
  return true;
}

/**
 * @param {unknown} err
 * @returns {err is Error & { code: string }}
 */
function isParseArgsError(err) {
  return Boolean(err) && typeof (/** @type {{ code?: unknown }} */ (err)).code === "string" &&
    /** @type {{ code: string }} */ (err).code.startsWith("ERR_PARSE_ARGS_");
}

/**
 * @param {import("./control-fetch.js").ControlJsonResponse} res
 * @param {string} label
 * @returns {Promise<unknown>}
 */
export async function readJsonOrFail(res, label) {
  await throwHttpErrorIfNotOk(res, label);
  // A 2xx response always carries a json reader.
  if (typeof res.json !== "function") throw new CliError(`${label} failed: response is not JSON`);
  try {
    return await res.json();
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    throw new CliError(`${label} failed: response is not valid JSON: ${escapeTerminalText(message)}`);
  }
}

/**
 * @param {import("./control-fetch.js").ControlResponseStatus} res
 * @param {string} label
 */
export async function throwHttpErrorIfNotOk(res, label) {
  if (res.ok) return;
  throw new CliError(`${label} failed: ${formatHttpError(res.status, await res.text(), res.headers)}`);
}

const ERROR_SUMMARY_KEYS = new Set([
  "error",
  "message",
  "detail",
  "details",
  "stack",
]);

const ARRAY_CONTEXT_KEYS = new Set([
  "blockers",
  "referrers",
  "reserved_modules",
  "warnings",
]);

/**
 * @param {number | undefined} status
 * @param {unknown} text
 * @param {import("node:http").IncomingHttpHeaders} [headers]
 */
export function formatHttpError(status, text, headers = {}) {
  const raw = typeof text === "string" ? text.trim() : "";
  const location = redirectLocation(status, headers);
  if (!raw) return appendLocationContext(String(status), location);

  /** @type {unknown} */
  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return appendLocationContext(`${status} ${escapeTerminalText(raw)}`, location);
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return appendLocationContext(`${status} ${escapeTerminalText(raw)}`, location);
  }

  const record = /** @type {Record<string, unknown>} */ (body);
  const error = escapeTerminalText(scalarString(record.error));
  const message = escapeTerminalText(scalarString(record.message));
  const parts = [String(status)];

  let summary = error || message || "";
  if (summary) {
    if (message && message !== summary && message !== error) {
      summary += `: ${message}`;
    }
    parts.push(summary);
  } else {
    return appendLocationContext(`${status} ${escapeTerminalText(raw)}`, location);
  }

  /** @type {string[]} */
  const context = [];
  if (location) context.push(`location=${formatContextValue(location)}`);
  for (const [key, value] of Object.entries(record)) {
    if (ERROR_SUMMARY_KEYS.has(key)) continue;
    if (value == null) continue;
    const safeKey = escapeTerminalText(key);
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      context.push(`${safeKey}=${formatContextValue(value)}`);
      continue;
    }
    if (ARRAY_CONTEXT_KEYS.has(key) && Array.isArray(value) && value.length > 0) {
      context.push(`${safeKey}=${formatDiagnosticValue(value)}`);
    }
  }
  if (context.length > 0) parts.push(context.join(" "));
  return parts.join(" ");
}

/**
 * @param {number | undefined} status
 * @param {import("node:http").IncomingHttpHeaders} headers
 */
function redirectLocation(status, headers) {
  if (status == null || status < 300 || status >= 400) return "";
  const value = headers.location;
  return Array.isArray(value) ? value[0] || "" : value || "";
}

/**
 * @param {string} message
 * @param {string} location
 */
function appendLocationContext(message, location) {
  return location ? `${message} location=${formatContextValue(location)}` : message;
}

/** @param {unknown} value */
function scalarString(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

/** @param {string | number | boolean} value */
function formatContextValue(value) {
  if (typeof value !== "string") return String(value);
  const escaped = escapeTerminalText(value);
  if (escaped === "" || /\s/.test(escaped)) return JSON.stringify(escaped);
  return escaped;
}

/** @param {string} segment */
export function encodePath(segment) {
  const text = String(segment);
  if (text === "" || text === "." || text === "..") {
    throw new CliError(`invalid URL path segment: ${JSON.stringify(text)}`);
  }
  return encodeURIComponent(text);
}

// True when `target` is `root` or lives inside it. Bare startsWith("..") would
// also reject siblings like "..hidden", so check the exact ".." and the
// "../" prefix. Shared by the d1 migrations-dir and --file containment checks.
/**
 * @param {string} root
 * @param {string} target
 */
export function isPathInside(root, target) {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

/**
 * @param {string} importMetaUrl
 * @param {string[]} [argv]
 */
export function isMain(importMetaUrl, argv = process.argv) {
  if (!argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv[1]);
  } catch {
    return false;
  }
}
