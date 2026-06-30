// Human-readable rendering for `wdl workers`.

/**
 * @typedef {object} WorkerSummary
 * @property {string} [name]
 * @property {string[]} [versions]
 * @property {string | null} [activeVersion]  null when the worker has no deployed version.
 * @property {boolean} [hasSecrets]
 */

/**
 * @param {{ workers?: WorkerSummary[] }} body
 * @returns {string[]}
 */
export function formatWorkersList(body) {
  const workers = Array.isArray(body.workers) ? body.workers : [];
  if (workers.length === 0) return ["(no workers)"];
  return workers.map((w) => {
    const versions = Array.isArray(w.versions) && w.versions.length
      ? w.versions.join(",")
      : "-";
    const active = w.activeVersion || "-";
    const secrets = w.hasSecrets ? "yes" : "no";
    return `${w.name}\tactive=${active}\tversions=${versions}\tsecrets=${secrets}`;
  });
}
