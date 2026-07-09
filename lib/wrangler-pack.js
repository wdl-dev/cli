// Shell out to wrangler dry-run so local bundling stays aligned with
// `wrangler dev` / Wrangler's own module resolution pipeline.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliError } from "./common.js";
import { escapeTerminalText, formatDiagnosticValue } from "./output.js";
import {
  RESERVED_OBJECT_KEYS,
  WDL_RESERVED_BINDING_RE,
} from "./ns-pattern.js";
import { collectAssets, resolveAssetsDir } from "./wrangler/assets.js";
import {
  parseD1DatabasesFromCfg,
  parseDurableObjectsFromCfg,
  parseExportsFromCfg,
  parseKvNamespacesFromCfg,
  parsePlatformBindingsFromCfg,
  parseQueues,
  parseR2BucketsFromCfg,
  parseServicesFromCfg,
  parseTriggers,
  parseWorkflowsFromCfg,
} from "./wrangler/bindings.js";
import {
  checkWranglerVersion,
  formatWranglerFailure,
  resolveWranglerCommand,
  wranglerChildEnv,
} from "./wrangler/command.js";
import {
  formatWranglerConfigShadowWarning,
  loadWranglerConfig,
  resolveWranglerConfig,
  validateUnsupportedWranglerConfig,
  WRANGLER_WDL_TMP_PREFIX,
} from "./wrangler/config.js";
import { collectModules } from "./wrangler/modules.js";
import { asRecord, hasOwn, manifestMap } from "./wrangler/utils.js";

// Keep `wrangler-pack.js` as the stable facade for deploy.js and existing
// helper tests. New helper code should import from `./wrangler/<module>.js`
// directly when it does not need the full packWranglerProject orchestration.
export {
  collectAssets,
  MAX_ASSET_FILE_BYTES,
  MAX_ASSETS_TOTAL_BYTES,
  resolveAssetsDir,
} from "./wrangler/assets.js";
export {
  parseD1DatabasesFromCfg,
  parseDurableObjectsFromCfg,
  parseExportsFromCfg,
  parseKvNamespacesFromCfg,
  parsePlatformBindingsFromCfg,
  parseQueues,
  parseR2BucketsFromCfg,
  parseServicesFromCfg,
  parseTriggers,
  parseWorkflowsFromCfg,
} from "./wrangler/bindings.js";
export {
  parseWranglerMajorVersion,
  resolveWranglerCommand,
  wranglerChildEnv,
} from "./wrangler/command.js";
export {
  formatWranglerConfigShadowWarning,
  loadWranglerConfig,
  parseJsonc,
  resolveWranglerConfig,
  selectWranglerConfigFiles,
  validateUnsupportedWranglerConfig,
  WRANGLER_WDL_TMP_IGNORE_PATTERN,
  WRANGLER_WDL_TMP_PREFIX,
} from "./wrangler/config.js";
export { collectModules } from "./wrangler/modules.js";

const WRANGLER_OUTPUT_MAX_BUFFER = 10 * 1024 * 1024;

/**
 * The deploy manifest assembled from a wrangler project. Optional sections are
 * only present when the config declares them.
 * @typedef {object} WorkerManifest
 * @property {string} mainModule
 * @property {Record<string, unknown>} modules
 * @property {Record<string, unknown>} [bindings]
 * @property {Record<string, unknown>} [vars]
 * @property {unknown} [compatibilityDate]
 * @property {unknown} [compatibilityFlags]
 * @property {string[]} [routes]
 * @property {Array<{ cron: string, timezone: string }>} [crons]
 * @property {import("./wrangler/bindings.js").QueueConsumer[]} [queueConsumers]
 * @property {Array<{ name: string, binding: string, className: string }>} [workflows]
 * @property {import("./wrangler/bindings.js").ExportEntry[]} [exports]
 * @property {Array<{ binding: string, platform: string }>} [platformBindings]
 * @property {Record<string, unknown>} [assets]
 */

/**
 * @param {unknown} vars
 * @returns {Record<string, unknown>}
 */
function normalizeVars(vars) {
  if (vars == null) return {};
  if (typeof vars !== "object" || Array.isArray(vars)) {
    throw new CliError("[vars] must be an object");
  }
  const normalized = manifestMap();
  for (const [name, value] of Object.entries(vars)) {
    if (WDL_RESERVED_BINDING_RE.test(name)) {
      throw new CliError(`[vars] ${escapeTerminalText(name)}: name is reserved for runtime-internal bindings`);
    }
    if (RESERVED_OBJECT_KEYS.has(name)) {
      throw new CliError(`[vars] ${escapeTerminalText(name)}: name is a reserved Object.prototype key`);
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new CliError(`[vars] ${escapeTerminalText(name)}: only string/number/boolean values are supported`);
    }
    normalized[name] = value;
  }
  return normalized;
}

/**
 * @param {{
 *   cwd?: string,
 *   projectDir: string,
 *   envName?: string | null,
 *   env?: NodeJS.ProcessEnv,
 *   execFile?: typeof execFileSync,
 *   stdout?: (line?: string) => void,
 *   stderr?: (line?: string) => void,
 *   verbose?: boolean,
 * }} options
 * @returns {Promise<{ absProject: string, workerName: string, manifest: WorkerManifest }>}
 */
export async function packWranglerProject({
  cwd = process.cwd(),
  projectDir,
  envName: selectedEnv = null,
  env = process.env,
  execFile = execFileSync,
  stdout = (_line = "") => {},
  stderr = (_line = "") => {},
  verbose = false,
}) {
  if (!projectDir) throw new CliError("packWranglerProject: projectDir is required");
  const absProject = path.resolve(cwd, projectDir);
  const loadedConfig = wrapCli(() => loadWranglerConfig(absProject));
  const { path: configPath, cfg: rawCfg } = loadedConfig;
  const configRel = path.basename(configPath);
  const shadowWarning = formatWranglerConfigShadowWarning(loadedConfig);
  if (shadowWarning) stderr(`warning: ${shadowWarning}`);
  const { cfg, envName } = wrapCli(() => {
    validateUnsupportedWranglerConfig(rawCfg, selectedEnv, configRel);
    return resolveWranglerConfig(rawCfg, selectedEnv, configRel);
  });
  // Validate the type, not just truthiness: the dry-run bundle uses a sanitized
  // temp name, so Wrangler never checks the original cfg.name — a non-string
  // would otherwise be asserted as the string workerName below.
  if (typeof cfg.name !== "string" || !cfg.name.trim()) {
    throw new CliError(`${configRel}: 'name' must be a non-empty string`);
  }
  if (!cfg.main) throw new CliError(`${configRel} missing 'main'`);

  const bindings = manifestMap();
  // Every name a worker binds (manifest bindings, workflows, platform
  // bindings) shares the runtime env namespace; claim each one exactly once.
  /** @type {Set<string>} */
  const claimedBindings = new Set();
  /** @param {string} name */
  const claimBinding = (name) => {
    if (claimedBindings.has(name)) throw new CliError(`binding name collision: ${escapeTerminalText(name)}`);
    claimedBindings.add(name);
  };

  const kvList = wrapCli(() => parseKvNamespacesFromCfg(cfg, configRel));
  for (const kv of kvList) {
    claimBinding(kv.binding);
    bindings[kv.binding] = { type: "kv", id: kv.id };
  }

  const d1List = wrapCli(() => parseD1DatabasesFromCfg(cfg, configRel));
  for (const d1 of d1List) {
    claimBinding(d1.binding);
    bindings[d1.binding] = { type: "d1", databaseId: d1.databaseId };
  }

  const r2List = wrapCli(() => parseR2BucketsFromCfg(cfg, configRel));
  for (const r2 of r2List) {
    claimBinding(r2.binding);
    bindings[r2.binding] = { type: "r2", bucketName: r2.bucketName };
  }

  const svcList = wrapCli(() => parseServicesFromCfg(cfg, configRel));
  for (const svc of svcList) {
    claimBinding(svc.binding);
    /** @type {{ type: string, service: string, entrypoint?: string, ns?: string }} */
    const entry = { type: "service", service: svc.service };
    if (svc.entrypoint && svc.entrypoint !== "default") entry.entrypoint = svc.entrypoint;
    if (svc.ns) entry.ns = svc.ns;
    bindings[svc.binding] = entry;
  }

  const doList = wrapCli(() => parseDurableObjectsFromCfg(cfg, configRel));
  for (const durableObject of doList) {
    claimBinding(durableObject.binding);
    bindings[durableObject.binding] = {
      type: "do",
      className: durableObject.className,
    };
  }

  const workflows = wrapCli(() => parseWorkflowsFromCfg(cfg, configRel));
  for (const workflow of workflows) {
    claimBinding(workflow.binding);
  }

  const { producers: queueProducers, consumers: queueConsumers } = wrapCli(() =>
    parseQueues(cfg.queues, configRel)
  );
  for (const p of queueProducers) {
    claimBinding(p.binding);
    /** @type {{ type: string, id: string, deliveryDelaySeconds?: number }} */
    const binding = { type: "queue", id: p.queue };
    if (p.deliveryDelaySeconds != null) binding.deliveryDelaySeconds = p.deliveryDelaySeconds;
    bindings[p.binding] = binding;
  }

  const { exportsList, platformBindings } = wrapCli(() => ({
    exportsList: parseExportsFromCfg(cfg, configRel),
    platformBindings: parsePlatformBindingsFromCfg(cfg, configRel),
  }));
  for (const pb of platformBindings) {
    claimBinding(pb.binding);
  }

  const vars = normalizeVars(cfg.vars);
  for (const name of Object.keys(vars)) {
    claimBinding(name);
  }
  // A present-but-non-table [assets] is a config error, not "no assets": reject
  // it before bundling instead of letting asRecord() null it out and silently
  // skip assets.
  if (cfg.assets != null && asRecord(cfg.assets) == null) {
    throw new CliError(`${configRel}: [assets] must be a table`);
  }
  const outDir = path.join(absProject, ".deploy-dist");
  rmSync(outDir, { recursive: true, force: true });

  const wrangler = resolveWranglerCommand({ absProject, env });
  checkWranglerVersion({ execFile, cwd: absProject, env, wrangler });
  stdout(
    `[1/3] bundling via wrangler${envName ? ` (env=${escapeTerminalText(envName)})` : ""} → ` +
    `${escapeTerminalText(path.relative(cwd, outDir))}`
  );
  const tmpConfigPath = path.join(absProject, `${WRANGLER_WDL_TMP_PREFIX}-${randomUUID()}.json`);
  // resolveWranglerConfig already verified rawCfg is a plain object.
  const rawCfgObject = /** @type {Record<string, unknown>} */ (rawCfg);
  writeFileSync(tmpConfigPath, JSON.stringify({ ...rawCfgObject, name: "wdl-bundle-tmp" }), {
    flag: "wx",
  });
  const cleanupTempConfig = installTempFileCleanup(tmpConfigPath);
  let bundlingFailed = false;
  try {
    const wranglerArgs = [
      ...wrangler.args,
      "deploy",
      "--dry-run",
      `--outdir=${outDir}`,
      "--config",
      tmpConfigPath,
    ];
    if (envName) wranglerArgs.push("--env", envName);
    /** @type {import("node:child_process").ExecFileSyncOptions} */
    const wranglerOpts = {
      cwd: absProject,
      stdio: verbose ? "inherit" : ["ignore", "pipe", "pipe"],
      // Wrangler's arg parser requires CLOUDFLARE_API_TOKEN to be set even
      // on --dry-run. A dummy value satisfies the local parser without
      // passing the user's real token to the child process.
      env: wranglerChildEnv(env),
    };
    if (!verbose) {
      wranglerOpts.encoding = "utf8";
      wranglerOpts.maxBuffer = WRANGLER_OUTPUT_MAX_BUFFER;
    }
    execFile(wrangler.command, wranglerArgs, wranglerOpts);
    stdout("  bundled by wrangler");
  } catch (err) {
    bundlingFailed = true;
    throw new CliError(formatWranglerFailure(err));
  } finally {
    cleanupTempConfig({ ignoreErrors: bundlingFailed });
  }

  const modules = wrapCli(() => collectModules(outDir));
  const entryName = path.basename(String(cfg.main)).replace(/\.(ts|tsx|jsx|mjs|cjs|mts|cts)$/, ".js");
  if (!hasOwn(modules, entryName)) {
    throw new CliError(
      `wrangler output doesn't contain expected entry ${formatDiagnosticValue(entryName)} ` +
      `(from main=${formatDiagnosticValue(cfg.main)}). Found: ${Object.keys(modules).map(escapeTerminalText).join(", ")}`
    );
  }

  /** @type {WorkerManifest} */
  const manifest = { mainModule: entryName, modules };
  if (Object.keys(bindings).length) manifest.bindings = bindings;
  if (Object.keys(vars).length) manifest.vars = vars;
  if (cfg.compatibility_date) manifest.compatibilityDate = cfg.compatibility_date;
  if (cfg.compatibility_flags) manifest.compatibilityFlags = cfg.compatibility_flags;

  const routes = collectRoutes(cfg, configRel);
  if (routes.length) manifest.routes = routes;

  const crons = wrapCli(() => parseTriggers(cfg.triggers, configRel));
  if (crons.length) manifest.crons = crons;
  if (queueConsumers.length) manifest.queueConsumers = queueConsumers;
  if (workflows.length) manifest.workflows = workflows;

  if (exportsList.length) manifest.exports = exportsList;
  if (platformBindings.length) manifest.platformBindings = platformBindings;
  if (doList.length) {
    stderr(
      "note: Durable Object workers expose named WorkerEntrypoint classes only when listed in [[exports]]; " +
      "undeclared named exports are hidden to protect internal DO_BACKEND"
    );
  }

  const assetsCfg = asRecord(cfg.assets);
  const assetsDirRel = assetsCfg ? assetsCfg.directory : undefined;
  // Gate on "present", not truthy, so an empty/malformed directory reaches the
  // validator instead of being silently skipped.
  if (assetsDirRel !== undefined) {
    const assetsDir = wrapCli(() => resolveAssetsDir(absProject, assetsDirRel, configRel));
    /** @type {string[]} */
    const skippedAssets = [];
    const assets = wrapCli(() =>
      collectAssets(assetsDir, {
        // A trailing "/" marks a pruned directory — one entry can be a
        // whole subtree, so don't let the count read as a file count.
        onIgnore: (relPath, isDir) => skippedAssets.push(isDir ? `${relPath}/` : relPath),
      })
    );
    // Silent pruning would read as "covered everything" — say what was dropped.
    if (skippedAssets.length) {
      const shown = skippedAssets.slice(0, 5).map(escapeTerminalText).join(", ");
      const more = skippedAssets.length > 5 ? `, … ${skippedAssets.length - 5} more` : "";
      stderr(
        `note: assets: skipped ${skippedAssets.length} ignored ` +
        `${skippedAssets.length === 1 ? "entry" : "entries"} (${shown}${more}; ` +
        `a trailing / is a whole subtree); ` +
        `defaults and .assetsignore rules apply — re-include with a !pattern line`
      );
    }
    claimBinding("ASSETS");
    manifest.assets = assets;
  }

  return { absProject, workerName: cfg.name, manifest };
}

/**
 * @param {import("./wrangler/config.js").WranglerConfig} cfg
 * @param {string} configRel
 * @returns {string[]}
 */
export function collectRoutes(cfg, configRel) {
  configRel = escapeTerminalText(configRel);
  /** @type {string[]} */
  const collected = [];
  /**
   * @param {unknown} r
   * @param {string} source
   */
  const pushEntry = (r, source) => {
    if (typeof r === "string") collected.push(r);
    else if (r && typeof r === "object" && typeof (/** @type {Record<string, unknown>} */ (r).pattern) === "string") {
      collected.push(/** @type {string} */ (/** @type {Record<string, unknown>} */ (r).pattern));
    } else throw new CliError(`unsupported ${source} entry: ${formatDiagnosticValue(r)}`);
  };
  if (cfg.route !== undefined && cfg.routes !== undefined) {
    throw new CliError(`${configRel}: specify either "route" or "routes", not both`);
  }
  if (cfg.route !== undefined) pushEntry(cfg.route, "route");
  if (cfg.routes !== undefined) {
    // Loudly reject a non-array `routes` rather than silently dropping it (a
    // worker would deploy with no routes). Matches the other parsers' contract.
    if (!Array.isArray(cfg.routes)) {
      throw new CliError(`${configRel}: "routes" must be an array of strings or { pattern } tables`);
    }
    for (const r of cfg.routes) pushEntry(r, "routes");
  }
  return collected;
}

/**
 * @param {string} filePath
 * @param {{
 *   once(event: string, listener: () => void): unknown,
 *   off(event: string, listener: () => void): unknown,
 * }} [processLike]
 * @param {(signal: "SIGINT" | "SIGTERM") => void} [terminate]
 * @returns {(options?: { ignoreErrors?: boolean }) => void}
 */
export function installTempFileCleanup(
  filePath,
  processLike = process,
  terminate = (signal) => { process.kill(process.pid, signal); }
) {
  let active = true;
  /** @param {{ ignoreErrors: boolean }} options */
  const cleanup = ({ ignoreErrors }) => {
    try {
      rmSync(filePath, { force: true });
    } catch (err) {
      if (!ignoreErrors) throw err;
    }
  };
  const onExit = () => {
    // Best effort: this runs during process exit and must not mask the original
    // failure mode.
    cleanup({ ignoreErrors: true });
  };
  const uninstall = () => {
    if (!active) return;
    active = false;
    processLike.off("exit", onExit);
    processLike.off("SIGINT", onSigint);
    processLike.off("SIGTERM", onSigterm);
  };
  const handleSignal = (/** @type {"SIGINT" | "SIGTERM"} */ signal) => {
    // Best effort: do not interrupt signal propagation if cleanup itself fails.
    cleanup({ ignoreErrors: true });
    uninstall();
    terminate(signal);
  };
  const onSigint = () => handleSignal("SIGINT");
  const onSigterm = () => handleSignal("SIGTERM");
  processLike.once("exit", onExit);
  processLike.once("SIGINT", onSigint);
  processLike.once("SIGTERM", onSigterm);
  return ({ ignoreErrors = false } = {}) => {
    try {
      cleanup({ ignoreErrors });
    } finally {
      uninstall();
    }
  };
}

/**
 * @template T
 * @param {() => T} fn
 * @returns {T}
 */
function wrapCli(fn) {
  try {
    return fn();
  } catch (err) {
    if (err instanceof CliError) throw err;
    const message = err instanceof Error && err.message ? err.message : String(err);
    throw new CliError(message);
  }
}
