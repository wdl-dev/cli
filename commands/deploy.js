// Shell out to wrangler dry-run so local bundling stays aligned with
// `wrangler dev` / Wrangler's own module resolution pipeline.

import { execFileSync } from "node:child_process";
import { LONG_CONTROL_TIMEOUT_MS } from "../lib/control-fetch.js";
import { defineCommand } from "../lib/command.js";
import { CliError, defineCliOption, formatHelp, isMain, optionHelp } from "../lib/common.js";
import { escapeTerminalText, formatKnownWarning, writeStatusLine } from "../lib/output.js";
import { isLocalDevHost } from "../lib/credentials.js";
import { packWranglerProject } from "../lib/wrangler-pack.js";

export const DEPLOY_JSON_BODY_MAX_BYTES = 32 * 1024 * 1024;

const DEPLOY_OPTIONS = [
  defineCliOption("env", { type: "string" }, "--env <name>", "Wrangler environment (env: CLOUDFLARE_ENV)."),
  defineCliOption("verbose", { type: "boolean" }, "--verbose", "Show Wrangler dry-run output."),
  "ns",
  "control",
  "help",
];

function usageText() {
  return formatHelp({
    usage: ["wdl deploy <project-dir> [options]"],
    description: "Bundle a Wrangler project, upload it to control, and promote the new version.",
    options: optionHelp(DEPLOY_OPTIONS),
  });
}

/**
 * One platform-binding deploy warning surfaced by control.
 * @typedef {object} DeployWarning
 * @property {string} [code]
 * @property {string} [message]
 * @property {string} [binding]
 * @property {string} [platform]
 * @property {string} [className]
 * @property {string} [entrypoint]
 * @property {string[]} [missingCallerSecrets]
 */

// Upload a packed manifest to control + promote. Token rides authHeaders.
// controlUrl is passed only for the readable upload log line; the fetch URLs
// are built via context.nsUrl so segment encoding stays consistent.
/**
 * @param {{
 *   context: import("../lib/command.js").CommandContext,
 *   ns: string,
 *   workerName: string,
 *   manifest: unknown,
 *   controlUrl: string,
 *   authHeaders: Record<string, string>,
 * }} arg
 * @returns {Promise<{ version: unknown, platformDomain: unknown }>}
 */
export async function postArtifactToControl({ context, ns, workerName, manifest, controlUrl, authHeaders }) {
  const { stdout, stderr } = context;
  const jsonHeaders = {
    "content-type": "application/json",
    ...authHeaders,
  };
  const deployBody = serializeDeployManifest(manifest);

  writeStatusLine(stdout, `[2/3] uploading ${workerName} → ${controlUrl}/ns/${ns}`);
  // `version` comes from the control response; keep the raw value for the
  // promote request body — display sites escape via writeStatusLine.
  const { version, warnings } = /** @type {{ version: unknown, warnings?: DeployWarning[] }} */ (
    await context.fetchJson(
      context.nsUrl("worker", workerName, "deploy"),
      {
        method: "POST",
        headers: jsonHeaders,
        body: deployBody,
        timeoutMs: LONG_CONTROL_TIMEOUT_MS,
      },
      "deploy",
    )
  );
  // Control's deploy warnings are the only signal for several binding
  // misconfigurations — surface them so failures don't defer to runtime.
  if (Array.isArray(warnings) && warnings.length) {
    for (const w of warnings) {
      if (w && Array.isArray(w.missingCallerSecrets) && w.missingCallerSecrets.length) {
        const keys = escapeTerminalText(w.missingCallerSecrets.join(", "));
        stderr(
          `warning: platform binding "${escapeTerminalText(w.binding)}" (platform="${escapeTerminalText(w.platform)}"): ` +
          `missing caller secrets ${keys}\n` +
          `  ns-wide:    wdl secret put --ns ${ns} --scope ns <KEY>\n` +
          `  per-worker: wdl secret put --ns ${ns} --worker ${workerName} <KEY>`
        );
      } else {
        stderr(`warning: ${formatKnownWarning(w, DEPLOY_WARNING_KEYS)}`);
      }
    }
  }

  writeStatusLine(stdout, `[3/3] promoting ${version}`);
  /** @type {{ platformDomain?: unknown }} */
  let promoteBody;
  try {
    promoteBody = /** @type {{ platformDomain?: unknown }} */ (
      await context.fetchJson(
        context.nsUrl("worker", workerName, "promote"),
        {
          method: "POST",
          headers: jsonHeaders,
          body: JSON.stringify({ version }),
        },
        "promote",
      )
    );
  } catch (err) {
    stderr(
      `note: version ${escapeTerminalText(String(version))} was uploaded and retained but NOT promoted; ` +
      `the previously active version still serves traffic. Re-run \`wdl deploy\` to retry.`
    );
    throw err;
  }
  return { version, platformDomain: promoteBody.platformDomain };
}

/**
 * @param {unknown} manifest
 * @param {number} [maxBytes]
 * @returns {string}
 */
export function serializeDeployManifest(manifest, maxBytes = DEPLOY_JSON_BODY_MAX_BYTES) {
  const body = JSON.stringify(manifest);
  const bodyBytes = Buffer.byteLength(body);
  if (bodyBytes > maxBytes) {
    throw new CliError(
      `deploy manifest is ${bodyBytes} bytes, exceeds ${maxBytes} byte control-plane request cap`
    );
  }
  return body;
}

const DEPLOY_WARNING_KEYS = [
  "code",
  "message",
  "binding",
  "platform",
  "className",
  "entrypoint",
];

const command = defineCommand({
  name: "deploy",
  summary: "Bundle and deploy a Wrangler project, then promote it.",
  options: DEPLOY_OPTIONS,
  // console.error keeps stderr line-buffered with a trailing newline, unlike
  // the bare process.stderr.write default the framework uses elsewhere.
  defaults: { stderr: (line = "") => console.error(line), execFile: execFileSync },
  usage: usageText,
  run: runDeploy,
});

export const main = command.main;
export const runDeployCommand = command.run;
export const meta = command.meta;

/**
 * `execFile` is injected via this command's `defaults`.
 * @typedef {import("../lib/command.js").CommandContext & { execFile: typeof execFileSync }} DeployContext
 */

/** @param {{ values: { env?: string, verbose?: boolean }, positionals: string[], context: import("../lib/command.js").CommandContext }} arg */
async function runDeploy({ values, positionals, context: baseContext }) {
  const context = /** @type {DeployContext} */ (baseContext);
  const { env, stdout, stderr, cwd, execFile } = context;

  const ns = context.resolveNamespace();
  const [projectDir] = positionals;
  if (!projectDir || !ns) {
    throw new CliError(usageText());
  }

  const { controlUrl, headers: authHeaders } = context.resolveControl();
  const selectedEnv = values.env || env.CLOUDFLARE_ENV || null;

  // Cast past packWranglerProject's defaults-inferred (narrower) param types.
  const packOptions = /** @type {Parameters<typeof packWranglerProject>[0]} */ ({
    cwd,
    projectDir,
    envName: selectedEnv,
    env,
    execFile,
    stdout,
    stderr,
    verbose: values.verbose,
  });
  const { workerName, manifest } = await packWranglerProject(packOptions);

  const { version, platformDomain } = await postArtifactToControl({
    context,
    ns,
    workerName,
    manifest,
    controlUrl,
    authHeaders,
  });

  stdout("");
  writeStatusLine(stdout, `✓ ${ns}/${workerName}@${version} live`);
  const controlHost = new URL(controlUrl).hostname;
  const isLocal = isLocalDevHost(controlHost);
  if (isLocal) {
    const host = `${ns}.${platformDomain || "workers.local"}`;
    writeStatusLine(stdout, `  http://${host}:8080/${workerName}/`);
  } else if (platformDomain) {
    writeStatusLine(stdout, `  https://${ns}.${platformDomain}/${workerName}/`);
  }
}

if (isMain(import.meta.url)) {
  await main();
}
