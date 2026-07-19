import { defineCommand } from "../lib/command.js";
import { CliError, formatHelp, isMain, optionHelp } from "../lib/common.js";
import { writeResult } from "../lib/output.js";
import { formatWorkersList } from "../lib/workers-format.js";

const WORKERS_OPTIONS = ["ns", "control", "json", "help"];

const command = defineCommand({
  name: "workers",
  summary: "List worker lifecycle state in a namespace.",
  options: WORKERS_OPTIONS,
  usage: usageText,
  run: runWorkers,
});

export const main = command.main;
export const runWorkersCommand = command.run;
export const meta = command.meta;
// Re-exported for the existing test import surface; logic lives in lib/.
export { formatWorkersList };

/** @param {{ values: import("../lib/command.js").PresetFlags<"ns" | "control" | "json">, positionals: string[], context: import("../lib/command.js").CommandContext }} arg */
async function runWorkers({ values, positionals, context }) {
  const ns = context.resolveNamespace();
  if (positionals.length > 0) throw new CliError(usageText());
  if (!ns) throw new CliError(usageText());
  await printWorkersList(context, values.json === true);
}

/**
 * @param {import("../lib/command.js").CommandContext} context
 * @param {boolean} json
 */
async function printWorkersList(context, json) {
  const { headers } = context.resolveControl();
  const body = /** @type {{ workers?: import("../lib/workers-format.js").WorkerSummary[] }} */ (
    await context.fetchJson(context.nsUrl("workers"), { headers }, "list workers")
  );
  writeResult(json, body, () => formatWorkersList(body), context.stdout);
}

function usageText() {
  return formatHelp({
    usage: ["wdl workers [options]"],
    description: "List active and retained versions, secret-only entries, and workflow-definition-only entries.",
    options: optionHelp(WORKERS_OPTIONS),
  });
}

if (isMain(import.meta.url)) {
  await main();
}
