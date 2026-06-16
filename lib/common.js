import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isAdminAcceptableNs } from "./ns-pattern.js";

// Control-plane endpoint keys: where the admin token gets sent. A cwd .env
// must not redirect these for a token that came from the shell/--token.
const CONTROL_ENDPOINT_KEYS = ["CONTROL_URL", "CONTROL_CONNECT_HOST"];

export const CLI_DOTENV_KEYS = new Set([
  "ADMIN_TOKEN",
  "CONTROL_CONNECT_HOST",
  "CONTROL_URL",
  "WDL_NS",
]);

// Keys deleted from the Wrangler child env (lib/wrangler/command.js) so WDL
// control-plane config never reaches the bundler or the build scripts Wrangler
// runs. A superset of CLI_DOTENV_KEYS that also strips the legacy ADMIN_URL
// alias: it is no longer READ for config, but a user may still have it
// exported, and dropping an alias as an input must not turn it into a leak.
export const WRANGLER_SCRUB_KEYS = new Set([...CLI_DOTENV_KEYS, "ADMIN_URL"]);

export class CliError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
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

export function resolveControlUrl(values, env = process.env) {
  const raw = values["control-url"] || env.CONTROL_URL;
  // No built-in default: a fallback host would silently receive the admin
  // token whenever a self-hosted user forgets to configure their endpoint.
  if (!raw) {
    throw new CliError(
      "No control URL configured. Set CONTROL_URL (e.g. in ./.env), or pass --control-url."
    );
  }
  const text = String(raw).trim();
  const withScheme = /^[a-z][a-z\d+.-]*:\/\//i.test(text)
    ? text
    : `${defaultSchemeForBareControlUrl(text)}://${text}`;
  const normalized = withScheme.replace(/\/+$/, "");
  let parsed;
  try {
    parsed = new URL(normalized);
  } catch {
    throw new CliError(`Invalid control URL ${JSON.stringify(raw)}.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError(`Invalid control URL ${JSON.stringify(raw)}: expected http:// or https://.`);
  }
  return normalized;
}

function defaultSchemeForBareControlUrl(text) {
  const hostPort = text.split("/")[0] || text;
  let host = hostPort;
  let port = null;
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPort);
  if (bracketed) {
    host = bracketed[1];
    port = bracketed[2] || null;
  } else {
    const hostWithPort = /^([^:]+):(\d+)$/.exec(hostPort);
    if (hostWithPort) {
      host = hostWithPort[1];
      port = hostWithPort[2];
    }
  }
  if (isLocalDevHost(host) || port === "8080") {
    return "http";
  }
  return "https";
}

export function resolveControlContext(values, env = process.env) {
  const token = values.token || env.ADMIN_TOKEN;
  if (!token) {
    throw new CliError("Missing admin token. Run 'wdl token set --ns <ns> --control-url <url>' (recommended), pass --token <tok>, or set ADMIN_TOKEN.");
  }
  return {
    controlUrl: resolveControlUrl(values, env),
    token,
    headers: { "x-admin-token": token },
  };
}

// Single emission point for the plaintext-token warning so every path that
// builds an x-admin-token header (defineCommand resolveControl, whoami,
// doctor) reports the same way. `warn` receives one line WITHOUT a trailing
// newline — the default console.error is line-buffered everywhere, unlike
// the per-command stderr sinks whose newline conventions differ.
export function warnIfInsecureControlUrl(controlUrl, warn = (line) => console.error(line)) {
  if (!isInsecureControlUrl(controlUrl)) return;
  warn(`warning: control URL ${controlUrl} is plain http on a non-local host; the admin token will be sent unencrypted`);
}

// True when the admin token would travel unencrypted to a host that doesn't
// look like a local/dev target.
function isInsecureControlUrl(controlUrl) {
  let parsed;
  try {
    parsed = new URL(controlUrl);
  } catch {
    return false;
  }
  return parsed.protocol === "http:" && !isLocalDevHost(parsed.hostname);
}

// Loopback / dev-TLD hosts, shared by the bare-URL scheme default and the
// plaintext-token warning so the two policies cannot drift. Accepts both the
// bare IPv6 form and the bracketed form URL.hostname produces.
function isLocalDevHost(host) {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".test") ||
    host.endsWith(".local")
  );
}

export function resolveNamespace(values, env = process.env) {
  return firstNonEmptyString(values.ns, env.WDL_NS);
}

function firstNonEmptyString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

// A CLI flag counts as "set" only when it holds a non-empty string: an empty
// `--token ""` (or a boolean/missing flag) falls back to env, and the
// cross-origin guard / store gap-fill must tell "flag supplied" from "present
// but empty".
export function flagSet(values, name) {
  return typeof values[name] === "string" && values[name].length > 0;
}

// Shell/CI env wins over `.env`, but only when actually set. A value that is not
// a non-empty string (e.g. WDL_NS="" in CI, or undefined on an injected env
// object) counts as absent everywhere else here — like firstNonEmptyString and
// flagSet — so it must not "protect" its key: protecting an unset value would
// block the `.env` value AND then let it fall through to a lower-precedence store
// default, inverting the `.env` > store-default order.
export function protectedEnvKeys(env) {
  return new Set(Object.keys(env).filter((key) => typeof env[key] === "string" && env[key] !== ""));
}

export function loadCliDotEnv(
  env = process.env,
  path = ".env",
  options = {}
) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (err && err.code === "ENOENT") return [];
    throw err;
  }

  const {
    resolvedNs,
    loadBase = true,
    protectedKeys = protectedEnvKeys(env),
    warn = (message) => console.warn(`warning: ${message}`),
    onLoad = null,
  } = options;
  const selectedSection = firstNonEmptyString(resolvedNs);
  const loaded = [];
  let section = null;
  for (const [idx, rawLine] of text.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const nextSection = parseDotEnvSection(line, idx + 1);
    if (nextSection !== null) {
      section = nextSection;
      if (!isAdminAcceptableNs(section)) {
        throw new CliError(`Invalid .env line ${idx + 1}: invalid section name "${section}"`);
      }
      continue;
    }

    const body = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) {
      throw new CliError(`Invalid .env line ${idx + 1}: expected KEY=value`);
    }

    const key = body.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new CliError(`Invalid .env line ${idx + 1}: invalid key "${key}"`);
    }
    if (!CLI_DOTENV_KEYS.has(key)) continue;
    const shouldLoad = section === null
      ? loadBase
      : section === selectedSection;
    if (!shouldLoad) continue;
    if (section !== null && key === "WDL_NS") {
      warn(`Ignoring WDL_NS in .env section [${section}]`);
      continue;
    }
    if (protectedKeys.has(key)) continue;

    const value = parseDotEnvValue(body.slice(eq + 1).trim());
    env[key] = value;
    loaded.push(key);
    if (onLoad) onLoad({ key, value, section, line: idx + 1 });
  }
  return loaded;
}

// Two-phase .env load (base, then [resolved-ns] overlay) plus a cross-origin
// guard, shared by the bin dispatcher and config-state so both apply the same
// trust model. Returns the set of keys actually loaded from .env.
/**
 * @param {NodeJS.ProcessEnv} env
 * @param {{
 *   dotenvPath?: string,
 *   nsFromFlag?: string,
 *   tokenFromFlag?: boolean,
 *   controlUrlFromFlag?: boolean,
 *   protectedKeys?: Set<string>,
 *   loadEnv?: typeof loadCliDotEnv,
 *   readStore?: (env: NodeJS.ProcessEnv) => { defaultNs?: string | null, namespaces?: Record<string, Record<string, string>> },
 *   warn?: (message: string) => void,
 *   onCrossOrigin?: (line: string) => void,
 *   onLoad?: (entry: { key: string, value: string, section: string | null, line: number, origin?: "store" | "store-default" }) => void,
 * }} [options]
 */
export function loadCliControlEnv(env, {
  dotenvPath,
  nsFromFlag,
  tokenFromFlag = false,
  controlUrlFromFlag = false,
  protectedKeys = protectedEnvKeys(env),
  loadEnv = loadCliDotEnv,
  readStore = () => ({}),
  warn,
  onCrossOrigin = (line) => console.error(line),
  onLoad,
} = {}) {
  const loaded = new Set();
  // loadCliDotEnv returns the loaded keys; a test-injected loader may return
  // something else, so guard the type rather than assume an array.
  const record = (result) => {
    if (Array.isArray(result)) for (const key of result) loaded.add(key);
  };
  record(loadEnv(env, dotenvPath, { protectedKeys, onLoad, warn }));

  // The global store is the lowest-precedence, optional layer, so read it
  // lazily — only when it can actually contribute. Reading it eagerly would let
  // a corrupt or unreadable ~/.config/wdl/credentials abort a command whose
  // namespace and credentials already came from flags / shell / .env, with no
  // way to work around it. Memoize so the at-most-one read is shared.
  let storeData;
  const getStore = () => (storeData ??= (readStore(env) || {}));

  let ns = firstNonEmptyString(nsFromFlag, env.WDL_NS);
  // The store's base WDL_NS names a default namespace — the lowest-precedence
  // source for *which* namespace to use, below --ns and shell/.env WDL_NS, and
  // only when that default actually has a stored entry. Materialize it into env
  // so the rest of the pipeline (control-URL resolution, the [ns] overlay,
  // resolveNamespace in callers) sees the same namespace an explicit one would.
  if (!ns) {
    // The default namespace is the lowest-precedence, OPTIONAL namespace source,
    // so a corrupt/unreadable store must not block a command that needs no
    // namespace (e.g. `wdl whoami --control-url … --token …`, which gets it from
    // /whoami). Tolerate a read failure here as "no default"; the gap-fill read
    // below stays strict, so a store that is the actual credential source still
    // surfaces its corruption.
    let s;
    try {
      s = getStore();
    } catch {
      // corrupt/unreadable store → no usable default; do not block the command
    }
    const namespaces = (s && s.namespaces) || {};
    const def = s && typeof s.defaultNs === "string" ? s.defaultNs : null;
    if (def && Object.hasOwn(namespaces, def)) {
      ns = def;
      if (env.WDL_NS == null || env.WDL_NS === "") {
        env.WDL_NS = ns;
        if (onLoad) onLoad({ key: "WDL_NS", value: ns, section: ns, line: 0, origin: "store-default" });
      }
    }
  }

  if (ns) {
    record(loadEnv(env, dotenvPath, { resolvedNs: ns, loadBase: false, protectedKeys, onLoad, warn }));
  }
  // Drop untrusted project-.env endpoints BEFORE filling from the global store,
  // so a dropped endpoint's slot is filled by the trusted store rather than
  // staying shadowed by what the guard just removed.
  guardCrossOriginControlEnv(env, loaded, tokenFromFlag, onCrossOrigin);
  // The store is trusted (you wrote it via `wdl token`, token + endpoint
  // same-source) and not itself subject to the cross-origin guard, so it fills
  // the gaps left by flags / shell / project .env / the guard — but only for a
  // slot still empty AND not supplied by a flag (resolved later). That keeps
  // the store unread when the credentials are already covered.
  if (ns) {
    const covered = { CONTROL_URL: controlUrlFromFlag, ADMIN_TOKEN: tokenFromFlag };
    const needsFill = STORE_ENV_KEYS.some((k) => !covered[k] && (env[k] == null || env[k] === ""));
    if (needsFill) fillFromTokenStore(env, ns, getStore().namespaces || {}, onLoad, covered);
  }
}

// Only the control-plane endpoint and token are materialized into env from a
// store section; LABEL is store-only metadata for `wdl token list`.
const STORE_ENV_KEYS = ["CONTROL_URL", "ADMIN_TOKEN"];

/** @param {Record<string, boolean>} [covered] */
function fillFromTokenStore(env, ns, namespaces, onLoad, covered = {}) {
  // hasOwn, not namespaces[ns]: a namespace named like an Object.prototype key
  // (e.g. "constructor") must not resolve to an inherited member.
  if (!Object.hasOwn(namespaces, ns)) return;
  const entry = namespaces[ns];
  for (const key of STORE_ENV_KEYS) {
    // A flag supplies this slot (resolved later); don't shadow it in env with
    // the store value, which would mislead anyone reading env[key] directly.
    if (covered[key]) continue;
    const value = entry[key];
    if (value == null || value === "") continue;
    if (env[key] != null && env[key] !== "") continue; // gap-fill only
    env[key] = value;
    if (onLoad) onLoad({ key, value, section: ns, line: 0, origin: "store" });
  }
}

// A control endpoint from a cwd .env is only trusted when the EFFECTIVE token
// came from the same .env. The effective token is `values.token || ADMIN_TOKEN`
// (resolveControlContext), so a `--token` flag overrides env: a .env-supplied
// token (even a decoy) is then NOT the credential in use, and the .env endpoint
// must be treated as cross-origin. Otherwise an untrusted project directory
// could redirect a shell/--token credential to a host it chose — so drop the
// .env endpoint (resolution falls back to shell/default) and warn. Same-source
// .env (token + URL together, single-tenant) and shell-sourced URLs are fine.
function guardCrossOriginControlEnv(env, loadedFromDotenv, tokenFromFlag, onCrossOrigin) {
  // A NON-EMPTY .env token, not merely a loaded `ADMIN_TOKEN=` key: an empty
  // placeholder would otherwise mark the .env endpoint same-source while the
  // real token gets gap-filled from the global store afterwards — letting an
  // untrusted .env redirect a STORED token to a host it chose.
  const tokenIsFromDotenv =
    loadedFromDotenv.has("ADMIN_TOKEN") &&
    typeof env.ADMIN_TOKEN === "string" && env.ADMIN_TOKEN.length > 0 &&
    !tokenFromFlag;
  if (tokenIsFromDotenv) return;
  for (const key of CONTROL_ENDPOINT_KEYS) {
    if (!loadedFromDotenv.has(key)) continue;
    delete env[key];
    onCrossOrigin(
      `warning: ignoring ${key} from .env — it would send a token from your shell or --token ` +
      `to a host chosen by this directory's .env. Set ${key} in your shell/CI env, pass ` +
      `--control-url, or put ADMIN_TOKEN in the same .env.`
    );
  }
}

export function parseDotEnvSection(line, lineNumber) {
  if (!line.startsWith("[")) return null;
  const match = line.match(/^\[([^\]]*)\]\s*(?:#.*)?$/);
  if (!match) {
    throw new CliError(`Invalid .env line ${lineNumber}: invalid section header`);
  }
  return match[1].trim();
}

/**
 * @param {{
 *   yes?: boolean,
 *   stdin?: { isTTY?: boolean, setEncoding: (encoding: string) => void, on: Function, off: Function, pause?: Function },
 *   stderr?: (text: string) => void,
 *   prompt?: string,
 *   action?: string,
 * }} [options]
 */
export async function confirmAction({
  yes = false,
  stdin = process.stdin,
  stderr = (text) => process.stderr.write(text),
  prompt,
  action = "continue",
} = {}) {
  if (yes) return;
  if (!stdin.isTTY) {
    throw new CliError(`Refusing to ${escapeTerminalText(action)} without interactive confirmation. Pass --yes to confirm.`);
  }

  const answer = await readTtyLine(stdin, { prompt, stderr });
  if (/^(y|yes)$/i.test(answer.trim())) return;
  throw new CliError("Aborted.");
}

/**
 * @param {{ isTTY?: boolean, setEncoding: (encoding: string) => void, setRawMode?: (mode: boolean) => void, on: Function, off: Function, pause?: Function }} stdin
 * @param {{ prompt?: string, stderr?: (text: string) => void, hidden?: boolean }} [options]
 */
export function readTtyLine(stdin, { prompt, stderr, hidden = false } = {}) {
  return new Promise((resolve, reject) => {
    let data = "";
    // Hidden input needs raw mode: a cooked TTY echoes keystrokes, so a token
    // typed at the prompt would land in the terminal and scrollback. Raw mode
    // disables echo and line editing, so we accumulate characters and handle
    // newline / backspace / Ctrl-C ourselves, echoing nothing. Hidden input
    // fails closed — if raw mode can't be enabled we reject rather than
    // silently echo a secret, leaving the caller to fall back to a pipe.
    const wantHidden = hidden && stdin.isTTY === true;
    let raw = false;

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      if (raw) {
        try { stdin.setRawMode(false); } catch { /* terminal already restored */ }
        if (stderr) stderr("\n"); // the un-echoed Enter still needs a line break
      }
      if (typeof stdin.pause === "function") stdin.pause();
    };

    const finish = (value) => {
      cleanup();
      resolve(value);
    };
    const fail = (err) => {
      cleanup();
      reject(err);
    };

    const onData = (chunk) => {
      if (!raw) {
        data += chunk;
        const newline = data.search(/\r?\n/);
        if (newline !== -1) finish(data.slice(0, newline));
        return;
      }
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish(data);
        if (ch === "\u0003") return fail(new CliError("input aborted")); // Ctrl-C
        if (ch === "\u0004") return finish(data); // Ctrl-D: submit what we have
        if (ch === "\u007f" || ch === "\b") { data = data.slice(0, -1); continue; } // backspace
        data += ch;
      }
    };
    const onEnd = () => finish(raw ? data : data.replace(/\r?\n$/, ""));
    const onError = (err) => fail(err);

    stdin.setEncoding("utf8");
    if (wantHidden) {
      const failClosed = () =>
        reject(new CliError("cannot hide input on this terminal; pipe the value in instead"));
      if (typeof stdin.setRawMode !== "function") return failClosed();
      try {
        stdin.setRawMode(true);
        raw = true;
      } catch {
        return failClosed();
      }
    }
    // Single write point for every prompt: escape it here so callers can
    // interpolate raw values (ns, keys, URLs) without per-field escaping, and a
    // control byte in a user-supplied arg can't reach the terminal via a prompt.
    if (prompt && stderr) stderr(escapeTerminalText(prompt));
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
  });
}

// Read a single secret value from stdin: a TTY prompts with hidden (raw-mode,
// non-echoing) input; a pipe/redirect is read to EOF with one trailing newline
// trimmed, so `printf '%s' "$SECRET" | …` works. Shared by `wdl token set` and
// `wdl secret put`.
/**
 * @param {{ isTTY?: boolean, setEncoding: (encoding: string) => void, setRawMode?: (mode: boolean) => void, on: Function, off: Function, pause?: Function }} stdin
 * @param {{ prompt?: string, stderr?: (text: string) => void }} [options]
 */
export function readSecretStdin(stdin, { prompt, stderr } = {}) {
  if (stdin.isTTY) return readTtyLine(stdin, { prompt, stderr, hidden: true });
  return new Promise((resolve, reject) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => (data += chunk));
    stdin.on("end", () => resolve(data.replace(/\r?\n$/, "")));
    stdin.on("error", reject);
  });
}

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

function findClosingQuote(value, quote) {
  for (let i = 1; i < value.length; i += 1) {
    if (value[i] !== quote) continue;
    if (quote === "\"" && isEscaped(value, i)) continue;
    return i;
  }
  return -1;
}

function isEscaped(value, idx) {
  let count = 0;
  for (let i = idx - 1; i >= 0 && value[i] === "\\"; i -= 1) count += 1;
  return count % 2 === 1;
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

export function formatKnownWarning(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return escapeTerminalText(String(value));
  }

  const out = {};
  for (const key of keys) {
    if (!Object.hasOwn(value, key)) continue;
    const field = value[key];
    if (field == null) continue;
    if (typeof field === "string" || typeof field === "number" || typeof field === "boolean") {
      out[key] = field;
      continue;
    }
    if (Array.isArray(field) && field.every(isScalarWarningField)) {
      out[key] = field;
    }
  }
  return escapeTerminalText(JSON.stringify(out));
}

function isScalarWarningField(value) {
  return value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean";
}

// Matching control characters is the whole point here.
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

export function escapeTerminalText(value) {
  const text = String(value);
  // Fast path: almost all text is clean, and callers sit on hot paths
  // (per-event tail rendering) — one regex test beats a per-codepoint walk.
  if (!TERMINAL_CONTROL_RE.test(text)) return text;
  return escapeControlChars(text, false);
}

// Mask a token for display: `****` plus the last 4 chars, but only when that
// reveals at most half the token (short tokens show no suffix). "(unset)" for
// an empty/absent token.
export function maskToken(token) {
  if (!token) return "(unset)";
  const text = String(token);
  const suffix = text.length <= 8 ? "" : text.slice(-4);
  return `****${suffix}`;
}

// Shared escape walk. keepLayout leaves tab/newline intact for human output.
function escapeControlChars(text, keepLayout) {
  let out = "";
  for (const ch of text) {
    if (keepLayout && (ch === "\t" || ch === "\n")) { out += ch; continue; }
    const code = ch.charCodeAt(0);
    out += isTerminalControlCode(code) ? escapeControlChar(ch, code) : ch;
  }
  return out;
}

function escapeControlChar(ch, code) {
  switch (ch) {
    case "\n": return "\\n";
    case "\r": return "\\r";
    case "\t": return "\\t";
    case "\b": return "\\b";
    case "\f": return "\\f";
    case "\v": return "\\u000b";
    default: return `\\u${code.toString(16).padStart(4, "0")}`;
  }
}

function isTerminalControlCode(code) {
  return (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}

// Dangerous control characters, EXCLUDING the layout chars tab (\t, 0x09) and
// newline (\n, 0x0a): list formatters use \t as a column separator and \n as
// a real line break, and neither moves the cursor destructively the way ESC,
// CR, or C1 sequences can.
// eslint-disable-next-line no-control-regex
const TERMINAL_LAYOUT_SAFE_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

// Human-output variant of escapeTerminalText (keeps the layout chars per the
// regex above), used at the writeResult choke point and by tail's renderer.
export function escapeTerminalLines(value) {
  const text = String(value);
  // Fast path: clean text (tabs/newlines allowed) needs no work.
  if (!TERMINAL_LAYOUT_SAFE_RE.test(text)) return text;
  return escapeControlChars(text, true);
}

export function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

// Canonical machine-JSON output: one place defines the format so the JSON from
// writeResult / writeJsonOr can't drift apart.
export function writeJson(stdout, body) {
  stdout(JSON.stringify(body, null, 2));
}

export function writeResult(json, body, format, stdout) {
  if (json) {
    writeJson(stdout, body);
    return;
  }
  // Choke point: every human-readable command output flows through here, so
  // neutralize control sequences in control-plane-derived fields once instead
  // of per format helper. JSON (`--json`) is machine output and left raw.
  for (const line of format()) stdout(escapeTerminalLines(line));
}

// Choke point for one-off human status lines — the non-JSON analogue of
// writeResult. Callers interpolate raw values and this escapes the assembled
// line once, so no interpolated field can be forgotten. escapeTerminalText (not
// -Lines): a status line is single-line, so an embedded newline is neutralized
// rather than allowed to split the line.
export function writeStatusLine(stdout, line) {
  stdout(escapeTerminalText(line));
}

// The `--json` half of a compound command's output: emit the body as machine
// JSON (left raw, like writeResult) and return true so the caller early-returns;
// return false otherwise to let it write human status lines. Keeps the json
// branch out of every subcommand.
export function writeJsonOr(json, body, stdout) {
  if (!json) return false;
  writeJson(stdout, body);
  return true;
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
