import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { getNodeValue, parseTree, printParseErrorCode } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";
import { escapeTerminalText, formatDiagnosticValue } from "../output.js";
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
export const WRANGLER_WDL_TMP_PREFIX = ".wrangler.wdl-tmp";
export const WRANGLER_WDL_TMP_IGNORE_PATTERN = `/${WRANGLER_WDL_TMP_PREFIX}*.json`;

/**
 * @typedef {{ path: string, cfg: unknown, shadowed: string[] }} LoadedWranglerConfig
 */

/**
 * @typedef {{ selected: { name: string, path: string } | null, shadowed: string[] }} WranglerConfigSelection
 */

/**
 * @param {string} dir
 * @returns {WranglerConfigSelection}
 */
export function selectWranglerConfigFiles(dir) {
  const found = WRANGLER_CONFIG_CANDIDATES.filter((name) => existsSync(path.join(dir, name)));
  const selected = found[0] ? { name: found[0], path: path.join(dir, found[0]) } : null;
  return { selected, shadowed: found.slice(1) };
}

/**
 * @param {string} dir
 * @returns {LoadedWranglerConfig}
 */
export function loadWranglerConfig(dir) {
  const selection = selectWranglerConfigFiles(dir);
  if (selection.selected) {
    const { name, path: p } = selection.selected;
    /** @type {string} */
    let raw;
    try {
      raw = readFileSync(p, "utf8");
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : String(err);
      throw new Error(`failed to read ${escapeTerminalText(name)}: ${escapeTerminalText(message)}`, { cause: err });
    }
    try {
      if (name.endsWith(".toml")) return { path: p, cfg: parseToml(raw), shadowed: selection.shadowed };
      return { path: p, cfg: parseJsonc(raw), shadowed: selection.shadowed };
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
        `${shownConfig} uses unsupported Wrangler field ${formatDiagnosticValue(key)}. ${SUPPORTED_WRANGLER_SUMMARY}`
      );
    }
    if (hasConfiguredKey(selectedEnvCfg, key)) {
      throw new Error(
        `${shownConfig} env.${shownEnv} uses unsupported Wrangler field ${formatDiagnosticValue(key)}. ${SUPPORTED_WRANGLER_SUMMARY}`
      );
    }
  }

  // The control plane rejects a deploy carrying a top-level allowedCallers, so
  // fail fast here (before the wrangler bundle) rather than after a control 400.
  const allowedCallersHint =
    'Authorize cross-namespace service-binding callers on the target via ' +
    '[[exports]] (entrypoint = "default", allowed_callers = [...]).';
  if (hasConfiguredKey(cfg, "allowed_callers")) {
    throw new Error(`${shownConfig} uses top-level allowed_callers — removed. ${allowedCallersHint}`);
  }
  if (hasConfiguredKey(selectedEnvCfg, "allowed_callers")) {
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
 * @returns {unknown}
 */
export function parseJsonc(src) {
  // Wrangler strips a UTF-8 BOM before parsing both .json and .jsonc files.
  const input = src.charCodeAt(0) === 0xfeff ? src.slice(1) : src;
  /** @type {import("jsonc-parser").ParseError[]} */
  const errors = [];
  const tree = parseTree(input, errors, { allowTrailingComma: true });
  if (errors[0]) {
    throw new SyntaxError(printParseErrorCode(errors[0].error));
  }
  if (!tree) throw new SyntaxError("ValueExpected");
  return materializeJsonValue(getNodeValue(tree));
}

/**
 * Convert jsonc-parser's null-prototype objects to the plain JSON objects the
 * previous JSON.parse path returned, without invoking the __proto__ setter.
 * @param {unknown} value
 * @returns {unknown}
 */
function materializeJsonValue(value) {
  if (Array.isArray(value)) return value.map(materializeJsonValue);
  if (!value || typeof value !== "object") return value;

  /** @type {Record<string, unknown>} */
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    Object.defineProperty(result, key, {
      configurable: true,
      enumerable: true,
      value: materializeJsonValue(item),
      writable: true,
    });
  }
  return result;
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
  return Boolean(record && Object.hasOwn(record, key));
}
