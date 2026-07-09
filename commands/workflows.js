import { defineCommand } from "../lib/command.js";
import { CliError, defineCliOption, formatHelp, isMain, optionHelp, unexpectedArgument } from "../lib/common.js";
import { confirmAction } from "../lib/stdin.js";
import { escapeTerminalText, writeResult } from "../lib/output.js";
import {
  formatInstanceList,
  formatInstanceStatus,
  formatWorkflowList,
} from "../lib/workflows-format.js";

const LIFECYCLE_ACTIONS = new Set(["pause", "resume", "restart", "terminate"]);
const WORKFLOW_OPTIONS = [
  defineCliOption("limit", { type: "string" }, "--limit <n>", "Instance page size (default 100, max 1000)."),
  defineCliOption("cursor", { type: "string" }, "--cursor <cursor>", "Opaque instances pagination cursor."),
  defineCliOption("include-steps", { type: "boolean" }, "--include-steps", "Include bounded step history in status output."),
  defineCliOption("step-limit", { type: "string" }, "--step-limit <n>", "Step history page size (default 100, max 1000)."),
  defineCliOption("yes", { type: "boolean" }, "--yes", "Confirm restart or terminate."),
  "ns",
  "control",
  "json",
  "help",
];

const command = defineCommand({
  name: "workflows",
  summary: "Inspect and control Workflow instances.",
  options: WORKFLOW_OPTIONS,
  usage: usageText,
  run: runWorkflows,
});

export const main = command.main;
export const runWorkflowsCommand = command.run;
export const meta = command.meta;

/** @param {{ values: import("../lib/command.js").PresetFlags<"ns" | "control" | "json"> & { limit?: string, cursor?: string, "include-steps"?: boolean, "step-limit"?: string, yes?: boolean }, positionals: string[], context: import("../lib/command.js").CommandContext }} arg */
async function runWorkflows({ values, positionals, context }) {
  const { stdout, stderr, stdin } = context;

  const [subcommand] = positionals;
  const ns = context.resolveNamespace();
  if (!subcommand || !ns) throw new CliError(usageText());

  if (subcommand === "list") {
    requireNoExtraPositionals(positionals, 1, "workflows list");
    const { headers } = context.resolveControl();
    const body = /** @type {{ workflows?: import("../lib/workflows-format.js").WorkflowSummary[] }} */ (
      await context.fetchJson(context.nsUrl("workflows"), { headers }, "list workflows")
    );
    writeResult(Boolean(values.json), body, () => formatWorkflowList(body), stdout);
    return;
  }

  if (subcommand === "instances") {
    const { worker, workflow } = requireWorkflowRef(positionals, "workflows instances");
    const { headers } = context.resolveControl();
    const url = new URL(context.nsUrl("workflows", worker, workflow, "instances"));
    if (values.limit) url.searchParams.set("limit", values.limit);
    if (values.cursor) url.searchParams.set("cursor", values.cursor);
    const body = /** @type {{ instances?: import("../lib/workflows-format.js").WorkflowInstance[], cursor?: string }} */ (
      await context.fetchJson(url.href, { headers }, "list workflow instances")
    );
    writeResult(Boolean(values.json), body, () => formatInstanceList(body), stdout);
    return;
  }

  if (subcommand === "status") {
    const { worker, workflow, instanceId } = requireInstanceRef(positionals, "workflows status");
    if (values["step-limit"] && !values["include-steps"]) {
      throw new CliError("workflows status --step-limit requires --include-steps");
    }
    const { headers } = context.resolveControl();
    const url = new URL(context.nsUrl("workflows", worker, workflow, "instances", instanceId));
    if (values["include-steps"]) url.searchParams.set("includeSteps", "true");
    if (values["step-limit"]) url.searchParams.set("stepLimit", values["step-limit"]);
    const body = /** @type {Parameters<typeof formatInstanceStatus>[0]} */ (
      await context.fetchJson(url.href, { headers }, "get workflow instance status")
    );
    writeResult(Boolean(values.json), body, () => formatInstanceStatus(body), stdout);
    return;
  }

  if (LIFECYCLE_ACTIONS.has(subcommand)) {
    const { worker, workflow, instanceId } = requireInstanceRef(positionals, `workflows ${subcommand}`);
    const { headers } = context.resolveControl();
    if (subcommand === "restart" || subcommand === "terminate") {
      await confirmAction({
        yes: values.yes === true,
        stdin,
        stderr,
        prompt: `Are you sure you want to ${subcommand} workflow instance "${ns}/${worker}/${workflow}/${instanceId}"? [y/N] `,
        action: `${subcommand} workflow instance "${ns}/${worker}/${workflow}/${instanceId}"`,
      });
    }
    const body = /** @type {{ id?: string, status?: string }} */ (await context.fetchJson(
      context.nsUrl("workflows", worker, workflow, "instances", instanceId, subcommand),
      { method: "POST", headers },
      `${subcommand} workflow instance`,
    ));
    writeResult(Boolean(values.json), body, () => [
      `OK ${ns}/${worker}/${workflow}/${body.id || instanceId} ${subcommand} status=${body.status || "-"}`,
    ], stdout);
    return;
  }

  throw new CliError(`unknown workflows subcommand: ${escapeTerminalText(subcommand)}\n${usageText()}`);
}

/**
 * @param {string[]} positionals
 * @param {string} label
 */
function requireWorkflowRef(positionals, label) {
  requireNoExtraPositionals(positionals, 3, label);
  const worker = positionals[1];
  const workflow = positionals[2];
  if (!worker || !workflow) throw new CliError(`${label} requires <worker> <workflowName>`);
  return { worker, workflow };
}

/**
 * @param {string[]} positionals
 * @param {string} label
 */
function requireInstanceRef(positionals, label) {
  requireNoExtraPositionals(positionals, 4, label);
  const worker = positionals[1];
  const workflow = positionals[2];
  const instanceId = positionals[3];
  if (!worker || !workflow || !instanceId) throw new CliError(`${label} requires <worker> <workflowName> <instanceId>`);
  return { worker, workflow, instanceId };
}

/**
 * @param {string[]} positionals
 * @param {number} expected
 * @param {string} label
 */
function requireNoExtraPositionals(positionals, expected, label) {
  if (positionals.length > expected) {
    throw unexpectedArgument(label, positionals[expected]);
  }
}

function usageText() {
  return formatHelp({
    usage: [
      "wdl workflows list [options]",
      "wdl workflows instances <worker> <workflowName> [--limit <n>] [--cursor <cursor>] [options]",
      "wdl workflows status <worker> <workflowName> <instanceId> [--include-steps] [--step-limit <n>] [options]",
      "wdl workflows pause <worker> <workflowName> <instanceId> [options]",
      "wdl workflows resume <worker> <workflowName> <instanceId> [options]",
      "wdl workflows restart <worker> <workflowName> <instanceId> --yes [options]",
      "wdl workflows terminate <worker> <workflowName> <instanceId> --yes [options]",
    ],
    description: "Inspect and control WDL Workflow instances.",
    options: optionHelp(WORKFLOW_OPTIONS),
  });
}

if (isMain(import.meta.url)) {
  await main();
}
