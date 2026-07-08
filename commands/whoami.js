import { defineCommand } from "../lib/command.js";
import { CliError, formatHelp, isMain, optionHelp } from "../lib/common.js";
import { warnIfInsecureControlUrl } from "../lib/credentials.js";
import { writeResult } from "../lib/output.js";
import { resolveCliConfigState } from "../lib/config-state.js";
import {
  displayRemoteValue,
  ensureControlContextFromConfigState,
  fetchWhoami,
  namespaceFromPrincipal,
  summarizeWhoami,
} from "../lib/whoami.js";

const WHOAMI_OPTIONS = ["ns", "control", "json", "help"];

const command = defineCommand({
  name: "whoami",
  summary: "Show the authenticated control-plane identity.",
  options: WHOAMI_OPTIONS,
  autoloadEnv: false,
  usage: usageText,
  run: runWhoami,
});

export const main = command.main;
export const runWhoamiCommand = command.run;
export const meta = command.meta;

/** @param {{ values: import("../lib/command.js").PresetFlags<"ns" | "control" | "json">, positionals: string[], context: import("../lib/command.js").CommandContext }} arg */
async function runWhoami({ values, positionals, context }) {
  if (positionals.length > 0) throw new CliError(usageText());

  const state = resolveCliConfigState({ values, env: context.env, cwd: context.cwd, warn: context.warn });
  const control = ensureControlContextFromConfigState(state);
  warnIfInsecureControlUrl(control.controlUrl, context.warn, state.env);
  const remote = summarizeWhoami(await fetchWhoami({
    controlUrl: control.controlUrl,
    headers: control.headers,
    controlFetch: context.controlFetch,
    env: state.env,
  }));
  const body = buildWhoamiBody(state, remote);
  writeResult(values.json === true, body, () => formatWhoami(body), context.stdout);
}

/**
 * @param {ReturnType<typeof resolveCliConfigState>} state
 * @param {ReturnType<typeof summarizeWhoami>} remote
 */
function buildWhoamiBody(state, remote) {
  const principalNamespace = namespaceFromPrincipal(remote.principal) || "";
  return {
    controlUrl: {
      value: state.controlUrl.display,
      source: state.controlUrl.source,
      reached: remote.urls.control || "",
    },
    namespace: {
      value: principalNamespace || state.namespace.value || "",
      source: principalNamespace ? "token principal" : state.namespace.source,
      configured: state.namespace.value || "",
      matchesConfigured: !state.namespace.value || !principalNamespace || state.namespace.value === principalNamespace,
    },
    principal: remote.principal,
    principalLabel: remote.principalLabel,
    token: {
      value: state.token.display,
      source: state.token.source,
      id: remote.tokenId,
    },
    requestId: remote.requestId,
    platformVersion: remote.platformVersion,
    minCliVersion: remote.minCliVersion,
    cliVersion: remote.cliVersion,
    compatibility: remote.compatibility,
    urls: remote.urls,
  };
}

/** @param {ReturnType<typeof buildWhoamiBody>} body */
function formatWhoami(body) {
  const lines = [
    `Control URL: ${displayRemoteValue(body.controlUrl.reached || body.controlUrl.value)}`,
    `Namespace:   ${displayRemoteValue(body.namespace.value)}`,
    `Principal:   ${displayRemoteValue(body.principalLabel)}`,
    `Token ID:    ${displayRemoteValue(body.token.id)}`,
    `Platform:    ${displayRemoteValue(body.platformVersion)}`,
    `Min CLI:     ${displayRemoteValue(body.minCliVersion)}`,
    `CLI:         wdl-cli ${displayRemoteValue(body.cliVersion)}`,
    `Compat:      ${body.compatibility.ok ? "ok" : "fail"} - ${displayRemoteValue(body.compatibility.detail)}`,
    `Request ID:  ${displayRemoteValue(body.requestId)}`,
    `Namespace URL: ${displayRemoteValue(body.urls.namespace)}`,
    `Assets URL:    ${displayRemoteValue(body.urls.assets)}`,
  ];
  if (!body.namespace.matchesConfigured) {
    lines.push(`Configured NS: ${displayRemoteValue(body.namespace.configured)} (token principal is ${displayRemoteValue(body.namespace.value)})`);
  }
  return lines;
}

function usageText() {
  return formatHelp({
    usage: ["wdl whoami [options]"],
    description: "Call control-plane /whoami and show the active token principal, platform version, and URL hints.",
    options: optionHelp(WHOAMI_OPTIONS),
  });
}

if (isMain(import.meta.url)) {
  await main();
}
