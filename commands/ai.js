import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

import {
  AI_PROVIDER_KINDS,
  createAiProviderConfig,
  defaultAiProviderModel,
  defaultAiProviderFile,
  writeAiProviderFile,
} from "../lib/ai-provider-init.js";
import { defineCommand } from "../lib/command.js";
import {
  CliError,
  defineCliOption,
  formatHelp,
  isMain,
  isPathInside,
  optionHelp,
  readJsonOrFailWithHint,
  redactedArgumentError,
  sensitiveInputArgumentError,
} from "../lib/common.js";
import { escapeTerminalText, shellSingleQuote, writeJsonOr, writeStatusLine } from "../lib/output.js";
import { isSecretEnvelopeErrorCode } from "../lib/secret-envelope-errors.js";
import { confirmAction, readSecretStdin, readTtyLines } from "../lib/stdin.js";

const AI_OPTIONS = [
  defineCliOption("file", { type: "string" }, "--file <path>", "Provider JSON input or init output file."),
  defineCliOption("kind", { type: "string" }, "--kind <kind>", "Override the inferred provider kind for init."),
  defineCliOption("model", { type: "string" }, "--model <id>", "Override the default upstream model id."),
  defineCliOption("alias", { type: "string" }, "--alias <name>", "Model alias for providers init (default: primary)."),
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
  sensitiveInput: {
    commandPaths: [
      ["models"],
      ["providers", "list"],
      ["providers", "get"],
      ["providers", "put"],
      ["providers", "delete"],
      ["providers", "init"],
      ["credential", "put"],
    ],
  },
  defaults: { readLines: readTtyLines },
  autoloadEnv: (positionals) => !isProviderInitCommand(positionals),
  usage: usageText,
  run: runAi,
});

export const main = command.main;
export const runAiCommand = command.run;
export const meta = command.meta;

/**
 * @typedef {import("../lib/command.js").PresetFlags<"ns" | "control" | "json"> & {
 *   file?: string,
 *   kind?: string,
 *   model?: string,
 *   alias?: string,
 *   yes?: boolean,
 * }} AiFlags
 */

/** @param {{ values: AiFlags, positionals: string[], context: import("../lib/command.js").CommandContext & { readLines: typeof readTtyLines } }} arg */
async function runAi({ values, positionals, context }) {
  const { stdout, stderr, stdin } = context;
  const [group, action, provider] = positionals;
  const extraArg = positionals[3];

  if (group === "providers" && action === "init") {
    requireProvider(provider, "ai providers init");
    if (extraArg) throw redactedArgumentError("ai providers init");
    await initProviderFile(values, provider, context);
    return;
  }

  const ns = context.resolveNamespace();
  if (!group || !ns) throw new CliError(usageText());

  if (group === "models") {
    if (action) throw redactedArgumentError("ai models");
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
        `${String(model.id ?? "-")} protocol=${String(model.protocol ?? "-")} transports=${transports}`
      );
    }
    return;
  }

  if (group === "providers" && action === "list") {
    if (provider) throw redactedArgumentError("ai providers list");
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
        `${String(entry.name ?? "-")} kind=${String(entry.kind ?? "-")} models=${modelCount} credential=${entry.credentialConfigured === true ? "configured" : "missing"}`
      );
    }
    return;
  }

  if (group === "providers" && action === "get") {
    requireProvider(provider, "ai providers get");
    if (extraArg) throw redactedArgumentError("ai providers get");
    const { headers } = context.resolveControl();
    const body = /** @type {AiProviderResponse} */ (
      await context.fetchJson(context.nsUrl("ai", "providers", provider), { headers }, "get AI provider")
    );
    if (writeJsonOr(values.json === true, body, stdout)) return;
    const entry = body.provider;
    writeStatusLine(stdout, `name: ${String(entry?.name ?? provider)}`);
    writeStatusLine(stdout, `kind: ${String(entry?.kind ?? "-")}`);
    writeStatusLine(stdout, `revision: ${String(entry?.revision ?? "-")}`);
    writeStatusLine(stdout, `credential: ${entry?.credentialConfigured === true ? "configured" : "missing"}`);
    for (const [alias, descriptor] of Object.entries(entry?.models ?? {})) {
      const protocol = descriptor && typeof descriptor === "object" ? descriptor.protocol : undefined;
      writeStatusLine(stdout, `model: ${alias} (${String(protocol ?? "-")})`);
    }
    return;
  }

  if (group === "providers" && action === "put") {
    requireProvider(provider, "ai providers put");
    if (extraArg) throw redactedArgumentError("ai providers put");
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
    writeStatusLine(stdout, `OK AI provider ${provider} saved; ${credentialStatus}`);
    return;
  }

  if (group === "providers" && action === "delete") {
    requireProvider(provider, "ai providers delete");
    if (extraArg) throw redactedArgumentError("ai providers delete");
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
        ? `OK AI provider ${provider} and its credential deleted`
        : `(AI provider ${provider} was not configured)`
    );
    return;
  }

  if (group === "credential" && action === "put") {
    requireProvider(provider, "ai credential put");
    if (extraArg) throw sensitiveInputArgumentError("ai credential put");
    const { headers } = context.resolveControl();
    const providerBody = /** @type {AiProviderResponse} */ (
      await fetchAiJsonWithHint(
        context,
        context.nsUrl("ai", "providers", provider),
        { headers },
        "prepare AI credential",
        aiCredentialPreflightHint
      )
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
    const body = await fetchAiJsonWithHint(
      context,
      context.nsUrl("ai", "providers", provider, "credential"),
      {
        method: "PUT",
        headers: { ...headers, "content-type": "application/json" },
        body: JSON.stringify({ revision, credential }),
      },
      "put AI credential",
      aiCredentialMutationHint
    );
    if (writeJsonOr(values.json === true, body, stdout)) return;
    writeStatusLine(stdout, `OK AI credential configured for ${provider}`);
    return;
  }

  if (group === "credential") {
    throw new CliError(`unknown ai credential command; expected "put"\n${usageText()}`);
  }

  throw new CliError(`unknown ai command\n${usageText()}`);
}

/** @param {string | undefined} provider @param {string} commandName */
function requireProvider(provider, commandName) {
  if (!provider) throw new CliError(`${commandName} requires <provider>`);
}

/**
 * @param {AiFlags} values
 * @param {string} provider
 * @param {import("../lib/command.js").CommandContext & { readLines: typeof readTtyLines }} context
 */
async function initProviderFile(values, provider, context) {
  const { kind, alias, upstreamModel, file } = await collectInitValues(values, provider, context);

  const body = createAiProviderConfig({ provider, kind, alias, upstreamModel });
  const writtenFile = writeAiProviderFile(context.cwd, file, body);

  writeStatusLine(context.stdout, `Created ${writtenFile}.`);
  writeStatusLine(context.stdout, "Review the generated modalities and capabilities before uploading it.");
  writeStatusLine(
    context.stdout,
    `Next: wdl ai providers put ${shellSingleQuote(provider)} --file ${shellSingleQuote(writtenFile)} --ns <namespace>`
  );
}

/**
 * @param {AiFlags} values
 * @param {string} provider
 * @param {import("../lib/command.js").CommandContext & { readLines: typeof readTtyLines }} context
 */
async function collectInitValues(values, provider, context) {
  const provided = {
    kind: typeof values.kind === "string" ? values.kind.trim() : "",
    alias: typeof values.alias === "string" ? values.alias.trim() : "",
    upstreamModel: typeof values.model === "string" ? values.model.trim() : "",
    file: typeof values.file === "string" ? values.file.trim() : "",
  };
  const defaultKind = AI_PROVIDER_KINDS.includes(provider) ? provider : "openai";
  const defaultFile = defaultAiProviderFile(provider);
  /** @type {Record<string, string>} */
  const entered = {};
  if (context.stdin.isTTY) {
    /** @param {readonly string[]} answers */
    const modelPrompt = (answers) => {
      const kind = provided.kind || answers[0]?.trim() || defaultKind;
      const model = defaultAiProviderModel(kind);
      return model ? `Upstream model id [${model}]: ` : "Upstream model id: ";
    };
    const fields = [
      {
        key: "kind",
        value: provided.kind,
        prompt: `Provider kind (${AI_PROVIDER_KINDS.join("/")}) [${defaultKind}]: `,
      },
      { key: "alias", value: provided.alias, prompt: "Model alias [primary]: " },
      { key: "upstreamModel", value: provided.upstreamModel, prompt: modelPrompt },
      { key: "file", value: provided.file, prompt: `Output file [${defaultFile}]: ` },
    ];
    const missing = fields.filter((field) => !field.value);
    const answers = await context.readLines(context.stdin, {
      prompts: missing.map((field) => field.prompt),
      stderr: context.stderr,
    });
    for (const [index, field] of missing.entries()) {
      entered[field.key] = answers[index]?.trim() ?? "";
    }
  }
  const kind = provided.kind || entered.kind || defaultKind;
  return {
    kind,
    alias: provided.alias || entered.alias || "primary",
    upstreamModel: provided.upstreamModel || entered.upstreamModel || defaultAiProviderModel(kind) || "",
    file: provided.file || entered.file || defaultFile,
  };
}

/** @param {string[]} positionals */
function isProviderInitCommand(positionals) {
  return positionals[0] === "providers" && positionals[1] === "init";
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

/**
 * @param {import("../lib/command.js").CommandContext} context
 * @param {string} url
 * @param {import("../lib/control-fetch.js").ControlFetchInit} init
 * @param {string} label
 * @param {(error: unknown) => string} errorHint
 */
async function fetchAiJsonWithHint(context, url, init, label, errorHint) {
  const res = await context.controlFetch(url, { ...init, env: init.env ?? context.env });
  return await readJsonOrFailWithHint(res, label, errorHint);
}

/** @param {unknown} error */
function aiCredentialPreflightHint(error) {
  if (error === "ai_provider_not_found") {
    return "; create the provider with `wdl ai providers put` before configuring its credential.";
  }
  return "";
}

/** @param {unknown} error */
function aiCredentialMutationHint(error) {
  if (error === "ai_provider_revision_mismatch") {
    return "; credential was not written. Provider metadata changed while input was being entered; rerun this command.";
  }
  if (error === "ai_credential_encryption_unavailable" || isSecretEnvelopeErrorCode(error)) {
    return "; credential was not written. Secret-envelope configuration or stored secret data needs operator repair before retrying.";
  }
  return "";
}

/** @typedef {{ providers?: Array<{ name?: unknown, kind?: unknown, models?: unknown, credentialConfigured?: unknown }> }} AiProvidersResponse */
/** @typedef {{ provider?: { name?: unknown, kind?: unknown, revision?: unknown, models?: Record<string, { protocol?: unknown }>, credentialConfigured?: unknown } }} AiProviderResponse */
/** @typedef {{ models?: Array<{ id?: unknown, protocol?: unknown, transports?: unknown }> }} AiModelsResponse */

function usageText() {
  return formatHelp({
    usage: [
      "wdl ai providers list [options]",
      "wdl ai providers get [options] <provider>",
      "wdl ai providers init [options] <provider>",
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
