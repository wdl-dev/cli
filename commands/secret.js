// Manage secrets via control's /secrets API. One of --worker <name> or
// --scope ns is required on every call — never defaulted, to prevent
// "meant worker, wrote ns" credential leaks.

import { defineCommand } from "../lib/command.js";
import { CliError, defineCliOption, formatHelp, isMain, isNonEmptyString, optionHelp } from "../lib/common.js";
import { confirmAction, readSecretStdin } from "../lib/stdin.js";
import { writeJsonOr, writeStatusLine } from "../lib/output.js";

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

/**
 * A deferred-reload warning surfaced by control on put/delete.
 * @typedef {object} PromoteWarning
 * @property {string} [kind]
 * @property {string} [reason]
 * @property {string} [nextPickup]
 */

/**
 * The fields this command reads off control's /secrets responses. Control may
 * return more; only these are consumed here.
 * @typedef {object} SecretResponse
 * @property {string[]} [keys]
 * @property {boolean} [deleted]
 * @property {string} [version]
 * @property {string} [previousVersion]
 * @property {PromoteWarning[]} [warnings]
 */

/** @param {{ values: import("../lib/command.js").PresetFlags<"ns" | "control" | "json"> & { worker?: string, scope?: string, yes?: boolean }, positionals: string[], context: import("../lib/command.js").CommandContext }} arg */
async function runSecret({ values, positionals, context }) {
  const { stdout, stderr, stdin } = context;

  const [subcommand, keyArg] = positionals;
  const ns = context.resolveNamespace();
  if (!subcommand || !ns) {
    throw new CliError(usageText());
  }

  // Narrow values.worker to a string once; reuse `worker`/`hasWorker` below so
  // the worker-presence predicate lives in exactly one place.
  const worker = isNonEmptyString(values.worker) ? values.worker : null;
  const hasWorker = worker !== null;
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
  const secretPath = worker ? ["worker", worker, "secrets"] : ["secrets"];
  const scopeLabel = worker ? `${ns}/${worker}` : `${ns} (ns)`;

  if (subcommand === "list") {
    const body = /** @type {SecretResponse} */ (await context.fetchJson(context.nsUrl(...secretPath), { headers }, "list"));
    if (writeJsonOr(Boolean(values.json), body, stdout)) return;
    const keys = Array.isArray(body.keys) ? body.keys : [];
    if (keys.length === 0) writeStatusLine(stdout, "(no secrets)");
    else for (const k of keys) writeStatusLine(stdout, String(k));
    return;
  }

  if (subcommand === "put") {
    if (!keyArg) throw new CliError("put requires a KEY argument");
    // Empty string is a set secret (≠ unset), matching wrangler.
    const value = await readSecretStdin(stdin, {
      prompt: `Enter secret value for ${scopeLabel}/${keyArg} (input hidden): `,
      stderr,
    });
    const body = /** @type {SecretResponse} */ (await context.fetchJson(context.nsUrl(...secretPath, keyArg), {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ value }),
    }, "put"));
    if (writeJsonOr(Boolean(values.json), body, stdout)) return;
    const warning = pickPromoteWarning(body);
    if (warning) {
      writeStatusLine(stdout, `⚠ ${scopeLabel}/${keyArg} set — stored, reload deferred: ${warning.reason}`);
      writeStatusLine(stdout, `  next pickup: ${warning.nextPickup}`);
    } else if (hasWorker && body.version) {
      writeStatusLine(stdout, `✓ ${scopeLabel}/${keyArg} set — promoted ${body.previousVersion} → ${body.version}`);
    } else if (hasWorker) {
      writeStatusLine(stdout, `✓ ${scopeLabel}/${keyArg} set — stored; will apply on first deploy`);
    } else {
      writeStatusLine(stdout, `✓ ${scopeLabel}/${keyArg} set — effect on next natural cold-load`);
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
    const body = /** @type {SecretResponse} */ (await context.fetchJson(context.nsUrl(...secretPath, keyArg), {
      method: "DELETE",
      headers,
    }, "delete"));
    if (writeJsonOr(Boolean(values.json), body, stdout)) return;
    const warning = pickPromoteWarning(body);
    if (!body.deleted && !warning) writeStatusLine(stdout, `(${keyArg} was not set)`);
    else if (warning && body.deleted) {
      writeStatusLine(stdout, `⚠ ${scopeLabel}/${keyArg} deleted — stored, reload deferred: ${warning.reason}`);
      writeStatusLine(stdout, `  next pickup: ${warning.nextPickup}`);
    }
    else if (warning) {
      writeStatusLine(stdout, `⚠ ${scopeLabel}/${keyArg} unchanged — reload deferred: ${warning.reason}`);
      writeStatusLine(stdout, `  next pickup: ${warning.nextPickup}`);
    }
    else if (hasWorker && body.version) writeStatusLine(stdout, `✓ ${scopeLabel}/${keyArg} deleted — promoted ${body.previousVersion} → ${body.version}`);
    else if (hasWorker) writeStatusLine(stdout, `✓ ${scopeLabel}/${keyArg} deleted — no active worker version to promote`);
    else writeStatusLine(stdout, `✓ ${scopeLabel}/${keyArg} deleted — effect on next natural cold-load`);
    return;
  }

  throw new CliError(`unknown subcommand: ${subcommand}`);
}

/**
 * @param {SecretResponse} body
 * @returns {PromoteWarning | null}
 */
function pickPromoteWarning(body) {
  const warnings = Array.isArray(body?.warnings) ? body.warnings : [];
  return warnings.find((w) => w?.kind === "promote_failed") || null;
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
