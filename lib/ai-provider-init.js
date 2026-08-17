import { existsSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";

import { CliError, isPathInside } from "./common.js";
import { escapeTerminalText } from "./output.js";

export const AI_PROVIDER_KINDS = Object.freeze(["openai", "xai", "deepseek"]);

/** @param {string | undefined} kind */
export function defaultAiProviderModel(kind) {
  switch (kind) {
    case "openai":
      return "gpt-5.6-luna";
    case "xai":
      return "grok-4.6";
    case "deepseek":
      return "deepseek-v4-flash";
    default:
      return undefined;
  }
}

const PROVIDER_NAME_RE = /^[a-z0-9](?:[a-z0-9-]{0,30}[a-z0-9])?$/;
const MODEL_ALIAS_RE = /^(?![0-9]+$)[a-z0-9](?:[a-z0-9._-]{0,62}[a-z0-9])?$/;

/** @param {string} provider */
export function defaultAiProviderFile(provider) {
  validateProviderName(provider);
  return `provider.${provider}.json`;
}

/**
 * Create a conservative, broadly supported Responses descriptor. Users can
 * edit the generated JSON for model-specific protocols and capabilities;
 * Control remains the canonical validator.
 * @param {{ provider: string, kind: string, alias: string, upstreamModel: string }} input
 */
export function createAiProviderConfig({ provider, kind, alias, upstreamModel }) {
  validateProviderName(provider);
  if (!AI_PROVIDER_KINDS.includes(kind)) {
    throw new CliError(`--kind must be one of: ${AI_PROVIDER_KINDS.join(", ")}`);
  }
  if (!MODEL_ALIAS_RE.test(alias)) {
    throw new CliError(`--alias must match ${MODEL_ALIAS_RE}`);
  }
  const model = upstreamModel.trim();
  if (!model) throw new CliError("--model must be a non-empty upstream model id");

  return {
    kind,
    models: {
      [alias]: {
        upstreamModel: model,
        protocol: "responses",
        transports: ["http", "sse"],
        inputModalities: ["text"],
        outputModalities: ["text"],
        capabilities: {
          functionTools: false,
          structuredOutput: false,
          reasoning: false,
          previousResponseId: false,
          providerTools: false,
          binaryFrames: false,
        },
      },
    },
  };
}

/**
 * Write a new provider file below the project root without replacing an
 * existing path or following a parent directory outside the project.
 * @param {string} cwd
 * @param {string} file
 * @param {ReturnType<typeof createAiProviderConfig>} provider
 */
export function writeAiProviderFile(cwd, file, provider) {
  if (typeof file !== "string" || !file.trim()) throw new CliError("provider output file must not be empty");
  if (!existsSync(cwd)) throw new CliError(`working directory ${escapeTerminalText(cwd)} does not exist`);

  let root;
  try {
    root = realpathSync(cwd);
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    throw new CliError(`cannot resolve working directory: ${escapeTerminalText(message)}`);
  }
  const candidate = path.resolve(root, file);
  if (!isPathInside(root, candidate)) throw new CliError("provider output file must stay inside the project");

  const parent = path.dirname(candidate);
  let resolvedParent;
  try {
    resolvedParent = realpathSync(parent);
  } catch (err) {
    const message = err instanceof Error && err.message ? err.message : String(err);
    throw new CliError(`cannot resolve provider output directory: ${escapeTerminalText(message)}`);
  }
  if (!isPathInside(root, resolvedParent)) {
    throw new CliError("provider output file must stay inside the project");
  }

  const output = path.join(resolvedParent, path.basename(candidate));
  try {
    writeFileSync(output, `${JSON.stringify(provider, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  } catch (err) {
    if (err instanceof Error && /** @type {{ code?: unknown }} */ (err).code === "EEXIST") {
      throw new CliError(`provider output file ${escapeTerminalText(file)} already exists; refusing to overwrite it`);
    }
    const message = err instanceof Error && err.message ? err.message : String(err);
    throw new CliError(`cannot write provider output file ${escapeTerminalText(file)}: ${escapeTerminalText(message)}`);
  }
  return path.relative(root, output) || path.basename(output);
}

/** @param {string} provider */
function validateProviderName(provider) {
  if (!PROVIDER_NAME_RE.test(provider)) {
    throw new CliError(`provider name must match ${PROVIDER_NAME_RE}`);
  }
}
