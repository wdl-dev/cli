import path from "node:path";
import { existsSync, realpathSync } from "node:fs";
import { readMigrationFiles, readSql } from "../lib/d1-files.js";
import {
  formatWranglerConfigShadowWarning,
  loadWranglerConfig,
  parseD1DatabasesFromCfg,
  resolveWranglerConfig,
} from "../lib/wrangler-pack.js";
import {
  formatD1Execute,
  formatD1List,
  formatD1MigrationApply,
  formatD1MigrationList,
  formatD1MigrationStatus,
} from "../lib/d1-format.js";
import { LONG_CONTROL_TIMEOUT_MS } from "../lib/control-fetch.js";
import { defineCommand } from "../lib/command.js";
import { CliError, defineCliOption, formatHelp, isMain, isPathInside, optionHelp, unexpectedArgument } from "../lib/common.js";
import { confirmAction } from "../lib/stdin.js";
import { escapeTerminalText, formatDiagnosticValue, writeResult } from "../lib/output.js";

const D1_EXECUTE_MODES = ["all", "raw", "run", "exec"];

const D1_OPTIONS = [
  defineCliOption("sql", { type: "string" }, "--sql <sql>", "SQL text for execute."),
  defineCliOption("file", { type: "string" }, "--file <path>", "SQL file for execute."),
  defineCliOption("mode", { type: "string" }, "--mode <mode>", "Execute mode: all, raw, run, or exec."),
  defineCliOption("params", { type: "string" }, "--params <json>", "JSON array of query parameters."),
  defineCliOption("dir", { type: "string" }, "--dir <path>", "Migrations directory."),
  defineCliOption("env", { type: "string" }, "--env <name>", "Wrangler environment for migration config lookup."),
  defineCliOption("yes", { type: "boolean" }, "--yes", "Skip D1 delete confirmation."),
  "ns",
  "control",
  "json",
  "help",
];

const command = defineCommand({
  name: "d1",
  summary: "Manage D1 databases, SQL execution, and migrations.",
  options: D1_OPTIONS,
  usage: usageText,
  run: runD1,
});

export const main = command.main;
export const runD1Command = command.run;
export const meta = command.meta;

/**
 * @typedef {import("../lib/command.js").PresetFlags<"ns" | "control" | "json"> & {
 *   sql?: string,
 *   file?: string,
 *   mode?: string,
 *   params?: string,
 *   dir?: string,
 *   env?: string,
 *   yes?: boolean,
 * }} D1Flags
 */

/** @param {{ values: D1Flags, positionals: string[], context: import("../lib/command.js").CommandContext }} arg */
async function runD1({ values, positionals, context }) {
  const { stdout, stderr, stdin } = context;

  const [subcommand, firstArg] = positionals;
  const ns = context.resolveNamespace();
  if (!subcommand || !ns) throw new CliError(usageText());

  if (subcommand === "migrations") {
    const action = firstArg;
    const databaseRef = positionals[2];
    const extraArg = positionals[3];
    if (!action || !databaseRef) {
      throw new CliError("d1 migrations requires <list|status|apply> <databaseName|databaseId>");
    }
    if (extraArg) throw unexpectedArgument(`d1 migrations ${action}`, extraArg);
    await runMigrationsCommand({ action, databaseRef, context });
    return;
  }

  if (subcommand === "list") {
    if (firstArg) throw unexpectedArgument("d1 list", firstArg);
    const { headers } = context.resolveControl();
    const body = /** @type {Parameters<typeof formatD1List>[0]} */ (
      await context.fetchJson(context.nsUrl("d1", "databases"), { headers }, "list d1 databases")
    );
    writeResult(values.json === true, body, () => formatD1List(body), stdout);
    return;
  }

  if (subcommand === "create") {
    const databaseName = firstArg;
    if (!databaseName) throw new CliError("d1 create requires <databaseName>");
    if (positionals[2]) throw unexpectedArgument("d1 create", positionals[2]);
    const { headers } = context.resolveControl();
    const body = /** @type {{ namespace?: string, databaseId?: string, databaseName?: string }} */ (
      await context.fetchJson(context.nsUrl("d1", "databases"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          databaseName,
        }),
      }, "create d1 database")
    );
    writeResult(values.json === true, body, () => [
      `OK ${body.namespace}/${body.databaseId} created name=${body.databaseName || "-"}`,
    ], stdout);
    return;
  }

  if (subcommand === "delete") {
    const databaseRef = firstArg;
    if (!databaseRef) throw new CliError("d1 delete requires <databaseName|databaseId>");
    if (positionals[2]) throw unexpectedArgument("d1 delete", positionals[2]);
    const { headers } = context.resolveControl();
    await confirmAction({
      yes: values.yes === true,
      stdin,
      stderr,
      prompt: `Are you sure you want to delete D1 database "${ns}/${databaseRef}"? [y/N] `,
      action: `delete D1 database "${ns}/${databaseRef}"`,
    });
    const body = /** @type {{ namespace?: string, databaseId?: string }} */ (
      await context.fetchJson(context.nsUrl("d1", "databases", databaseRef), {
        method: "DELETE",
        headers,
      }, "delete d1 database")
    );
    writeResult(values.json === true, body, () => [
      `OK ${body.namespace}/${body.databaseId} deleted`,
    ], stdout);
    return;
  }

  if (subcommand === "execute") {
    const databaseRef = firstArg;
    if (!databaseRef) throw new CliError("d1 execute requires <databaseName|databaseId>");
    if (positionals[2]) throw unexpectedArgument("d1 execute", positionals[2]);
    const sql = readSql(values, context.cwd);
    const mode = values.mode || "all";
    if (!D1_EXECUTE_MODES.includes(mode)) {
      throw new CliError(`--mode must be one of ${D1_EXECUTE_MODES.join(", ")}`);
    }
    /** @type {unknown[] | undefined} */
    let params;
    if (values.params !== undefined) {
      if (mode === "exec") {
        throw new CliError("--mode exec does not accept --params");
      }
      /** @type {unknown} */
      let parsed;
      try {
        parsed = JSON.parse(values.params);
      } catch {
        throw new CliError("--params must be a JSON array");
      }
      if (!Array.isArray(parsed)) throw new CliError("--params must be a JSON array");
      params = parsed;
    }
    const { headers } = context.resolveControl();
    const body = /** @type {Parameters<typeof formatD1Execute>[0]} */ (
      await context.fetchJson(context.nsUrl("d1", "databases", databaseRef, "query"), {
        method: "POST",
        headers,
        body: JSON.stringify({
          sql,
          mode,
          ...(params ? { params } : {}),
        }),
        timeoutMs: LONG_CONTROL_TIMEOUT_MS,
      }, "execute d1 query")
    );
    writeResult(values.json === true, body, () => formatD1Execute(body), stdout);
    return;
  }

  throw new CliError(`unknown d1 subcommand: ${escapeTerminalText(subcommand)}\n${usageText()}`);
}

/** @param {{ action: string, databaseRef: string, context: import("../lib/command.js").CommandContext }} arg */
async function runMigrationsCommand({ action, databaseRef, context }) {
  const { env, stdout, cwd, warn } = context;
  const values = /** @type {D1Flags} */ (context.values);
  if (!["list", "status", "apply"].includes(action)) {
    throw new CliError(`unknown d1 migrations subcommand: ${escapeTerminalText(action)}`);
  }
  const { headers } = context.resolveControl();
  const migrationsBase = context.nsUrl("d1", "databases", databaseRef, "migrations");

  if (action === "list") {
    const body = /** @type {Parameters<typeof formatD1MigrationList>[0]} */ (
      await context.fetchJson(migrationsBase, { headers }, "list d1 migrations")
    );
    writeResult(values.json === true, body, () => formatD1MigrationList(body), stdout);
    return;
  }

  if (action === "status") {
    const migrations = loadLocalMigrations({ values, env, cwd, databaseRef, warn });
    const body = /** @type {Parameters<typeof formatD1MigrationStatus>[0]} */ (
      await context.fetchJson(`${migrationsBase}/status`, {
        method: "POST",
        headers,
        body: serializeMigrationStatusRequest(migrations),
      }, "show d1 migration status")
    );
    writeResult(values.json === true, body, () => formatD1MigrationStatus(body), stdout);
    return;
  }

  if (action === "apply") {
    const migrations = loadLocalMigrations({ values, env, cwd, databaseRef, warn });
    const body = /** @type {Parameters<typeof formatD1MigrationApply>[0]} */ (
      await context.fetchJson(`${migrationsBase}/apply`, {
        method: "POST",
        headers,
        body: JSON.stringify({ migrations }),
        timeoutMs: LONG_CONTROL_TIMEOUT_MS,
      }, "apply d1 migrations")
    );
    writeResult(values.json === true, body, () => formatD1MigrationApply(body), stdout);
    return;
  }
}

/**
 * @param {import("../lib/d1-files.js").MigrationFile[]} migrations
 * @returns {string}
 */
export function serializeMigrationStatusRequest(migrations) {
  return JSON.stringify({ migrations: migrations.map(({ sql: _sql, ...rest }) => rest) });
}

/**
 * @typedef {{ values: D1Flags, env: NodeJS.ProcessEnv, cwd: string, databaseRef: string, warn?: (line: string) => void }} MigrationsDirArgs
 */

/**
 * A single `[[d1_databases]]` table entry as read from a parsed Wrangler config.
 * @typedef {object} D1DatabaseEntry
 * @property {string} [binding]
 * @property {string} [database_id]
 * @property {string} [database_name]
 * @property {string} [migrations_dir]
 */

// status and apply share the same local-migrations contract: resolve the dir,
// read the .sql files, and fail loudly on an empty/mis-pointed dir.
/** @param {MigrationsDirArgs} arg */
function loadLocalMigrations({ values, env, cwd, databaseRef, warn }) {
  const { dir, display } = resolveMigrationsDir({ values, env, cwd, databaseRef, warn });
  const migrations = readMigrationFiles(dir);
  if (migrations.length === 0) {
    throw new CliError(`no .sql migration files found in ${escapeTerminalText(display)}`);
  }
  return migrations;
}

/**
 * @param {MigrationsDirArgs} arg
 * @returns {{ dir: string, display: string }}
 */
function resolveMigrationsDir({ values, env, cwd, databaseRef, warn }) {
  if (values.dir) {
    return {
      dir: resolveExplicitMigrationsDir({ cwd, dir: values.dir }),
      display: values.dir,
    };
  }

  const fallback = {
    dir: path.resolve(cwd, "migrations"),
    display: "migrations",
  };

  let loaded;
  try {
    loaded = loadWranglerConfig(cwd);
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    if (message.startsWith("no wrangler.")) {
      return fallback;
    }
    throw new CliError(message);
  }

  const shadowWarning = formatWranglerConfigShadowWarning(loaded);
  if (shadowWarning) warn?.(`warning: ${shadowWarning}`);

  const configRel = path.basename(loaded.path);
  const selectedEnv = values.env || env.CLOUDFLARE_ENV || null;
  /** @type {{ d1_databases?: unknown }} */
  let cfg;
  let d1Bindings;
  try {
    ({ cfg } = resolveWranglerConfig(loaded.cfg, selectedEnv, configRel));
    d1Bindings = parseD1DatabasesFromCfg(cfg, configRel);
  } catch (err) {
    throw new CliError(err instanceof Error && err.message ? err.message : String(err));
  }
  if (d1Bindings.length === 0) return fallback;

  const entries = /** @type {D1DatabaseEntry[]} */ (cfg.d1_databases);
  /** @type {D1DatabaseEntry[]} */
  const byId = [];
  /** @type {D1DatabaseEntry[]} */
  const byName = [];
  for (const [idx, entry] of entries.entries()) {
    if (entry.migrations_dir != null && (typeof entry.migrations_dir !== "string" || !entry.migrations_dir.trim())) {
      throw new CliError(`${escapeTerminalText(configRel)}: [[d1_databases]] ${escapeTerminalText(entry.binding || idx)}: migrations_dir must be a string`);
    }
    if (entry.database_id === databaseRef) {
      byId.push(entry);
      continue;
    }
    if (entry.database_name === databaseRef) {
      byName.push(entry);
    }
  }
  const matches = byId.length > 0 ? byId : byName;

  if (matches.length > 1) {
    throw new CliError(`${escapeTerminalText(configRel)}: multiple [[d1_databases]] entries match ${formatDiagnosticValue(databaseRef)}`);
  }
  if (matches.length === 0) {
    throw new CliError(
      `${escapeTerminalText(configRel)}: no matching [[d1_databases]] entry for ${formatDiagnosticValue(databaseRef)}; ` +
      "use a configured database_name/database_id or pass --dir explicitly"
    );
  }

  const migrationsDir = matches[0].migrations_dir;
  if (migrationsDir == null) return fallback;
  const dir = resolveConfiguredMigrationsDir({
    configDir: path.dirname(loaded.path),
    migrationsDir,
    configRel,
    binding: matches[0].binding,
  });
  return {
    dir,
    display: migrationsDir,
  };
}

/**
 * @param {{ cwd: string, dir: string }} arg
 * @returns {string}
 */
function resolveExplicitMigrationsDir({ cwd, dir }) {
  const root = realpathSync(cwd);
  const candidate = path.resolve(root, dir);
  const resolved = existsSync(candidate) ? realpathSync(candidate) : candidate;
  if (!isPathInside(root, resolved)) {
    throw new CliError("--dir must stay inside the project");
  }
  return resolved;
}

/**
 * @param {{ configDir: string, migrationsDir: string, configRel: string, binding: string | undefined }} arg
 * @returns {string}
 */
function resolveConfiguredMigrationsDir({ configDir, migrationsDir, configRel, binding }) {
  const root = realpathSync(configDir);
  const candidate = path.resolve(root, migrationsDir);
  const resolved = existsSync(candidate) ? realpathSync(candidate) : candidate;
  if (!isPathInside(root, resolved)) {
    throw new CliError(
      `${escapeTerminalText(configRel)}: [[d1_databases]] ${escapeTerminalText(binding)}: ` +
      `migrations_dir must stay inside the project (got ${formatDiagnosticValue(migrationsDir)})`
    );
  }
  return resolved;
}


function usageText() {
  return formatHelp({
    usage: [
      "wdl d1 create [options] <databaseName>",
      "wdl d1 list [options]",
      "wdl d1 delete [options] <databaseName|databaseId>",
      "wdl d1 execute [options] <databaseName|databaseId> (--sql <sql> | --file <path>)",
      "wdl d1 migrations <list|status|apply> [options] <databaseName|databaseId>",
    ],
    description: "Manage platform D1 databases, execute SQL, and apply forward-only migrations.",
    options: optionHelp(D1_OPTIONS),
  });
}

if (isMain(import.meta.url)) {
  await main();
}
