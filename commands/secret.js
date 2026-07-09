// Manage secrets via control's /secrets API. One of --worker <name> or
// --scope ns is required on every call — never defaulted, to prevent
// "meant worker, wrote ns" credential leaks.

import { defineCommand } from "../lib/command.js";
import { CliError, defineCliOption, formatHelp, formatHttpError, isMain, isNonEmptyString, optionHelp, readJsonOrFail, unexpectedArgument } from "../lib/common.js";
import { confirmAction, readSecretStdin } from "../lib/stdin.js";
import { escapeTerminalText, writeJsonOr, writeStatusLine } from "../lib/output.js";
import { isSecretEnvelopeErrorCode } from "../lib/secret-envelope-errors.js";

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
 * The fields this command reads off control's /secrets responses. Control may
 * return more; only these are consumed here.
 * @typedef {object} SecretResponse
 * @property {string[]} [keys]
 * @property {boolean} [deleted]
 * @property {string} [version]
 * @property {string} [previousVersion]
 */

/** @param {{ values: import("../lib/command.js").PresetFlags<"ns" | "control" | "json"> & { worker?: string, scope?: string, yes?: boolean }, positionals: string[], context: import("../lib/command.js").CommandContext }} arg */
async function runSecret({ values, positionals, context }) {
  const { stdout, stderr, stdin } = context;

  const [subcommand, keyArg] = positionals;
  const extraArg = positionals[2];
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

  const secretPath = worker ? ["worker", worker, "secrets"] : ["secrets"];
  const scopeLabel = worker ? `${ns}/${worker}` : `${ns} (ns)`;

  if (subcommand === "list") {
    if (keyArg) throw unexpectedArgument("secret list", keyArg);
    const { headers } = context.resolveControl();
    const body = /** @type {SecretResponse} */ (await context.fetchJson(context.nsUrl(...secretPath), { headers }, "list"));
    if (writeJsonOr(Boolean(values.json), body, stdout)) return;
    const keys = Array.isArray(body.keys) ? body.keys : [];
    if (keys.length === 0) writeStatusLine(stdout, "(no secrets)");
    else for (const k of keys) writeStatusLine(stdout, String(k));
    return;
  }

  if (subcommand === "put") {
    if (!keyArg) throw new CliError("put requires a KEY argument");
    if (extraArg) throw unexpectedArgument("secret put", extraArg);
    const { headers } = context.resolveControl();
    // Empty string is a set secret (≠ unset), matching wrangler.
    const value = await readSecretStdin(stdin, {
      prompt: `Enter secret value for ${scopeLabel}/${keyArg} (input hidden): `,
      stderr,
    });
    const body = /** @type {SecretResponse} */ (await fetchSecretMutationJson(context, context.nsUrl(...secretPath, keyArg), {
      method: "PUT",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ value }),
    }, "put"));
    if (writeJsonOr(Boolean(values.json), body, stdout)) return;
    if (hasWorker && body.version) {
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
    if (extraArg) throw unexpectedArgument("secret delete", extraArg);
    const { headers } = context.resolveControl();
    await confirmAction({
      yes: values.yes === true,
      stdin,
      stderr,
      prompt: `Are you sure you want to delete secret "${scopeLabel}/${keyArg}"? [y/N] `,
      action: `delete secret "${scopeLabel}/${keyArg}"`,
    });
    const body = /** @type {SecretResponse} */ (await fetchSecretMutationJson(context, context.nsUrl(...secretPath, keyArg), {
      method: "DELETE",
      headers,
    }, "delete"));
    if (writeJsonOr(Boolean(values.json), body, stdout)) return;
    if (!body.deleted) writeStatusLine(stdout, `(${keyArg} was not set)`);
    else if (hasWorker && body.version) writeStatusLine(stdout, `✓ ${scopeLabel}/${keyArg} deleted — promoted ${body.previousVersion} → ${body.version}`);
    else if (hasWorker) writeStatusLine(stdout, `✓ ${scopeLabel}/${keyArg} deleted — no active worker version to promote`);
    else writeStatusLine(stdout, `✓ ${scopeLabel}/${keyArg} deleted — effect on next natural cold-load`);
    return;
  }

  throw new CliError(`unknown subcommand: ${escapeTerminalText(subcommand)}`);
}

/**
 * @param {import("../lib/command.js").CommandContext} context
 * @param {string} url
 * @param {import("../lib/control-fetch.js").ControlFetchInit} init
 * @param {string} label
 */
async function fetchSecretMutationJson(context, url, init, label) {
  const res = await context.controlFetch(url, { ...init, env: init.env ?? context.env });
  if (res.ok) return await readJsonOrFail(res, label);
  const text = await res.text();
  throw new CliError(`${label} failed: ${formatHttpError(res.status, text, res.headers)}${secretMutationHint(text)}`);
}

/** @param {string} text */
function secretMutationHint(text) {
  /** @type {unknown} */
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return "";
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) return "";
  const error = /** @type {{ error?: unknown }} */ (body).error;
  if (error === "worker_env_too_large") {
    return "; secret mutation was not written. Reduce [vars], secrets, or binding metadata; if source_version names a retained version, redeploy/delete that version. estimated_version may be a sizing placeholder. Namespace-scope mutations can be blocked by another worker's retained metadata.";
  }
  if (error === "secret_mutation_contention" || error === "namespace_secret_mutation_contention") {
    return "; secret mutation was not written. Retry after concurrent worker metadata updates settle.";
  }
  if (isSecretEnvelopeErrorCode(error)) {
    return "; secret mutation was not written. Secret-envelope configuration or stored secret data needs operator repair before retrying.";
  }
  return "";
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
