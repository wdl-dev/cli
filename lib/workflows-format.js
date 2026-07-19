import { escapeTerminalText, formatDiagnosticValue } from "./output.js";

/**
 * @typedef {object} WorkflowSummary
 * @property {string} [worker]
 * @property {string} [name]
 * @property {string | null} [binding]
 * @property {string} [className]
 * @property {string} [activeVersion]
 * @property {string} [workflowKey]
 * @property {boolean} [retired]
 */

/**
 * @typedef {object} WorkflowInstance
 * @property {string} [id]
 * @property {string} [status]
 */

/**
 * @typedef {object} WorkflowStep
 * @property {number} ordinal
 * @property {string} name
 * @property {string} status
 */

/** @param {unknown} value */
function field(value) {
  return value == null || value === "" ? "-" : escapeTerminalText(value);
}

/**
 * @param {{ workflows?: WorkflowSummary[] } | null | undefined} body
 * @returns {string[]}
 */
export function formatWorkflowList(body) {
  const workflows = Array.isArray(body?.workflows) ? body.workflows : [];
  if (workflows.length === 0) return ["(no workflows)"];
  return workflows.map((entry) =>
    `${field(entry.worker)}/${field(entry.name)}\tbinding=${field(entry.binding)}\tclass=${field(entry.className)}\tactive=${field(entry.activeVersion)}\tkey=${field(entry.workflowKey)}\tretired=${entry.retired ? "yes" : "no"}`
  );
}

/**
 * @param {{ instances?: WorkflowInstance[], cursor?: string } | null | undefined} body
 * @returns {string[]}
 */
export function formatInstanceList(body) {
  const instances = Array.isArray(body?.instances) ? body.instances : [];
  const lines = instances.length === 0
    ? ["(no workflow instances)"]
    : instances.map((entry) => `${field(entry.id)}\tstatus=${field(entry.status)}`);
  if (body?.cursor) lines.push(`Next cursor: ${escapeTerminalText(body.cursor)}`);
  return lines;
}

/**
 * @param {{
 *   id?: string,
 *   status?: string,
 *   output?: unknown,
 *   error?: unknown,
 *   steps?: { entries?: WorkflowStep[], truncated?: boolean },
 * }} body
 * @returns {string[]}
 */
export function formatInstanceStatus(body) {
  const lines = [`${field(body.id)}\tstatus=${field(body.status)}`];
  if (body.output !== undefined && body.output !== null) {
    lines.push(`output=${formatDiagnosticValue(body.output)}`);
  }
  if (body.error !== undefined && body.error !== null) {
    lines.push(`error=${formatDiagnosticValue(body.error)}`);
  }
  if (Array.isArray(body.steps?.entries)) {
    const suffix = body.steps.truncated ? " (truncated)" : "";
    lines.push(`steps=${body.steps.entries.length}${suffix}`);
    for (const step of body.steps.entries) {
      lines.push(`  #${escapeTerminalText(step.ordinal)} ${field(step.name)} status=${field(step.status)}`);
    }
  }
  return lines;
}
