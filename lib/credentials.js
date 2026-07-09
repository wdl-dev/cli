// Control-plane credential resolution: control URL / namespace resolution,
// the .env loader, and loadCliControlEnv (the layered flag > shell > .env >
// token-store pipeline with its cross-origin guard and store gap-fill).

import { readFileSync } from "node:fs";
import { CliError, hasErrorCode, isNonEmptyString } from "./common.js";
import { controlConnectHostForWarning } from "./control-connect-host.js";
import { CLI_DOTENV_KEYS, parseDotEnvSection, parseDotEnvValue } from "./dotenv.js";
import { isAdminAcceptableNs } from "./ns-pattern.js";
import { escapeTerminalText, formatDiagnosticValue } from "./output.js";

// Control-plane endpoint keys: where the admin token gets sent. A cwd .env
// must not redirect these for a token that came from the shell/--token.
const CONTROL_ENDPOINT_KEYS = ["CONTROL_URL", "CONTROL_CONNECT_HOST"];

/**
 * @param {Record<string, unknown>} values
 * @param {NodeJS.ProcessEnv} [env]
 */
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
    throw new CliError(`Invalid control URL ${formatDiagnosticValue(raw)}.`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new CliError(`Invalid control URL ${formatDiagnosticValue(raw)}: expected http:// or https://.`);
  }
  return normalized;
}

/** @param {string} text */
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

/**
 * @param {Record<string, unknown>} values
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {{ controlUrl: string, token: string, headers: Record<string, string> }}
 */
export function resolveControlContext(values, env = process.env) {
  const token = /** @type {string | undefined} */ (values.token) || env.ADMIN_TOKEN;
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
/**
 * @param {string} controlUrl
 * @param {(line: string) => void} [warn]
 * @param {NodeJS.ProcessEnv} [env]
 */
export function warnIfInsecureControlUrl(controlUrl, warn = (line) => console.error(line), env = process.env) {
  const reason = insecureControlUrlReason(controlUrl, env);
  if (!reason) return;
  warn(`warning: ${reason}; the admin token will be sent unencrypted`);
}

// True when the admin token would travel unencrypted to a host that doesn't
// look like a local/dev target.
/**
 * @param {string} controlUrl
 * @param {NodeJS.ProcessEnv} env
 */
function insecureControlUrlReason(controlUrl, env) {
  let parsed;
  try {
    parsed = new URL(controlUrl);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:") return null;
  if (!isLocalDevHost(parsed.hostname)) {
    return `control URL ${escapeTerminalText(controlUrl)} is plain http on a non-local host`;
  }
  const connectHost = env.CONTROL_CONNECT_HOST;
  if (!isNonEmptyString(connectHost)) return null;
  const actualHost = controlConnectHostForWarning(connectHost);
  if (!isLocalDevHost(actualHost)) {
    return `control URL ${escapeTerminalText(controlUrl)} is plain http and ` +
      `CONTROL_CONNECT_HOST=${escapeTerminalText(connectHost)} is non-local`;
  }
  return null;
}

// Loopback / dev-TLD hosts, shared by the bare-URL scheme default and the
// plaintext-token warning so the two policies cannot drift. Accepts both the
// bare IPv6 form and the bracketed form URL.hostname produces.
/** @param {string} host */
export function isLocalDevHost(host) {
  return (
    host === "localhost" ||
    host === "127.0.0.1" ||
    host === "::1" ||
    host === "[::1]" ||
    host.endsWith(".test") ||
    host.endsWith(".local")
  );
}

/**
 * @param {Record<string, unknown>} values
 * @param {NodeJS.ProcessEnv} [env]
 */
export function resolveNamespace(values, env = process.env) {
  return firstNonEmptyString(values.ns, env.WDL_NS);
}

/**
 * @param {...unknown} values
 * @returns {string | undefined}
 */
function firstNonEmptyString(...values) {
  return values.find(isNonEmptyString);
}

// A flag is "set" only when non-empty: an empty `--token ""` (or a missing /
// boolean flag) falls back to env.
/**
 * @param {Record<string, unknown>} values
 * @param {string} name
 */
export function flagSet(values, name) {
  return isNonEmptyString(values[name]);
}

// Shell/CI env wins over `.env`, but only when actually set — an empty/unset
// value must not protect its key, or it blocks the `.env` value AND then lets a
// lower-precedence store default win (inverting `.env` > store-default).
/** @param {NodeJS.ProcessEnv} env */
export function protectedEnvKeys(env) {
  return new Set(Object.keys(env).filter((key) => isNonEmptyString(env[key])));
}

/**
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [path]
 * @param {{
 *   resolvedNs?: string,
 *   loadBase?: boolean,
 *   protectedKeys?: Set<string>,
 *   warn?: (message: string) => void,
 *   onLoad?: ((entry: { key: string, value: string, section: string | null, line: number }) => void) | null,
 * }} [options]
 * @returns {string[]}
 */
export function loadCliDotEnv(
  env = process.env,
  path = ".env",
  options = {}
) {
  let text;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    if (hasErrorCode(err) && err.code === "ENOENT") return [];
    const message = err instanceof Error && err.message ? err.message : String(err);
    throw new CliError(`Cannot read .env file ${formatDiagnosticValue(path)}: ${escapeTerminalText(message)}`);
  }

  const {
    resolvedNs,
    loadBase = true,
    protectedKeys = protectedEnvKeys(env),
    warn = (message) => console.warn(`warning: ${message}`),
    onLoad = null,
  } = options;
  const selectedSection = firstNonEmptyString(resolvedNs);
  /** @type {string[]} */
  const loaded = [];
  /** @type {string | null} */
  let section = null;
  for (const [idx, rawLine] of text.replace(/^\uFEFF/, "").split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const nextSection = parseDotEnvSection(line, idx + 1);
    if (nextSection !== null) {
      section = nextSection;
      if (!isAdminAcceptableNs(section)) {
        throw new CliError(`Invalid .env line ${idx + 1}: invalid section name "${escapeTerminalText(section)}"`);
      }
      continue;
    }

    const body = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const eq = body.indexOf("=");
    if (eq <= 0) {
      const key = firstDotEnvToken(body);
      if (CLI_DOTENV_KEYS.has(key)) {
        throw new CliError(`Invalid .env line ${idx + 1}: expected KEY=value`);
      }
      continue;
    }

    const key = body.slice(0, eq).trim();
    if (!CLI_DOTENV_KEYS.has(key)) continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new CliError(`Invalid .env line ${idx + 1}: invalid key "${key}"`);
    }
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

/** @param {string} body */
function firstDotEnvToken(body) {
  const match = /^([A-Za-z_][A-Za-z0-9_]*)\b/.exec(body.trim());
  return match ? match[1] : "";
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
 *   readStore?: (env: NodeJS.ProcessEnv) => import("./token-store.js").TokenStore,
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
  /** @type {Set<string>} */
  const loaded = new Set();
  // loadCliDotEnv returns the loaded keys; a test-injected loader may return
  // something else, so guard the type rather than assume an array.
  /** @param {unknown} result */
  const record = (result) => {
    if (Array.isArray(result)) for (const key of result) loaded.add(key);
  };
  record(loadEnv(env, dotenvPath, { protectedKeys, onLoad, warn }));

  // The global store is the lowest-precedence, optional layer, so read it
  // lazily — only when it can actually contribute. Reading it eagerly would let
  // a corrupt or unreadable ~/.config/wdl/credentials abort a command whose
  // namespace and credentials already came from flags / shell / .env, with no
  // way to work around it. Memoize so the at-most-one read is shared.
  /** @type {import("./token-store.js").TokenStore | undefined} */
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
    /** @type {import("./token-store.js").TokenStore | undefined} */
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
        env.WDL_NS = def;
        if (onLoad) onLoad({ key: "WDL_NS", value: def, section: def, line: 0, origin: "store-default" });
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

// `--no-token-store` / `WDL_TOKEN_STORE=off` opt out of the global store for
// credential RESOLUTION only. It does not hide the on-disk file from project
// build code running as the same OS user (see docs/token.md).
/**
 * @param {NodeJS.ProcessEnv} env
 * @param {boolean} [flag]
 */
export function isTokenStoreDisabled(env, flag = false) {
  if (flag) return true;
  return isNonEmptyString(env.WDL_TOKEN_STORE) && env.WDL_TOKEN_STORE.toLowerCase() === "off";
}

// Only the control-plane endpoint and token are materialized into env from a
// store section; LABEL is store-only metadata for `wdl token list`.
/** @type {readonly ["CONTROL_URL", "ADMIN_TOKEN"]} */
const STORE_ENV_KEYS = ["CONTROL_URL", "ADMIN_TOKEN"];

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {string} ns
 * @param {Record<string, Record<string, string>>} namespaces
 * @param {((entry: { key: string, value: string, section: string | null, line: number, origin?: "store" | "store-default" }) => void) | undefined} onLoad
 * @param {Partial<Record<(typeof STORE_ENV_KEYS)[number], boolean>>} [covered]
 */
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
/**
 * @param {NodeJS.ProcessEnv} env
 * @param {Set<string>} loadedFromDotenv
 * @param {boolean} tokenFromFlag
 * @param {(line: string) => void} onCrossOrigin
 */
function guardCrossOriginControlEnv(env, loadedFromDotenv, tokenFromFlag, onCrossOrigin) {
  // A NON-EMPTY .env token, not merely a loaded `ADMIN_TOKEN=` key: an empty
  // placeholder would otherwise mark the .env endpoint same-source while the
  // real token gets gap-filled from the global store afterwards — letting an
  // untrusted .env redirect a STORED token to a host it chose.
  const tokenIsFromDotenv =
    loadedFromDotenv.has("ADMIN_TOKEN") &&
    isNonEmptyString(env.ADMIN_TOKEN) &&
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
