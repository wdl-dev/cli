import { formatKnownWarning } from "./output.js";

const ASSET_WARNING_KEYS = [
  "code",
  "message",
  "path",
  "key",
  "prefix",
  "reason",
];

/**
 * @typedef {object} DeleteAssetsSummary
 * @property {boolean} [skippedSharedPrefix]
 * @property {unknown[]} [warnings]
 */

/**
 * @typedef {object} DeleteBlockerReferrer
 * @property {string} [callerNs]
 * @property {string} [callerWorker]
 * @property {string} [callerVersion]
 * @property {string} [binding]
 */

/**
 * @typedef {object} DeleteBlocker
 * @property {string} [version]
 * @property {DeleteBlockerReferrer[]} [referrers]
 * @property {number} [crossNamespaceReferrerCount]
 */

/**
 * @typedef {object} VersionDeleteBody
 * @property {string} [namespace]
 * @property {string} [name]
 * @property {string} [version]
 * @property {DeleteAssetsSummary} [assets]
 */

/**
 * @typedef {object} WorkerDeleteBody
 * @property {string} [namespace]
 * @property {string} [name]
 * @property {boolean} [dryRun]
 * @property {boolean} [deleted]
 * @property {boolean} [noop]
 * @property {boolean} [hasWorkerSecrets]
 * @property {string[]} [versionsDeleted]
 * @property {string} [activeDeleted]
 * @property {string[]} [affectedHosts]
 * @property {number} [queueConsumersRemoved]
 * @property {DeleteBlocker[]} [blockers]
 * @property {DeleteAssetsSummary} [assets]
 */

/**
 * @param {VersionDeleteBody} body
 * @returns {string[]}
 */
export function formatVersionDelete(body) {
  const lines = [`OK ${body.namespace}/${body.name}@${body.version} deleted`];
  appendAssetsSummary(lines, body.assets);
  return lines;
}

/**
 * @param {WorkerDeleteBody} body
 * @returns {string[]}
 */
export function formatWorkerDelete(body) {
  if (body.dryRun) return formatDryRun(body);
  if (!body.deleted) {
    return [`(${body.namespace}/${body.name} had no worker-owned state)`];
  }

  const versions = Array.isArray(body.versionsDeleted) && body.versionsDeleted.length
    ? body.versionsDeleted.join(",")
    : "-";
  const active = body.activeDeleted || "-";
  const lines = [
    `OK ${body.namespace}/${body.name} deleted active=${active} versions=${versions}`,
  ];
  if (Array.isArray(body.affectedHosts) && body.affectedHosts.length) {
    lines.push(`  affected hosts: ${body.affectedHosts.join(",")}`);
  }
  if (Number.isFinite(body.queueConsumersRemoved) && Number(body.queueConsumersRemoved) > 0) {
    lines.push(`  queue consumers removed: ${body.queueConsumersRemoved}`);
  }
  appendAssetsSummary(lines, body.assets);
  return lines;
}

/**
 * @param {WorkerDeleteBody} body
 * @returns {string[]}
 */
function formatDryRun(body) {
  const versions = Array.isArray(body.versionsDeleted) && body.versionsDeleted.length
    ? body.versionsDeleted.join(",")
    : "-";
  const active = body.activeDeleted || "-";
  const lines = [
    `DRY RUN ${body.namespace}/${body.name} wouldDelete=${body.deleted ? "yes" : "no"} active=${active} versions=${versions}`,
  ];
  if (body.noop) lines.push("  no worker-owned state found");
  if (body.hasWorkerSecrets) lines.push("  worker secrets would be deleted");
  if (Array.isArray(body.affectedHosts) && body.affectedHosts.length) {
    lines.push(`  affected hosts: ${body.affectedHosts.join(",")}`);
  }
  if (Number.isFinite(body.queueConsumersRemoved) && Number(body.queueConsumersRemoved) > 0) {
    lines.push(`  queue consumers removed: ${body.queueConsumersRemoved}`);
  }
  appendBlockers(lines, body.blockers);
  return lines;
}

/**
 * @param {string[]} lines
 * @param {DeleteAssetsSummary | undefined} assets
 * @returns {void}
 */
function appendAssetsSummary(lines, assets) {
  if (!assets) return;
  if (assets.skippedSharedPrefix) {
    lines.push("  assets cleanup skipped: prefix is still referenced by another retained version");
  }
  const warnings = Array.isArray(assets.warnings) ? assets.warnings : [];
  for (const warning of warnings) {
    lines.push(`  warning: ${formatKnownWarning(warning, ASSET_WARNING_KEYS)}`);
  }
}

/**
 * @param {string[]} lines
 * @param {DeleteBlocker[] | undefined} blockers
 * @returns {void}
 */
function appendBlockers(lines, blockers) {
  if (!Array.isArray(blockers) || blockers.length === 0) return;
  lines.push("  blockers:");
  for (const blocker of blockers) {
    lines.push(`    version ${blocker.version}:`);
    const refs = Array.isArray(blocker.referrers) ? blocker.referrers : [];
    for (const ref of refs) {
      lines.push(
        `      ${ref.callerNs}/${ref.callerWorker}@${ref.callerVersion} binding=${ref.binding}`
      );
    }
    if (Number.isFinite(blocker.crossNamespaceReferrerCount) &&
        Number(blocker.crossNamespaceReferrerCount) > 0) {
      lines.push(`      cross-namespace referrers: ${blocker.crossNamespaceReferrerCount}`);
    }
  }
}
