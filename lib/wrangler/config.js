import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { asRecord } from "./utils.js";

/**
 * A parsed Wrangler config (`wrangler.toml`/`.jsonc`/`.json`). The CLI never
 * trusts these fields' shapes: every binding parser re-validates the value it
 * reads. Known sections (`name`, `main`, `kv_namespaces`, `d1_databases`,
 * `r2_buckets`, `services`, `durable_objects`, `migrations`, `workflows`,
 * `queues`, `exports`, `platform_bindings`, `vars`, `triggers`, `route`,
 * `routes`, `assets`, `compatibility_date`, `compatibility_flags`, `env`, and
 * the unsupported sections rejected by name) are read off this object and
 * narrowed at the use site, so the honest value type is `unknown`.
 * @typedef {Record<string, unknown>} WranglerConfig
 */

const TOP_LEVEL_ONLY_ENV_KEYS = new Set([
  "name",
  "keep_vars",
  "migrations",
  "send_metrics",
  "site",
]);

// Valid Wrangler binding sections the WDL manifest has no mapping for.
// Reject them loudly: wrangler dry-run bundles them happily, so a silent
// drop here would surface as `env.<BINDING> === undefined` at runtime.
const UNSUPPORTED_WRANGLER_KEYS = [
  "ai",
  "ai_search",
  "ai_search_namespaces",
  "analytics_engine_datasets",
  "browser",
  "containers",
  "data_blobs",
  "dispatch_namespaces",
  "hyperdrive",
  "images",
  "logfwdr",
  "mtls_certificates",
  "pipelines",
  "secrets_store_secrets",
  "send_email",
  "tail_consumers",
  "text_blobs",
  "unsafe",
  "vectorize",
  "version_metadata",
  "wasm_modules",
];

const SUPPORTED_WRANGLER_SUMMARY =
  "Supported: [[kv_namespaces]], [[d1_databases]], [[r2_buckets]], [[services]], " +
  "[[durable_objects.bindings]], [[workflows]], [[queues.producers]], [[queues.consumers]], " +
  "[[platform_bindings]], [[exports]], [vars], [triggers], assets.directory, route(s), " +
  "compatibility_date/compatibility_flags.";

const NON_INHERITABLE_ENV_KEYS = new Set([
  "define",
  "vars",
  "d1_databases",
  "durable_objects",
  "kv_namespaces",
  "r2_buckets",
  "ai_search_namespaces",
  "ai_search",
  "vectorize",
  "services",
  "queues",
  "workflows",
  "tail_consumers",
  "secrets",
  "secrets_store_secrets",
]);

/**
 * @param {string} dir
 * @returns {{ path: string, cfg: unknown }}
 */
export function loadWranglerConfig(dir) {
  const candidates = ["wrangler.toml", "wrangler.jsonc", "wrangler.json"];
  for (const name of candidates) {
    const p = path.join(dir, name);
    if (!existsSync(p)) continue;
    const raw = readFileSync(p, "utf8");
    try {
      if (name.endsWith(".toml")) return { path: p, cfg: parseToml(raw) };
      if (name.endsWith(".jsonc")) return { path: p, cfg: parseJsonc(raw) };
      return { path: p, cfg: JSON.parse(raw) };
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : String(err);
      throw new Error(`failed to parse ${name}: ${message}`, { cause: err });
    }
  }
  throw new Error(`no wrangler.{toml,jsonc,json} found in ${dir}`);
}

/**
 * @param {unknown} rawCfg
 * @param {string | null | undefined} envName
 * @param {string} [configRel]
 */
export function validateUnsupportedWranglerConfig(rawCfg, envName, configRel = "wrangler config") {
  const cfg = asRecord(rawCfg);
  const envTable = cfg ? asRecord(cfg.env) : null;
  const selectedEnvCfg =
    envName && envTable ? asRecord(envTable[envName]) : null;

  for (const key of UNSUPPORTED_WRANGLER_KEYS) {
    if (hasConfiguredValue(cfg?.[key])) {
      throw new Error(
        `${configRel} uses [${key}] — not supported. ${SUPPORTED_WRANGLER_SUMMARY}`
      );
    }
    if (hasConfiguredValue(selectedEnvCfg?.[key])) {
      throw new Error(
        `${configRel} env.${envName} uses [${key}] — not supported. ${SUPPORTED_WRANGLER_SUMMARY}`
      );
    }
  }

  // The control plane rejects a deploy carrying a top-level allowedCallers, so
  // fail fast here (before the wrangler bundle) rather than after a control 400.
  const allowedCallersHint =
    'Authorize cross-namespace service-binding callers on the target via ' +
    '[[exports]] (entrypoint = "default", allowed_callers = [...]).';
  if (hasConfiguredValue(cfg?.allowed_callers)) {
    throw new Error(`${configRel} uses top-level allowed_callers — removed. ${allowedCallersHint}`);
  }
  if (hasConfiguredValue(selectedEnvCfg?.allowed_callers)) {
    throw new Error(`${configRel} env.${envName} uses top-level allowed_callers — removed. ${allowedCallersHint}`);
  }
}

/**
 * @param {unknown} rawCfg
 * @param {string | null | undefined} envName
 * @param {string} [configRel]
 * @returns {{ cfg: WranglerConfig, envName: string | null }}
 */
export function resolveWranglerConfig(rawCfg, envName, configRel = "wrangler config") {
  if (!rawCfg || typeof rawCfg !== "object" || Array.isArray(rawCfg)) {
    throw new Error(`${configRel}: config must be an object`);
  }
  const cfg = /** @type {WranglerConfig} */ (rawCfg);

  const availableEnvs = listNamedEnvironments(cfg);
  if (!envName) {
    if (availableEnvs.length) {
      throw new Error(
        `${configRel}: named environments found (${availableEnvs.join(", ")}); ` +
        `pass --env <name> or set CLOUDFLARE_ENV`
      );
    }
    return { cfg, envName: null };
  }

  if (!availableEnvs.length) {
    throw new Error(`${configRel}: environment "${envName}" requested but no [env] config exists`);
  }

  const envTable = asRecord(cfg.env);
  if (!envTable || !Object.hasOwn(envTable, envName)) {
    throw new Error(
      `${configRel}: environment "${envName}" not found ` +
      `(available: ${availableEnvs.join(", ")})`
    );
  }

  const envCfg = asRecord(envTable[envName]);
  if (!envCfg) {
    throw new Error(`${configRel}: env.${envName} must be an object/table`);
  }

  for (const key of Object.keys(envCfg)) {
    if (TOP_LEVEL_ONLY_ENV_KEYS.has(key)) {
      throw new Error(`${configRel}: env.${envName}.${key} is top-level only`);
    }
  }

  /** @type {Record<string, unknown>} */
  const resolved = {};
  for (const [key, value] of Object.entries(cfg)) {
    if (key === "env" || key === "__proto__" || NON_INHERITABLE_ENV_KEYS.has(key)) continue;
    resolved[key] = value;
  }
  for (const [key, value] of Object.entries(envCfg)) {
    // JSON.parse yields "__proto__" as an own key; bracket-assigning it here
    // would rewrite the merged object's prototype instead.
    if (key === "__proto__") continue;
    resolved[key] = value;
  }

  return { cfg: resolved, envName };
}

/**
 * @param {string} src
 * @returns {string}
 */
export function stripJsonComments(src) {
  let out = "";
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const next = src[i + 1];
    if (c === '"') {
      const start = i;
      i++;
      while (i < n) {
        if (src[i] === "\\") { i += 2; continue; }
        if (src[i] === '"') { i++; break; }
        i++;
      }
      out += src.slice(start, i);
      continue;
    }
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(src[i] === "*" && src[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

/**
 * @param {string} src
 * @returns {string}
 */
export function stripTrailingCommas(src) {
  let out = "";
  let i = 0;
  let inString = false;

  while (i < src.length) {
    const c = src[i];
    if (inString) {
      out += c;
      if (c === "\\") {
        i++;
        if (i < src.length) out += src[i];
      } else if (c === '"') {
        inString = false;
      }
      i++;
      continue;
    }

    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }

    if (c === ",") {
      let j = i + 1;
      while (j < src.length && /\s/.test(src[j])) j++;
      if (src[j] === "}" || src[j] === "]") {
        i++;
        continue;
      }
    }

    out += c;
    i++;
  }

  return out;
}

/**
 * @param {string} src
 * @returns {unknown}
 */
export function parseJsonc(src) {
  return JSON.parse(stripTrailingCommas(stripJsonComments(src)));
}

/**
 * @param {WranglerConfig} cfg
 * @returns {string[]}
 */
function listNamedEnvironments(cfg) {
  const env = asRecord(cfg.env);
  if (!env) return [];
  return Object.keys(env);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasConfiguredValue(value) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}
