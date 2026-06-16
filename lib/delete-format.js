import { formatKnownWarning } from "./output.js";

const ASSET_WARNING_KEYS = [
  "code",
  "message",
  "path",
  "key",
  "prefix",
  "reason",
];

export function formatVersionDelete(body) {
  const lines = [`OK ${body.namespace}/${body.name}@${body.version} deleted`];
  appendAssetsSummary(lines, body.assets);
  return lines;
}

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
  if (Number.isFinite(body.queueConsumersRemoved) && body.queueConsumersRemoved > 0) {
    lines.push(`  queue consumers removed: ${body.queueConsumersRemoved}`);
  }
  appendAssetsSummary(lines, body.assets);
  return lines;
}

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
  if (Number.isFinite(body.queueConsumersRemoved) && body.queueConsumersRemoved > 0) {
    lines.push(`  queue consumers removed: ${body.queueConsumersRemoved}`);
  }
  appendBlockers(lines, body.blockers);
  return lines;
}

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
        blocker.crossNamespaceReferrerCount > 0) {
      lines.push(`      cross-namespace referrers: ${blocker.crossNamespaceReferrerCount}`);
    }
  }
}
