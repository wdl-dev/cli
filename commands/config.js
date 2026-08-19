import { defineCommand } from "../lib/command.js";
import { CliError, formatHelp, isMain, optionHelp } from "../lib/common.js";
import { writeResult } from "../lib/output.js";
import { resolveDiagnosticConfigState } from "../lib/config-state.js";

const CONFIG_OPTIONS = ["ns", "control", "json", "help"];

const command = defineCommand({
  name: "config",
  summary: "Explain resolved CLI configuration sources.",
  options: CONFIG_OPTIONS,
  autoloadEnv: false,
  usage: usageText,
  run: runConfig,
});

export const main = command.main;
export const runConfigCommand = command.run;
export const meta = command.meta;

/** @param {{ values: import("../lib/command.js").PresetFlags<"ns" | "control" | "json">, positionals: string[], context: import("../lib/command.js").CommandContext }} arg */
async function runConfig({ values, positionals, context }) {
  const [subcommand, extra] = positionals;
  if (subcommand !== "explain" || extra) throw new CliError(usageText());

  const { state, tokenStoreError } = resolveDiagnosticConfigState({
    values,
    env: context.env,
    cwd: context.cwd,
    warn: context.warn,
  });
  const body = {
    namespace: publicEntry(state.namespace),
    controlUrl: publicEntry(state.controlUrl),
    token: publicEntry(state.token),
    ...(tokenStoreError ? { tokenStore: { error: tokenStoreError } } : {}),
  };
  writeResult(values.json === true, body, () => formatConfigExplain(body), context.stdout);
}

/**
 * @typedef {object} PublicConfigEntry
 * @property {string} value
 * @property {string} source
 * @property {string} [error]
 */

/**
 * @param {import("../lib/config-state.js").ConfigEntry} entry
 * @returns {PublicConfigEntry}
 */
function publicEntry(entry) {
  /** @type {PublicConfigEntry} */
  const out = {
    value: entry.display,
    source: entry.source,
  };
  if (entry.error) out.error = entry.error;
  return out;
}

/**
 * @param {{ namespace: PublicConfigEntry, controlUrl: PublicConfigEntry, token: PublicConfigEntry, tokenStore?: { error: string } }} body
 */
function formatConfigExplain(body) {
  const lines = [
    ...formatBlock("namespace", body.namespace),
    "",
    ...formatBlock("controlUrl", body.controlUrl),
    "",
    ...formatBlock("token", body.token),
  ];
  if (body.tokenStore) lines.push("", "tokenStore:", `  error: ${body.tokenStore.error}`);
  return lines;
}

/**
 * @param {string} name
 * @param {PublicConfigEntry} entry
 */
function formatBlock(name, entry) {
  const lines = [`${name}:`, `  value: ${entry.value}`, `  source: ${entry.source}`];
  if (entry.error) lines.push(`  error: ${entry.error}`);
  return lines;
}

function usageText() {
  return formatHelp({
    usage: ["wdl config explain [options]"],
    description: "Show the final namespace, control URL, token mask, and where each value came from.",
    options: optionHelp(CONFIG_OPTIONS),
  });
}

if (isMain(import.meta.url)) {
  await main();
}
