import { realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { escapeTerminalText } from "./output.js";



export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

// The project's "set" predicate: a value is set only when it is a non-empty
// string; "" or a non-string (undefined, a missing/boolean flag) counts as
// absent. Centralized so the rule can't drift between its callers.
export function isNonEmptyString(value) {
  return typeof value === "string" && value.length > 0;
}

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

export function commonCliOptions({ namespace = true, controlUrl = true, token = true, json = false, help = true } = {}) {
  return optionHelp(commonCliOptionSpecs({ namespace, controlUrl, token, json, help }));
}

export function commonCliOptionSpecs({ namespace = true, controlUrl = true, token = true, json = false, help = true } = {}) {
  const specs = [];
  if (namespace) specs.push(OPTION_DEFS.ns);
  if (controlUrl) specs.push(OPTION_DEFS.controlUrl);
  if (token) specs.push(OPTION_DEFS.token);
  if (json) specs.push(OPTION_DEFS.json);
  if (help) specs.push(OPTION_DEFS.help);
  return specs;
}

const OPTION_HELP_WIDTH = 21;

export function formatOption(flag, description) {
  return `${flag}${" ".repeat(Math.max(1, OPTION_HELP_WIDTH - flag.length))}${description}`;
}

export function defineCliOption(name, parseConfig, flag, description) {
  return {
    parseOptions: { [name]: parseConfig },
    help: flag ? formatOption(flag, description) : null,
  };
}

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
  help: defineCliOption("help", { type: "boolean", short: "h" }, "-h, --help", "Show this help."),
};

const CLI_OPTION_PRESETS = {
  ns: [OPTION_DEFS.ns],
  env: [OPTION_DEFS.env],
  control: [OPTION_DEFS.controlUrl, OPTION_DEFS.token],
  // Control-plane endpoint flags without --token, for commands that read the
  // token elsewhere (e.g. `wdl token set` reads it from stdin).
  endpoint: [OPTION_DEFS.controlUrl],
  json: [OPTION_DEFS.json],
  yes: [OPTION_DEFS.yes],
  help: [OPTION_DEFS.help],
};

/** @returns {import("node:util").ParseArgsOptionsConfig} */
export function optionParseOptions(options) {
  /** @type {import("node:util").ParseArgsOptionsConfig} */
  const out = {};
  for (const item of options) {
    if (typeof item === "string") {
      const specs = CLI_OPTION_PRESETS[item];
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

export function optionHelp(options) {
  const lines = [];
  for (const item of options) {
    if (typeof item === "string") {
      const specs = CLI_OPTION_PRESETS[item];
      if (!specs) throw new Error(`unknown option preset "${item}"`);
      lines.push(...optionHelp(specs));
      continue;
    }
    if (!isCliOptionSpec(item)) throw new Error("help option entries must be preset names or option specs");
    if (item.help) lines.push(item.help);
  }
  return lines;
}

function isCliOptionSpec(item) {
  return Boolean(item && typeof item === "object" && Object.hasOwn(item, "parseOptions"));
}

export function handleCliError(err) {
  if (err instanceof CliError) {
    console.error(`error: ${err.message}`);
    process.exit(err.exitCode);
  }
  if (isParseArgsError(err)) {
    console.error(`error: ${err.message}`);
    process.exit(1);
  }
  throw err;
}

export async function runCliMain(run, argv = process.argv.slice(2)) {
  try {
    await run(argv);
  } catch (err) {
    handleCliError(err);
  }
}

export function printHelpIfRequested(requested, usageText, stdout = (line) => console.log(line)) {
  if (!requested) return false;
  stdout(typeof usageText === "function" ? usageText() : usageText);
  return true;
}

function isParseArgsError(err) {
  return err && typeof err.code === "string" && err.code.startsWith("ERR_PARSE_ARGS_");
}

export async function readJsonOrFail(res, label) {
  await throwHttpErrorIfNotOk(res, label);
  return await res.json();
}

export async function throwHttpErrorIfNotOk(res, label) {
  if (res.ok) return;
  throw new CliError(`${label} failed: ${formatHttpError(res.status, await res.text())}`);
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
  "warnings",
]);

function formatHttpError(status, text) {
  const raw = typeof text === "string" ? text.trim() : "";
  if (!raw) return String(status);

  let body;
  try {
    body = JSON.parse(raw);
  } catch {
    return `${status} ${escapeTerminalText(raw)}`;
  }

  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return `${status} ${escapeTerminalText(raw)}`;
  }

  const error = escapeTerminalText(scalarString(body.error));
  const message = escapeTerminalText(scalarString(body.message));
  const parts = [String(status)];

  let summary = error || message || "";
  if (summary) {
    if (message && message !== summary && message !== error) {
      summary += `: ${message}`;
    }
    parts.push(summary);
  } else {
    return `${status} ${escapeTerminalText(raw)}`;
  }

  const context = [];
  for (const [key, value] of Object.entries(body)) {
    if (ERROR_SUMMARY_KEYS.has(key)) continue;
    if (value == null) continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      context.push(`${key}=${formatContextValue(value)}`);
      continue;
    }
    if (ARRAY_CONTEXT_KEYS.has(key) && Array.isArray(value) && value.length > 0) {
      // JSON.stringify escapes C0 controls but leaves C1 bytes raw.
      context.push(`${key}=${escapeTerminalText(JSON.stringify(value))}`);
    }
  }
  if (context.length > 0) parts.push(context.join(" "));
  return parts.join(" ");
}

function scalarString(value) {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function formatContextValue(value) {
  if (typeof value !== "string") return String(value);
  const escaped = escapeTerminalText(value);
  if (escaped === "" || /\s/.test(escaped)) return JSON.stringify(escaped);
  return escaped;
}

export function encodePath(segment) {
  return encodeURIComponent(segment);
}

// True when `target` is `root` or lives inside it. Bare startsWith("..") would
// also reject siblings like "..hidden", so check the exact ".." and the
// "../" prefix. Shared by the d1 migrations-dir and --file containment checks.
export function isPathInside(root, target) {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

export function isMain(importMetaUrl, argv = process.argv) {
  if (!argv[1]) return false;
  try {
    return realpathSync(fileURLToPath(importMetaUrl)) === realpathSync(argv[1]);
  } catch {
    return false;
  }
}
