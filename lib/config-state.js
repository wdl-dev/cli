import path from "node:path";
import { CliError, isNonEmptyString } from "./common.js";
import { flagSet, isTokenStoreDisabled, loadCliControlEnv, protectedEnvKeys, resolveControlUrl, resolveNamespace } from "./credentials.js";
import { maskToken } from "./output.js";
import { tokenStoreReader } from "./token-store.js";

export class TokenStoreConfigError extends CliError {
  /** @param {string} message */
  constructor(message) {
    super(message);
    this.name = "TokenStoreConfigError";
  }
}

/**
 * A resolved config field with its display value and provenance.
 * @typedef {{ value: string | null, display: string, source: string, error: string | null }} ConfigEntry
 */

/**
 * @param {{
 *   values?: Record<string, unknown>,
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   dotenvPath?: string,
 *   readStore?: (env: NodeJS.ProcessEnv) => import("./token-store.js").TokenStore,
 *   warn?: (line: string) => void,
 * }} [options]
 */
export function resolveCliConfigState({ values = {}, env = process.env, cwd = process.cwd(), dotenvPath = ".env", readStore, warn = () => {} } = {}) {
  const workingEnv = { ...env };
  // The loader's helper, not a raw Object.keys set: diagnostics must resolve what
  // an operating command would. See protectedEnvKeys.
  const protectedKeys = protectedEnvKeys(env);
  /** @type {Map<string, string>} */
  const sources = new Map();
  for (const key of Object.keys(env)) sources.set(key, `${key} env`);

  const resolvedDotenvPath = path.resolve(cwd, dotenvPath);
  /** @param {{ key: string, section: string | null, origin?: "store" | "store-default" }} entry */
  const recordDotenvLoad = ({ key, section, origin }) => {
    const label = origin === "store-default"
      ? "token store default"
      : origin === "store"
        ? `token store [${section}].${key}`
        : section === null
          ? `.env ${key}`
          : `.env [${section}].${key}`;
    sources.set(key, label);
  };

  // Same loader + cross-origin guard as the bin dispatcher, so config explain /
  // doctor / whoami resolve exactly what an operating command would. Base .env
  // warnings stay quiet for diagnostics; a cross-origin endpoint redirect is
  // surfaced through the caller's warn.
  // Resolved before the .env load (so WDL_TOKEN_STORE comes from the process env —
  // shell/CI — not a project .env) and surfaced so doctor reuses it.
  const tokenStoreDisabled = isTokenStoreDisabled(workingEnv, values["no-token-store"] === true);
  const storeReader = readStore || tokenStoreReader(tokenStoreDisabled);
  loadCliControlEnv(workingEnv, {
    dotenvPath: resolvedDotenvPath,
    nsFromFlag: /** @type {string | undefined} */ (values.ns),
    tokenFromFlag: flagSet(values, "token"),
    controlUrlFromFlag: flagSet(values, "control-url"),
    protectedKeys,
    readStore: wrapTokenStoreReader(storeReader),
    onLoad: recordDotenvLoad,
    warn: () => {},
    onCrossOrigin: warn,
  });

  return {
    namespace: configEntry({
      value: resolveNamespace(values, workingEnv),
      source: sourceForNamespace(values, workingEnv, sources),
    }),
    controlUrl: controlUrlEntry(values, workingEnv, sources),
    token: configEntry({
      value: tokenValue(values, workingEnv),
      source: sourceForToken(values, workingEnv, sources),
      display: maskToken(tokenValue(values, workingEnv)),
    }),
    env: workingEnv,
    dotenvPath: resolvedDotenvPath,
    tokenStoreDisabled,
  };
}

/**
 * @param {(env: NodeJS.ProcessEnv) => import("./token-store.js").TokenStore} readStore
 */
function wrapTokenStoreReader(readStore) {
  /** @param {NodeJS.ProcessEnv} env */
  return (env) => {
    try {
      return readStore(env);
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : String(err);
      throw new TokenStoreConfigError(message);
    }
  };
}

/**
 * @param {Record<string, unknown>} values
 * @param {NodeJS.ProcessEnv} env
 * @param {Map<string, string>} sources
 * @returns {ConfigEntry}
 */
function controlUrlEntry(values, env, sources) {
  try {
    return configEntry({
      value: resolveControlUrl(values, env),
      source: sourceForControlUrl(values, env, sources),
    });
  } catch (err) {
    if (err instanceof CliError) {
      return configEntry({
        value: null,
        source: sourceForControlUrl(values, env, sources),
        error: err.message,
      });
    }
    throw err;
  }
}

/**
 * @param {{ value?: string | null, source?: string | null, display?: string | null, error?: string | null }} entry
 * @returns {ConfigEntry}
 */
function configEntry({ value, source, display = value, error = null }) {
  return {
    value: value ?? null,
    display: display ?? "(unset)",
    source: source ?? "(unset)",
    error,
  };
}

/**
 * @param {Record<string, unknown>} values
 * @param {NodeJS.ProcessEnv} env
 * @param {Map<string, string>} sources
 */
function sourceForNamespace(values, env, sources) {
  if (isNonEmptyString(values.ns)) return "--ns";
  if (isNonEmptyString(env.WDL_NS)) return sources.get("WDL_NS") || "WDL_NS env";
  return null;
}

/**
 * @param {Record<string, unknown>} values
 * @param {NodeJS.ProcessEnv} env
 * @param {Map<string, string>} sources
 */
function sourceForControlUrl(values, env, sources) {
  if (flagSet(values, "control-url")) return "--control-url";
  if (isNonEmptyString(env.CONTROL_URL)) return sources.get("CONTROL_URL") || "CONTROL_URL env";
  return null;
}

/**
 * @param {Record<string, unknown>} values
 * @param {NodeJS.ProcessEnv} env
 */
function tokenValue(values, env) {
  return firstString(values.token, env.ADMIN_TOKEN);
}

/**
 * @param {Record<string, unknown>} values
 * @param {NodeJS.ProcessEnv} env
 * @param {Map<string, string>} sources
 */
function sourceForToken(values, env, sources) {
  if (flagSet(values, "token")) return "--token";
  if (isNonEmptyString(env.ADMIN_TOKEN)) return sources.get("ADMIN_TOKEN") || "ADMIN_TOKEN env";
  return null;
}

/**
 * @param {...unknown} values
 * @returns {string | null}
 */
function firstString(...values) {
  for (const value of values) {
    if (isNonEmptyString(value)) return value;
  }
  return null;
}
