import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import { escapeTerminalText } from "../output.js";
import { asRecord } from "./utils.js";

/**
 * A parsed Wrangler config (`wrangler.json`, `wrangler.jsonc`, or
 * `wrangler.toml`). The CLI never trusts these fields' shapes: every binding
 * parser re-validates the value it reads. Known sections (`name`, `main`,
 * `kv_namespaces`, `d1_databases`, `r2_buckets`, `services`,
 * `durable_objects`, `migrations`, `workflows`, `queues`, `exports`,
 * `platform_bindings`, `vars`, `triggers`, `route`, `routes`, `assets`,
 * `compatibility_date`, `compatibility_flags`, `env`, and the unsupported
 * sections rejected by name) are read off this object and narrowed at the use
 * site, so the honest value type is `unknown`.
 * @typedef {Record<string, unknown>} WranglerConfig
 */

const TOP_LEVEL_ONLY_ENV_KEYS = new Set([
  "name",
  "keep_vars",
  "send_metrics",
]);

// Runtime/deploy-facing Wrangler keys the WDL manifest has no mapping for.
// Reject them loudly: wrangler dry-run accepts them happily, so a silent
// drop here would surface as missing bindings or ignored deploy policy.
// Bundling-only keys (build, alias, tsconfig, rules, etc.) stay allowed
// because Wrangler consumes them before the CLI collects the output manifest.
const UNSUPPORTED_WRANGLER_KEYS = [
  "agent_memory",
  "ai",
  "ai_search",
  "ai_search_namespaces",
  "analytics_engine_datasets",
  "artifacts",
  "browser",
  "cache",
  "cloudchamber",
  "compliance_region",
  "containers",
  "data_blobs",
  "dispatch_namespaces",
  "first_party_worker",
  "flagship",
  "hyperdrive",
  "images",
  "legacy_env",
  "limits",
  "logfwdr",
  "logpush",
  "media",
  "mtls_certificates",
  "observability",
  "pages_build_output_dir",
  "pipelines",
  "placement",
  "preview_urls",
  "previews",
  "python_modules",
  "ratelimits",
  "secrets_store_secrets",
  "send_email",
  "site",
  "stream",
  "streaming_tail_consumers",
  "tail_consumers",
  "text_blobs",
  "upload_source_maps",
  "unsafe",
  "unsafe_hello_world",
  "vectorize",
  "version_metadata",
  "vpc_networks",
  "vpc_services",
  "wasm_modules",
  "websearch",
  "worker_loaders",
  "workers_dev",
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

export const WRANGLER_CONFIG_CANDIDATES = Object.freeze(["wrangler.json", "wrangler.jsonc", "wrangler.toml"]);

/**
 * @typedef {{ path: string, cfg: unknown, shadowed: string[] }} LoadedWranglerConfig
 */

/**
 * @param {string} dir
 * @returns {LoadedWranglerConfig}
 */
export function loadWranglerConfig(dir) {
  const found = WRANGLER_CONFIG_CANDIDATES.filter((name) => existsSync(path.join(dir, name)));
  for (const name of found) {
    const p = path.join(dir, name);
    const raw = readFileSync(p, "utf8");
    try {
      const shadowed = found.slice(1);
      if (name.endsWith(".toml")) return { path: p, cfg: parseToml(raw), shadowed };
      if (name.endsWith(".jsonc")) return { path: p, cfg: parseJsonc(raw), shadowed };
      return { path: p, cfg: JSON.parse(raw), shadowed };
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : String(err);
      throw new Error(`failed to parse ${escapeTerminalText(name)}: ${escapeTerminalText(message)}`, { cause: err });
    }
  }
  throw new Error(`no ${WRANGLER_CONFIG_CANDIDATES.join(", ")} found in ${escapeTerminalText(dir)}`);
}

/**
 * @param {LoadedWranglerConfig} loaded
 * @returns {string | null}
 */
export function formatWranglerConfigShadowWarning(loaded) {
  if (loaded.shadowed.length === 0) return null;
  return `multiple Wrangler config files found; using ${path.basename(loaded.path)} and ignoring ${loaded.shadowed.join(", ")}`;
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
  const shownConfig = escapeTerminalText(configRel);
  const shownEnv = escapeTerminalText(envName ?? "");

  for (const key of UNSUPPORTED_WRANGLER_KEYS) {
    if (hasConfiguredKey(cfg, key)) {
      throw new Error(
        `${shownConfig} uses [${key}] — not supported. ${SUPPORTED_WRANGLER_SUMMARY}`
      );
    }
    if (hasConfiguredKey(selectedEnvCfg, key)) {
      throw new Error(
        `${shownConfig} env.${shownEnv} uses [${key}] — not supported. ${SUPPORTED_WRANGLER_SUMMARY}`
      );
    }
  }

  // The control plane rejects a deploy carrying a top-level allowedCallers, so
  // fail fast here (before the wrangler bundle) rather than after a control 400.
  const allowedCallersHint =
    'Authorize cross-namespace service-binding callers on the target via ' +
    '[[exports]] (entrypoint = "default", allowed_callers = [...]).';
  if (hasConfiguredValue(cfg?.allowed_callers)) {
    throw new Error(`${shownConfig} uses top-level allowed_callers — removed. ${allowedCallersHint}`);
  }
  if (hasConfiguredValue(selectedEnvCfg?.allowed_callers)) {
    throw new Error(`${shownConfig} env.${shownEnv} uses top-level allowed_callers — removed. ${allowedCallersHint}`);
  }
}

/**
 * @param {unknown} rawCfg
 * @param {string | null | undefined} envName
 * @param {string} [configRel]
 * @returns {{ cfg: WranglerConfig, envName: string | null }}
 */
export function resolveWranglerConfig(rawCfg, envName, configRel = "wrangler config") {
  const shownConfig = escapeTerminalText(configRel);
  const shownEnv = escapeTerminalText(envName ?? "");
  if (!rawCfg || typeof rawCfg !== "object" || Array.isArray(rawCfg)) {
    throw new Error(`${shownConfig}: config must be an object`);
  }
  const cfg = /** @type {WranglerConfig} */ (rawCfg);

  const availableEnvs = listNamedEnvironments(cfg);
  const shownAvailableEnvs = availableEnvs.map(escapeTerminalText).join(", ");
  if (!envName) {
    if (availableEnvs.length) {
      throw new Error(
        `${shownConfig}: named environments found (${shownAvailableEnvs}); ` +
        `pass --env <name> or set CLOUDFLARE_ENV`
      );
    }
    return { cfg, envName: null };
  }

  if (!availableEnvs.length) {
    throw new Error(`${shownConfig}: environment "${shownEnv}" requested but no [env] config exists`);
  }

  const envTable = asRecord(cfg.env);
  if (!envTable || !Object.hasOwn(envTable, envName)) {
    throw new Error(
      `${shownConfig}: environment "${shownEnv}" not found ` +
      `(available: ${shownAvailableEnvs})`
    );
  }

  const envCfg = asRecord(envTable[envName]);
  if (!envCfg) {
    throw new Error(`${shownConfig}: env.${shownEnv} must be an object/table`);
  }

  for (const key of Object.keys(envCfg)) {
    if (TOP_LEVEL_ONLY_ENV_KEYS.has(key)) {
      throw new Error(`${shownConfig}: env.${shownEnv}.${key} is top-level only`);
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
 * @param {Record<string, unknown> | null} record
 * @param {string} key
 * @returns {boolean}
 */
function hasConfiguredKey(record, key) {
  if (!record || !Object.hasOwn(record, key)) return false;
  const value = record[key];
  return value == null || Array.isArray(value) ? hasConfiguredValue(value) : true;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function hasConfiguredValue(value) {
  return Array.isArray(value) ? value.length > 0 : Boolean(value);
}
