// Shell out to wrangler dry-run so local bundling stays aligned with
// `wrangler dev` / Wrangler's own module resolution pipeline.

import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { CliError } from "./common.js";
import { escapeTerminalText } from "./output.js";
import {
  RESERVED_OBJECT_KEYS,
  WDL_RESERVED_BINDING_RE,
} from "./ns-pattern.js";
import { collectAssets, resolveAssetsDir } from "./wrangler/assets.js";
import {
  assertNotRuntimeReservedBinding,
  assertValidBindingName,
  parseD1DatabasesFromCfg,
  parseDurableObjectsFromCfg,
  parseExportsFromCfg,
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
  loadWranglerConfig,
  resolveWranglerConfig,
  validateUnsupportedWranglerConfig,
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
  loadWranglerConfig,
  parseJsonc,
  resolveWranglerConfig,
  stripJsonComments,
  stripTrailingCommas,
  validateUnsupportedWranglerConfig,
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
 * @property {Array<{ name: string, binding: string, className: unknown }>} [workflows]
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
      throw new CliError(`[vars] ${name}: name is reserved for runtime-internal bindings`);
    }
    if (RESERVED_OBJECT_KEYS.has(name)) {
      throw new CliError(`[vars] ${name}: name is a reserved Object.prototype key`);
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") {
      throw new CliError(`[vars] ${name}: only string/number/boolean values are supported`);
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
  const { cfg, envName } = wrapCli(() => {
    validateUnsupportedWranglerConfig(rawCfg, selectedEnv, configRel);
    return resolveWranglerConfig(rawCfg, selectedEnv, configRel);
  });
  if (!cfg.name) throw new CliError(`${configRel} missing 'name'`);
  if (!cfg.main) throw new CliError(`${configRel} missing 'main'`);

  const bindings = manifestMap();
  // Every name a worker binds (manifest bindings, workflows, platform
  // bindings) shares the runtime env namespace; claim each one exactly once.
  /** @type {Set<string>} */
  const claimedBindings = new Set();
  /** @param {string} name */
  const claimBinding = (name) => {
    if (claimedBindings.has(name)) throw new CliError(`binding name collision: ${name}`);
    claimedBindings.add(name);
  };

  const kvList = /** @type {Array<{binding?: string, id?: string}>} */ (cfg.kv_namespaces || []);
  for (const kv of kvList) {
    if (!kv.binding || !kv.id) throw new CliError("[[kv_namespaces]] entry needs both 'binding' and 'id'");
    wrapCli(() => assertValidBindingName(configRel, "[[kv_namespaces]]", kv.binding));
    assertNotRuntimeReservedBinding(configRel, "[[kv_namespaces]]", kv.binding);
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
    /** @type {{ type: string, service: unknown, entrypoint?: unknown, ns?: unknown }} */
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
  const outDir = path.join(absProject, ".deploy-dist");
  rmSync(outDir, { recursive: true, force: true });

  const wrangler = resolveWranglerCommand({ absProject, env });
  checkWranglerVersion({ execFile, cwd: absProject, env, wrangler });
  stdout(
    `[1/3] bundling via wrangler${envName ? ` (env=${envName})` : ""} → ` +
    `${path.relative(cwd, outDir)}`
  );
  const tmpConfigPath = path.join(absProject, `.wrangler.wdl-tmp-${randomUUID()}.json`);
  // resolveWranglerConfig already verified rawCfg is a plain object.
  const rawCfgObject = /** @type {Record<string, unknown>} */ (rawCfg);
  writeFileSync(tmpConfigPath, JSON.stringify({ ...rawCfgObject, name: "wdl-bundle-tmp" }), {
    flag: "wx",
  });
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
    throw new CliError(formatWranglerFailure(err));
  } finally {
    rmSync(tmpConfigPath, { force: true });
  }

  const modules = wrapCli(() => collectModules(outDir));
  const entryName = path.basename(String(cfg.main)).replace(/\.(ts|tsx|jsx|mjs|cjs|mts|cts)$/, ".js");
  if (!hasOwn(modules, entryName)) {
    throw new CliError(
      `wrangler output doesn't contain expected entry "${entryName}" (from main="${cfg.main}"). Found: ${Object.keys(modules).join(", ")}`
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
    if (Object.keys(assets).length) manifest.assets = assets;
  }

  // `name` was asserted present above and is a string by wrangler's schema.
  return { absProject, workerName: /** @type {string} */ (cfg.name), manifest };
}

/**
 * @param {import("./wrangler/config.js").WranglerConfig} cfg
 * @param {string} configRel
 * @returns {string[]}
 */
export function collectRoutes(cfg, configRel) {
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
    } else throw new CliError(`unsupported ${source} entry: ${JSON.stringify(r)}`);
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
