import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { CliError, isPathInside } from "./common.js";
import { escapeTerminalText } from "./output.js";

/**
 * @param {Record<string, unknown>} values  Parsed flag values (`--sql`, `--file`).
 * @param {string} [cwd]
 * @returns {string}
 */
export function readSql(values, cwd = process.cwd()) {
  const hasSql = values.sql !== undefined;
  const hasFile = values.file !== undefined;
  if (hasSql && hasFile) throw new CliError("pass only one of --sql or --file");
  if (hasSql) return requireSqlText(values.sql, "--sql");
  if (hasFile) {
    if (typeof values.file !== "string" || !values.file) {
      throw new CliError("--file requires a path");
    }
    // Keep --file inside the project, like the migrations-dir checks — a
    // relative/absolute path must not pull SQL from outside the repo.
    if (!existsSync(cwd)) throw new CliError(`working directory ${escapeTerminalText(cwd)} does not exist`);
    const root = realpathSync(cwd);
    const candidate = path.resolve(root, values.file);
    const resolved = existsSync(candidate) ? realpathSync(candidate) : candidate;
    if (!isPathInside(root, resolved)) {
      throw new CliError("--file must stay inside the project");
    }
    let sql;
    try {
      sql = readFileSync(resolved, "utf8");
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : String(err);
      throw new CliError(`cannot read SQL file ${escapeTerminalText(values.file)}: ${escapeTerminalText(message)}`);
    }
    return requireSqlText(sql, "SQL file");
  }
  throw new CliError("d1 execute requires --sql <sql> or --file <path>");
}

/**
 * @param {unknown} sql
 * @param {string} source
 * @returns {string}
 */
function requireSqlText(sql, source) {
  if (typeof sql !== "string" || !sql.trim()) {
    throw new CliError(`${source} must contain non-empty SQL`);
  }
  return sql;
}

/**
 * @typedef {object} MigrationFile
 * @property {string} id
 * @property {string} name
 * @property {string} checksum
 * @property {string} sql
 */

/**
 * @param {string} [dir]
 * @returns {MigrationFile[]}
 */
export function readMigrationFiles(dir = "migrations") {
  const root = path.resolve(dir);
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    throw new CliError(`cannot read migrations dir ${escapeTerminalText(dir)}: ${escapeTerminalText(message)}`);
  }
  /** @type {string[]} */
  const filenames = [];
  for (const entry of entries) {
    if (!entry.name.endsWith(".sql")) continue;
    if (entry.isSymbolicLink()) {
      throw new CliError(`d1 migrations: ${escapeTerminalText(entry.name)} is a symlink; copy the SQL file into the migrations dir`);
    }
    if (entry.isFile()) filenames.push(entry.name);
  }
  return filenames
    .toSorted(compareMigrationFilenames)
    .map((filename) => readMigrationFile(root, filename))
    .filter(/** @returns {entry is MigrationFile} */ (entry) => entry != null);
}

/**
 * @param {string} root
 * @param {string} filename
 * @returns {MigrationFile | null}
 */
function readMigrationFile(root, filename) {
  const file = path.join(root, filename);
  try {
    const st = lstatSync(file);
    if (st.isSymbolicLink()) {
      throw new CliError(`d1 migrations: ${escapeTerminalText(filename)} is a symlink; copy the SQL file into the migrations dir`);
    }
    if (!st.isFile()) return null;
  } catch (err) {
    if (err instanceof CliError) throw err;
    throw migrationFileReadError(filename, err);
  }
  let sql;
  try {
    sql = readFileSync(file, "utf8");
  } catch (err) {
    throw migrationFileReadError(filename, err);
  }
  return {
    id: filename,
    name: filename.replace(/\.sql$/i, ""),
    checksum: createHash("sha256").update(sql).digest("hex"),
    sql,
  };
}

/**
 * @param {string} filename
 * @param {unknown} err
 * @returns {CliError}
 */
function migrationFileReadError(filename, err) {
  const message = err instanceof Error && err.message ? err.message : String(err);
  return new CliError(`cannot read migration file ${escapeTerminalText(filename)}: ${escapeTerminalText(message)}`);
}

// Order by the numeric prefix when both names have one ("2_x.sql" before
// "10_y.sql" even without zero-padding); fall back to lexicographic so
// non-numeric names keep plain string order. String-compare the trimmed
// digits to stay exact beyond Number's integer precision.
/**
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function compareMigrationFilenames(a, b) {
  const numA = /^\d+/.exec(a);
  const numB = /^\d+/.exec(b);
  if (numA && numB) {
    const trimmedA = numA[0].replace(/^0+(?=\d)/, "");
    const trimmedB = numB[0].replace(/^0+(?=\d)/, "");
    if (trimmedA.length !== trimmedB.length) return trimmedA.length - trimmedB.length;
    if (trimmedA !== trimmedB) return trimmedA < trimmedB ? -1 : 1;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}
