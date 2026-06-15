// Manage secrets via control's /secrets API. One of --worker <name> or
// --scope ns is required on every call — never defaulted, to prevent
// "meant worker, wrote ns" credential leaks.

import { defineCommand } from "../lib/command.js";
import {
  CliError,
  confirmAction,
  defineCliOption,
  escapeTerminalText,
  formatHelp,
  isMain,
  optionHelp,
  readTtyLine,
} from "../lib/common.js";

const SECRET_OPTIONS = [
  defineCliOption("worker", { type: "string" }, "--worker <w>", "Use worker-level secret scope."),
  defineCliOption("scope", { type: "string" }, "--scope ns", "Use namespace-level secret scope."),
  defineCliOption("yes", { type: "boolean" }, "--yes", "Skip delete confirmation."),
  "ns",
  "control",
  "json",
  "help",
];

const command = defineCommand({
  name: "secret",
  summary: "Manage namespace-level or worker-level secrets.",
  options: SECRET_OPTIONS,
  usage: usageText,
  run: runSecret,
});

export const main = command.main;
export const runSecretCommand = command.run;
export const meta = command.meta;

/** @param {{ values: Record<string, any>, positionals: string[], context: import("../lib/command.js").CommandContext }} arg */
async function runSecret({ values, positionals, context }) {
  const { stdout, stderr, stdin } = context;

  const [subcommand, keyArg] = positionals;
  const ns = context.resolveNamespace();
  if (!subcommand || !ns) {
    throw new CliError(usageText());
  }

  const hasWorker = typeof values.worker === "string" && values.worker.length > 0;
  const hasScopeNs = values.scope === "ns";
  if (hasWorker && hasScopeNs) {
    throw new CliError("conflicting flags: --worker and --scope ns are mutually exclusive");
  }
  if (!hasWorker && !hasScopeNs) {
    throw new CliError("must specify either --worker <name> (worker-level) or --scope ns (ns-level)");
  }
  if (values.scope && values.scope !== "ns") {
    throw new CliError(`--scope must be "ns" (only supported value); omit for worker scope`);
  }

  const { headers } = context.resolveControl();
  const secretPath = hasWorker
    ? ["worker", values.worker, "secrets"]
    : ["secrets"];
  const scopeLabel = hasWorker ? `${ns}/${values.worker}` : `${ns} (ns)`;

  if (subcommand === "list") {
    const body = await context.fetchJson(context.nsUrl(...secretPath), { headers }, "list");
    if (values.json) {
      stdout(JSON.stringify(body, null, 2));
      return;
    }
    const keys = Array.isArray(body.keys) ? body.keys : [];
    if (keys.length === 0) stdout("(no secrets)");
    else for (const k of keys) stdout(escapeTerminalText(String(k)));
    return;
  }

  if (subcommand === "put") {
    if (!keyArg) throw new CliError("put requires a KEY argument");
    // Empty string is a set secret (≠ unset), matching wrangler.
    const value = await readStdin(stdin, {
      prompt: `Enter secret value for ${scopeLabel}/${keyArg} (input hidden): `,
      stderr,
    });
    const body = await context.fetchJson(context.nsUrl(...secretPath, keyArg), {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ value }),
    }, "put");
    if (values.json) {
      stdout(JSON.stringify(body, null, 2));
      return;
    }
    const warning = pickPromoteWarning(body);
    if (warning) {
      stdout(`⚠ ${scopeLabel}/${keyArg} set — stored, reload deferred: ${escapeTerminalText(warning.reason)}`);
      stdout(`  next pickup: ${escapeTerminalText(warning.nextPickup)}`);
    } else if (hasWorker && body.version) {
      stdout(`✓ ${scopeLabel}/${keyArg} set — promoted ${escapeTerminalText(body.previousVersion)} → ${escapeTerminalText(body.version)}`);
    } else if (hasWorker) {
      stdout(`✓ ${scopeLabel}/${keyArg} set — stored; will apply on first deploy`);
    } else {
      stdout(`✓ ${scopeLabel}/${keyArg} set — effect on next natural cold-load`);
    }
    return;
  }

  if (subcommand === "delete") {
    if (!keyArg) throw new CliError("delete requires a KEY argument");
    await confirmAction({
      yes: values.yes === true,
      stdin,
      stderr,
      prompt: `Are you sure you want to delete secret "${scopeLabel}/${keyArg}"? [y/N] `,
      action: `delete secret "${scopeLabel}/${keyArg}"`,
    });
    const body = await context.fetchJson(context.nsUrl(...secretPath, keyArg), {
      method: "DELETE",
      headers,
    }, "delete");
    if (values.json) {
      stdout(JSON.stringify(body, null, 2));
      return;
    }
    const warning = pickPromoteWarning(body);
    if (!body.deleted && !warning) stdout(`(${keyArg} was not set)`);
    else if (warning && body.deleted) {
      stdout(`⚠ ${scopeLabel}/${keyArg} deleted — stored, reload deferred: ${escapeTerminalText(warning.reason)}`);
      stdout(`  next pickup: ${escapeTerminalText(warning.nextPickup)}`);
    }
    else if (warning) {
      stdout(`⚠ ${scopeLabel}/${keyArg} unchanged — reload deferred: ${escapeTerminalText(warning.reason)}`);
      stdout(`  next pickup: ${escapeTerminalText(warning.nextPickup)}`);
    }
    else if (hasWorker && body.version) stdout(`✓ ${scopeLabel}/${keyArg} deleted — promoted ${escapeTerminalText(body.previousVersion)} → ${escapeTerminalText(body.version)}`);
    else if (hasWorker) stdout(`✓ ${scopeLabel}/${keyArg} deleted — no active worker version to promote`);
    else stdout(`✓ ${scopeLabel}/${keyArg} deleted — effect on next natural cold-load`);
    return;
  }

  throw new CliError(`unknown subcommand: ${subcommand}`);
}

function pickPromoteWarning(body) {
  const warnings = Array.isArray(body?.warnings) ? body.warnings : [];
  return warnings.find((w) => w?.kind === "promote_failed") || null;
}

// Pipe/redirect mode reads until EOF so multi-line secrets work. TTY mode
// reads one line so typing a value and pressing Enter submits immediately.
/**
 * @param {{ isTTY?: boolean, setEncoding: (encoding: string) => void, setRawMode?: (mode: boolean) => void, on: Function, off: Function, pause?: Function }} stdin
 * @param {{ prompt?: string, stderr?: (text: string) => void }} [options]
 */
function readStdin(stdin, { prompt, stderr } = {}) {
  // hidden: a secret value must never echo to the terminal or scrollback.
  if (stdin.isTTY) return readTtyLine(stdin, { prompt, stderr, hidden: true });

  return new Promise((resolve, reject) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => (data += chunk));
    stdin.on("end", () => resolve(data.replace(/\r?\n$/, "")));
    stdin.on("error", reject);
  });
}

function usageText() {
  return formatHelp({
    usage: [
      "wdl secret put [options] (--worker <w> | --scope ns) <KEY>",
      "wdl secret list [options] (--worker <w> | --scope ns)",
      "wdl secret delete [options] (--worker <w> | --scope ns) <KEY>",
    ],
    description: "Manage namespace-level or worker-level secrets stored by control.",
    options: optionHelp(SECRET_OPTIONS),
  });
}

if (isMain(import.meta.url)) {
  await main();
}
