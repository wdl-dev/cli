import { escapeTerminalText } from "./output.js";

/**
 * @typedef {object} D1Database
 * @property {string} [databaseId]
 * @property {string} [databaseName]
 * @property {string} [createdAt]
 */

/**
 * @typedef {object} D1Migration
 * @property {string} [id]
 * @property {string} [appliedAt]
 * @property {string} [checksum]
 * @property {string} [state]
 * @property {number} [statementCount]
 */

/**
 * @param {{ databases?: D1Database[] }} body
 * @returns {string[]}
 */
export function formatD1List(body) {
  const databases = Array.isArray(body.databases) ? body.databases : [];
  if (databases.length === 0) return ["(no d1 databases)"];
  return databases.map(
    (db) => `${cell(db.databaseId)}\tname=${cell(db.databaseName || "-")}\tcreated=${cell(db.createdAt || "-")}`
  );
}

/**
 * @param {{ result?: unknown }} body
 * @returns {string[]}
 */
export function formatD1Execute(body) {
  return [JSON.stringify(body.result, null, 2)];
}

/**
 * @param {{ migrations?: D1Migration[] }} body
 * @returns {string[]}
 */
export function formatD1MigrationList(body) {
  const migrations = Array.isArray(body.migrations) ? body.migrations : [];
  if (migrations.length === 0) return ["(no d1 migrations applied)"];
  return migrations.map(
    (migration) =>
      `${cell(migration.id)}\tapplied=${cell(migration.appliedAt || "-")}\tchecksum=${cell(migration.checksum || "-")}`
  );
}

/**
 * @param {{ migrations?: D1Migration[] }} body
 * @returns {string[]}
 */
export function formatD1MigrationStatus(body) {
  const migrations = Array.isArray(body.migrations) ? body.migrations : [];
  if (migrations.length === 0) return ["(no local migrations)"];
  return migrations.map(
    (migration) => `${cell(migration.id)}\tstate=${cell(migration.state)}\tapplied=${cell(migration.appliedAt || "-")}`
  );
}

/**
 * @param {{ applied?: D1Migration[], skipped?: D1Migration[] }} body
 * @returns {string[]}
 */
export function formatD1MigrationApply(body) {
  const applied = Array.isArray(body.applied) ? body.applied : [];
  const skipped = Array.isArray(body.skipped) ? body.skipped : [];
  if (applied.length === 0 && skipped.length === 0) return ["(no migrations applied)"];
  return [
    ...applied.map((migration) => `Applied ${cell(migration.id)}\tstatements=${cell(migration.statementCount ?? "-")}`),
    ...skipped.map((migration) => `Skipped ${cell(migration.id)}\talready applied`),
  ];
}
/** @param {unknown} value */
const cell = (value) => escapeTerminalText(String(value));
