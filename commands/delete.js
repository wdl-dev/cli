import { defineCommand } from "../lib/command.js";
import { CliError, defineCliOption, defineHiddenCliOption, formatHelp, isMain, optionHelp, unexpectedArgument } from "../lib/common.js";
import { confirmAction } from "../lib/stdin.js";
import { escapeTerminalText, writeResult } from "../lib/output.js";
import { formatVersionDelete, formatWorkerDelete } from "../lib/delete-format.js";

const DELETE_OPTIONS = [
  defineHiddenCliOption("worker", { type: "string" }),
  defineHiddenCliOption("version", { type: "string" }),
  defineCliOption("dry-run", { type: "boolean" }, "--dry-run", "Preview worker delete without changing state."),
  defineCliOption("yes", { type: "boolean" }, "--yes", "Skip worker delete confirmation."),
  "ns",
  "control",
  "json",
  "help",
];

const command = defineCommand({
  name: "delete",
  summary: "Delete workers or retained worker versions.",
  options: DELETE_OPTIONS,
  usage: usageText,
  run: runDelete,
});

export const main = command.main;
export const runDeleteCommand = command.run;
export const meta = command.meta;

/** @param {{ values: import("../lib/command.js").PresetFlags<"ns" | "control" | "json"> & { worker?: string, version?: string, "dry-run"?: boolean, yes?: boolean }, positionals: string[], context: import("../lib/command.js").CommandContext }} arg */
async function runDelete({ values, positionals, context }) {
  const { stdout, stderr, stdin } = context;

  const [subcommand, firstArg, secondArg] = positionals;
  const ns = context.resolveNamespace();
  if (!subcommand || !ns) {
    throw new CliError(usageText());
  }

  if (subcommand !== "version" && subcommand !== "worker") {
    throw new CliError(`unknown subcommand: ${escapeTerminalText(subcommand)}\n${usageText()}`);
  }

  if (subcommand === "version") {
    let positionalIndex = 1;
    const worker = values.worker || positionals[positionalIndex++];
    const version = values.version || positionals[positionalIndex++];
    const extraArg = positionals[positionalIndex];
    if (!worker || !version) {
      throw new CliError("version delete requires <worker> <version> or --worker/--version");
    }
    if (extraArg) throw unexpectedArgument("delete version", extraArg);
    const { headers } = context.resolveControl();
    const body = await context.fetchJson(
      context.nsUrl("worker", worker, "versions", version),
      { method: "DELETE", headers },
      "delete version",
    );
    writeResult(values.json === true, body, () => formatVersionDelete(/** @type {Parameters<typeof formatVersionDelete>[0]} */ (body)), stdout);
    return;
  }

  if (subcommand === "worker") {
    const worker = values.worker || firstArg;
    const extraArg = values.worker ? firstArg : secondArg;
    if (!worker) {
      throw new CliError("worker delete requires <worker> or --worker <name>");
    }
    if (extraArg) throw unexpectedArgument("delete worker", extraArg);
    const { headers } = context.resolveControl();
    const dryRun = values["dry-run"] === true;
    await confirmAction({
      yes: dryRun || values.yes === true,
      stdin,
      stderr,
      prompt: `Are you sure you want to delete worker "${ns}/${worker}"? [y/N] `,
      action: `delete worker "${ns}/${worker}"`,
    });
    const suffix = dryRun ? "?dry_run=1" : "";
    const body = await context.fetchJson(
      `${context.nsUrl("worker", worker, "delete")}${suffix}`,
      { method: "POST", headers },
      dryRun ? "dry-run delete worker" : "delete worker",
    );
    writeResult(values.json === true, body, () => formatWorkerDelete(/** @type {Parameters<typeof formatWorkerDelete>[0]} */ (body)), stdout);
    return;
  }
}

function usageText() {
  return formatHelp({
    usage: [
      "wdl delete version [options] <worker> <version>",
      "wdl delete worker [options] <worker>",
    ],
    description: "Delete retained versions or all worker-owned lifecycle state.",
    commands: [
      "version  Delete one retained non-active worker version.",
      "worker   Delete a worker, its versions, secrets, routes, and queue consumers.",
    ],
    options: optionHelp(DELETE_OPTIONS),
  });
}

if (isMain(import.meta.url)) {
  await main();
}
