#!/usr/bin/env node

import { parseArgs } from "node:util";
import * as initCmd from "../commands/init.js";
import * as deployCmd from "../commands/deploy.js";
import * as secretCmd from "../commands/secret.js";
import * as workersCmd from "../commands/workers.js";
import * as deleteCmd from "../commands/delete.js";
import * as d1Cmd from "../commands/d1.js";
import * as r2Cmd from "../commands/r2.js";
import * as tailCmd from "../commands/tail.js";
import * as workflowsCmd from "../commands/workflows.js";
import * as configCmd from "../commands/config.js";
import * as doctorCmd from "../commands/doctor.js";
import * as whoamiCmd from "../commands/whoami.js";
import * as tokenCmd from "../commands/token.js";
import { isHelpAlias } from "../lib/command.js";
import { commonCliOptions, flagSet, formatHelp, handleCliError, isMain, loadCliControlEnv } from "../lib/common.js";
import { currentCliVersion } from "../lib/package-info.js";
import { readTokenStore, tokenStorePath } from "../lib/token-store.js";

// Ordered for `wdl help`. Each entry carries its own { name, summary } metadata,
// so the dispatch map and the help table below are both derived from it — no
// command name or description is maintained twice.
const REGISTRY = [initCmd, deployCmd, secretCmd, workersCmd, deleteCmd, d1Cmd, r2Cmd, tailCmd, workflowsCmd, tokenCmd, configCmd, doctorCmd, whoamiCmd];

// Alias -> canonical command name.
const ALIASES = { secrets: "secret" };

const COMMANDS = Object.fromEntries(REGISTRY.map((c) => [c.meta.name, c]));
for (const [alias, target] of Object.entries(ALIASES)) COMMANDS[alias] = COMMANDS[target];

// The pre-scan below needs each command's flag schema; a missing one would
// silently misparse `--ns <value>` and break the .env section overlay, so
// fail at load time instead.
for (const c of REGISTRY) {
  if (!c.meta.parseOptions) throw new Error(`command "${c.meta.name}" is missing meta.parseOptions`);
}

export async function main(argv = process.argv.slice(2), deps = {}) {
  const [command, ...rest] = argv;

  if (!command || command === "-h" || command === "--help" || command === "help") {
    usage(command ? 0 : 1);
    return;
  }
  if (command === "-v" || command === "--version" || command === "version") {
    console.log(currentCliVersion());
    return;
  }
  const commandModule = COMMANDS[command];
  if (!commandModule) {
    console.error(`error: unknown command: ${command}`);
    usage(1);
    return;
  }

  const env = deps.env || process.env;
  const scanned = scanCommandArgs(commandModule, rest);
  // Tests pass loadEnv: null to disable autoload; an injected loader (or the
  // real default when undefined) flows straight into loadCliControlEnv.
  const loadEnvOverride = Object.hasOwn(deps, "loadEnv") ? deps.loadEnv : undefined;
  const skipAutoload = Object.hasOwn(deps, "loadEnv") && !deps.loadEnv;
  // Help never needs credentials, so a malformed .env must not block it.
  if (!skipAutoload && commandModule.meta.autoloadEnv && !scanned.help) {
    try {
      loadCliControlEnv(env, {
        nsFromFlag: scanned.ns,
        tokenFromFlag: scanned.tokenFromFlag,
        controlUrlFromFlag: scanned.controlUrlFromFlag,
        loadEnv: loadEnvOverride,
        readStore: (e) => readTokenStore(tokenStorePath(e)),
      });
    } catch (err) {
      handleCliError(err);
    }
  }

  return await commandModule.main(rest);
}

// Lenient pre-parse with the command's own flag schema, so the `.env` overlay
// targets the same `--ns` the strict parse will resolve (last occurrence wins,
// flag values never misread) and help requests — `-h`/`--help` or the
// positional alias `wdl <command> [flags] help` — are recognized with the
// framework's own isHelpAlias. strict:false never throws on argv input; only
// a broken option schema can throw, and that should surface loudly.
function scanCommandArgs(commandModule, args) {
  const { values, positionals } = parseArgs({
    args,
    options: commandModule.meta.parseOptions,
    allowPositionals: true,
    strict: false,
  });
  return {
    // strict:false yields `true` for a string option with a missing value.
    ns: typeof values.ns === "string" ? values.ns : undefined,
    // A non-empty --token means the effective credential is NOT the .env one
    // (an empty --token "" falls back to env), so the cross-origin guard must
    // distrust .env control endpoints. Matches config-state's detection.
    tokenFromFlag: flagSet(values, "token"),
    // A --control-url means the store need not be consulted to fill the
    // endpoint, so a corrupt store cannot block a fully flag-supplied command.
    controlUrlFromFlag: flagSet(values, "control-url"),
    help: values.help === true || isHelpAlias(positionals),
  };
}

function usage(exitCode) {
  // Aliases grouped by the command they point at, for the "(alias: …)" note.
  const aliasesByTarget = {};
  for (const [alias, target] of Object.entries(ALIASES)) {
    (aliasesByTarget[target] ??= []).push(alias);
  }
  const width = Math.max(...REGISTRY.map((c) => c.meta.name.length)) + 1;
  console.error(formatHelp({
    usage: [
      "wdl <command> [args] [options]",
      "wdl <command> --help",
      "wdl --version",
    ],
    description: "Manage deployments, diagnostics, secrets, workers, D1, R2, and Workflows for a WDL control plane.",
    commands: REGISTRY.map((c) => {
      const alias = aliasesByTarget[c.meta.name];
      const note = alias ? ` (alias: ${alias.join(", ")})` : "";
      return `${c.meta.name.padEnd(width)}${c.meta.summary}${note}`;
    }),
    options: commonCliOptions(),
  }));
  process.exit(exitCode);
}

if (isMain(import.meta.url)) {
  await main();
}
