import path from "node:path";
import { CliError, flagSet, loadCliControlEnv, maskToken, protectedEnvKeys, resolveControlUrl, resolveNamespace } from "./common.js";
import { readTokenStore, tokenStorePath } from "./token-store.js";

/**
 * @param {{
 *   values?: Record<string, any>,
 *   env?: NodeJS.ProcessEnv,
 *   cwd?: string,
 *   dotenvPath?: string,
 *   warn?: (line: string) => void,
 * }} [options]
 */
export function resolveCliConfigState({ values = {}, env = process.env, cwd = process.cwd(), dotenvPath = ".env", warn = () => {} } = {}) {
  const workingEnv = { ...env };
  // The loader's helper, not a raw Object.keys set: diagnostics must resolve what
  // an operating command would. See protectedEnvKeys.
  const protectedKeys = protectedEnvKeys(env);
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
  loadCliControlEnv(workingEnv, {
    dotenvPath: resolvedDotenvPath,
    nsFromFlag: values.ns,
    tokenFromFlag: flagSet(values, "token"),
    controlUrlFromFlag: flagSet(values, "control-url"),
    protectedKeys,
    readStore: (e) => readTokenStore(tokenStorePath(e)),
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
  };
}

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

function configEntry({ value, source, display = value, error = null }) {
  return {
    value: value ?? null,
    display: display ?? "(unset)",
    source: source ?? "(unset)",
    error,
  };
}

function sourceForNamespace(values, env, sources) {
  if (typeof values.ns === "string" && values.ns.length > 0) return "--ns";
  if (typeof env.WDL_NS === "string" && env.WDL_NS.length > 0) return sources.get("WDL_NS") || "WDL_NS env";
  return null;
}

function sourceForControlUrl(values, env, sources) {
  if (flagSet(values, "control-url")) return "--control-url";
  if (typeof env.CONTROL_URL === "string" && env.CONTROL_URL.length > 0) return sources.get("CONTROL_URL") || "CONTROL_URL env";
  return null;
}

function tokenValue(values, env) {
  return firstString(values.token, env.ADMIN_TOKEN);
}

function sourceForToken(values, env, sources) {
  if (flagSet(values, "token")) return "--token";
  if (typeof env.ADMIN_TOKEN === "string" && env.ADMIN_TOKEN.length > 0) return sources.get("ADMIN_TOKEN") || "ADMIN_TOKEN env";
  return null;
}

function firstString(...values) {
  for (const value of values) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return null;
}
