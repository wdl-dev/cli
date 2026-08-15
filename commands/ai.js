import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import { defineCommand } from "../lib/command.js";
import {
  CliError,
  defineCliOption,
  formatHelp,
  isMain,
  isPathInside,
  optionHelp,
  unexpectedArgument,
} from "../lib/common.js";
import { escapeTerminalText, writeJsonOr, writeStatusLine } from "../lib/output.js";
import { confirmAction, readSecretStdin } from "../lib/stdin.js";

const AI_OPTIONS = [
  defineCliOption("file", { type: "string" }, "--file <path>", "Provider JSON file for providers put."),
  defineCliOption("yes", { type: "boolean" }, "--yes", "Skip provider delete confirmation."),
  "ns",
  "control",
  "json",
  "help",
];

const command = defineCommand({
  name: "ai",
  summary: "Manage AI providers, credentials, and models.",
  options: AI_OPTIONS,
  usage: usageText,
  run: runAi,
});

export const main = command.main;
export const runAiCommand = command.run;
export const meta = command.meta;

/**
 * @typedef {import("../lib/command.js").PresetFlags<"ns" | "control" | "json"> & {
 *   file?: string,
 *   yes?: boolean,
 * }} AiFlags
 */

/** @param {{ values: AiFlags, positionals: string[], context: import("../lib/command.js").CommandContext }} arg */
async function runAi({ values, positionals, context }) {
  const { stdout, stderr, stdin } = context;
  const [group, action, provider] = positionals;
  const extraArg = positionals[3];
  const ns = context.resolveNamespace();
  if (!group || !ns) throw new CliError(usageText());

  if (group === "models") {
    if (action) throw unexpectedArgument("ai models", action);
    const { headers } = context.resolveControl();
    const body = /** @type {AiModelsResponse} */ (
      await context.fetchJson(context.nsUrl("ai", "models"), { headers }, "list AI models")
    );
    if (writeJsonOr(values.json === true, body, stdout)) return;
    const models = Array.isArray(body.models) ? body.models : [];
    if (models.length === 0) {
      writeStatusLine(stdout, "(no configured AI models)");
      return;
    }
    for (const model of models) {
      const transports = Array.isArray(model.transports) ? model.transports.join(",") : "-";
      writeStatusLine(
        stdout,
        `${escapeTerminalText(String(model.id ?? "-"))} protocol=${escapeTerminalText(String(model.protocol ?? "-"))} transports=${escapeTerminalText(transports)}`
      );
    }
    return;
  }

  if (group === "providers" && action === "list") {
    if (provider) throw unexpectedArgument("ai providers list", provider);
    const { headers } = context.resolveControl();
    const body = /** @type {AiProvidersResponse} */ (
      await context.fetchJson(context.nsUrl("ai", "providers"), { headers }, "list AI providers")
    );
    if (writeJsonOr(values.json === true, body, stdout)) return;
    const providers = Array.isArray(body.providers) ? body.providers : [];
    if (providers.length === 0) {
      writeStatusLine(stdout, "(no AI providers)");
      return;
    }
    for (const entry of providers) {
      const modelCount = entry.models && typeof entry.models === "object" ? Object.keys(entry.models).length : 0;
      writeStatusLine(
        stdout,
        `${escapeTerminalText(String(entry.name ?? "-"))} kind=${escapeTerminalText(String(entry.kind ?? "-"))} models=${modelCount} credential=${entry.credentialConfigured === true ? "configured" : "missing"}`
      );
    }
    return;
  }

  if (group === "providers" && action === "get") {
    requireProvider(provider, "ai providers get");
    if (extraArg) throw unexpectedArgument("ai providers get", extraArg);
    const { headers } = context.resolveControl();
    const body = /** @type {AiProviderResponse} */ (
      await context.fetchJson(context.nsUrl("ai", "providers", provider), { headers }, "get AI provider")
    );
    if (writeJsonOr(values.json === true, body, stdout)) return;
    const entry = body.provider;
    writeStatusLine(stdout, `name: ${escapeTerminalText(String(entry?.name ?? provider))}`);
    writeStatusLine(stdout, `kind: ${escapeTerminalText(String(entry?.kind ?? "-"))}`);
    writeStatusLine(stdout, `revision: ${escapeTerminalText(String(entry?.revision ?? "-"))}`);
    writeStatusLine(stdout, `credential: ${entry?.credentialConfigured === true ? "configured" : "missing"}`);
    for (const [alias, descriptor] of Object.entries(entry?.models ?? {})) {
      const protocol = descriptor && typeof descriptor === "object" ? descriptor.protocol : undefined;
      writeStatusLine(stdout, `model: ${escapeTerminalText(alias)} (${escapeTerminalText(String(protocol ?? "-"))})`);
    }
    return;
  }

  if (group === "providers" && action === "put") {
    requireProvider(provider, "ai providers put");
    if (extraArg) throw unexpectedArgument("ai providers put", extraArg);
    const providerBody = readProviderFile(values.file, context.cwd);
    const { headers } = context.resolveControl();
    const body = /** @type {AiProviderResponse} */ (
      await context.fetchJson(
        context.nsUrl("ai", "providers", provider),
        {
          method: "PUT",
          headers: { ...headers, "content-type": "application/json" },
          body: JSON.stringify(providerBody),
        },
        "put AI provider"
      )
    );
    if (writeJsonOr(values.json === true, body, stdout)) return;
    const credentialStatus =
      body.provider?.credentialConfigured === true
        ? "existing credential preserved"
        : "credential not configured; configure it before use";
    writeStatusLine(stdout, `OK AI provider ${escapeTerminalText(provider)} saved; ${credentialStatus}`);
    return;
  }

  if (group === "providers" && action === "delete") {
    requireProvider(provider, "ai providers delete");
    if (extraArg) throw unexpectedArgument("ai providers delete", extraArg);
    const { headers } = context.resolveControl();
    await confirmAction({
      yes: values.yes === true,
      stdin,
      stderr,
      prompt: `Are you sure you want to delete AI provider "${ns}/${provider}" and its credential? [y/N] `,
      action: `delete AI provider "${ns}/${provider}"`,
    });
    const body = /** @type {{ ok?: boolean, deleted?: boolean }} */ (
      await context.fetchJson(
        context.nsUrl("ai", "providers", provider),
        { method: "DELETE", headers },
        "delete AI provider"
      )
    );
    if (writeJsonOr(values.json === true, body, stdout)) return;
    writeStatusLine(
      stdout,
      body.deleted === true
        ? `OK AI provider ${escapeTerminalText(provider)} and its credential deleted`
        : `(AI provider ${escapeTerminalText(provider)} was not configured)`
    );
    return;
  }

  if (group === "credential" && action === "put") {
    requireProvider(provider, "ai credential put");
    if (extraArg) throw unexpectedArgument("ai credential put", extraArg);
    const { headers } = context.resolveControl();
    const providerBody = /** @type {AiProviderResponse} */ (
      await context.fetchJson(context.nsUrl("ai", "providers", provider), { headers }, "get AI provider")
    );
    const revision = providerBody.provider?.revision;
    if (typeof revision !== "string" || !revision) {
      throw new CliError("AI provider response did not include a revision");
    }
    const credential = await readSecretStdin(stdin, {
      prompt: `Enter credential for ${ns}/${provider} (input hidden): `,
      stderr,
    });
    if (!credential) throw new CliError("AI credential must not be empty");
    const body = await context.fetchJson(
      context.nsUrl("ai", "providers", provider, "credential"),
      {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ revision, credential }),
      },
      "put AI credential"
    );
    if (writeJsonOr(values.json === true, body, stdout)) return;
    writeStatusLine(stdout, `OK AI credential configured for ${escapeTerminalText(provider)}`);
    return;
  }

  throw new CliError(`unknown ai command: ${escapeTerminalText(positionals.join(" "))}\n${usageText()}`);
}

/** @param {string | undefined} provider @param {string} commandName */
function requireProvider(provider, commandName) {
  if (!provider) throw new CliError(`${commandName} requires <provider>`);
}

/** @param {string | undefined} file @param {string} cwd */
function readProviderFile(file, cwd) {
  if (typeof file !== "string" || !file) throw new CliError("ai providers put requires --file <path>");
  if (!existsSync(cwd)) throw new CliError(`working directory ${escapeTerminalText(cwd)} does not exist`);
  const root = realpathSync(cwd);
  const candidate = path.resolve(root, file);
  const resolved = existsSync(candidate) ? realpathSync(candidate) : candidate;
  if (!isPathInside(root, resolved)) throw new CliError("--file must stay inside the project");
  let text;
  try {
    text = readFileSync(resolved, "utf8");
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    throw new CliError(`cannot read AI provider file ${escapeTerminalText(file)}: ${escapeTerminalText(message)}`);
  }
  /** @type {unknown} */
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new CliError("AI provider file must contain valid JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new CliError("AI provider file must contain a JSON object");
  }
  return parsed;
}

/** @typedef {{ providers?: Array<{ name?: unknown, kind?: unknown, models?: unknown, credentialConfigured?: unknown }> }} AiProvidersResponse */
/** @typedef {{ provider?: { name?: unknown, kind?: unknown, revision?: unknown, models?: Record<string, { protocol?: unknown }>, credentialConfigured?: unknown } }} AiProviderResponse */
/** @typedef {{ models?: Array<{ id?: unknown, protocol?: unknown, transports?: unknown }> }} AiModelsResponse */

function usageText() {
  return formatHelp({
    usage: [
      "wdl ai providers list [options]",
      "wdl ai providers get [options] <provider>",
      "wdl ai providers put [options] <provider> --file <path>",
      "wdl ai providers delete [options] <provider> [--yes]",
      "wdl ai credential put [options] <provider>",
      "wdl ai models [options]",
    ],
    description: "Manage namespace-scoped AI provider metadata, credentials, and available models.",
    options: optionHelp(AI_OPTIONS),
  });
}

if (isMain(import.meta.url)) {
  await main();
}
