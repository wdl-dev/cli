// The `wdl token` command set: store, list, switch the default for, and remove
// tokens in the global credential store (lib/token-store.js). There is no
// "login" — a token is operator-issued; `set` stores it after validating it
// against /whoami (and makes the first one the default namespace), `use` picks
// which stored namespace is the default when --ns is omitted, and `rm` deletes
// the local copy without revoking it.

import { defineCommand } from "../lib/command.js";
import {
  CliError,
  defineCliOption,
  escapeTerminalText,
  formatHelp,
  isMain,
  optionHelp,
  readTtyLine,
  resolveControlUrl,
  warnIfInsecureControlUrl,
  writeResult,
} from "../lib/common.js";
import { maskToken } from "../lib/config-state.js";
import { fetchWhoami, namespaceFromPrincipal } from "../lib/whoami.js";
import { readTokenStore, tokenStorePath, writeTokenStore } from "../lib/token-store.js";

const TOKEN_OPTIONS = [
  defineCliOption("label", { type: "string" }, "--label <text>", "Human label shown by `wdl token list` (set)."),
  defineCliOption("default", { type: "boolean" }, "--default", "Make this the default namespace, used when --ns is omitted (set)."),
  "ns",
  // `endpoint`, not `control`: the token is read from stdin, never a --token flag.
  "endpoint",
  // Custom json option: `list --json` prints the local store, not a control
  // response, so the preset's description would be wrong here.
  defineCliOption("json", { type: "boolean" }, "--json", "Print stored entries as JSON (tokens masked)."),
  "help",
];

const command = defineCommand({
  name: "token",
  summary: "Store, list, switch the default for, and remove control-plane tokens locally.",
  options: TOKEN_OPTIONS,
  autoloadEnv: false,
  usage: usageText,
  run: runToken,
});

export const main = command.main;
export const runTokenCommand = command.run;
export const meta = command.meta;

/** @param {{ values: Record<string, any>, positionals: string[], context: import("../lib/command.js").CommandContext }} arg */
async function runToken({ values, positionals, context }) {
  const [sub, ...rest] = positionals;
  // `use` takes the namespace as a positional (`wdl token use acme`); the
  // others take none beyond the subcommand.
  if (sub !== "use" && rest.length > 0) throw new CliError(usageText());
  switch (sub) {
    case "set":
      return tokenSet({ values, context });
    case "list":
      return tokenList({ values, context });
    case "use":
      if (rest.length > 1) throw new CliError(usageText());
      return tokenUse({ context, nsArg: rest[0] });
    case "rm":
      return tokenRemove({ context });
    default:
      throw new CliError(usageText());
  }
}

async function tokenSet({ values, context }) {
  const ns = context.resolveNamespace();
  if (!ns) throw new CliError("token set requires --ns <namespace>");
  // The control URL comes from flags/shell only, never the store — we are
  // writing the store, so it cannot supply its own endpoint. Give a token-set
  // message rather than resolveControlUrl's generic "set it in .env" hint,
  // which would be backwards here (the store exists to avoid a .env).
  if (!values["control-url"] && !values.admin && !context.env.CONTROL_URL && !context.env.ADMIN_URL) {
    throw new CliError(
      `token set needs the control URL for ${ns}: pass --control-url <url> (a stored token is scoped to one control plane).`
    );
  }
  const controlUrl = resolveControlUrl(values, context.env);
  // Warn before a plaintext token travels unencrypted, like every other path
  // that sends the token.
  warnIfInsecureControlUrl(controlUrl, context.warn);

  const token = (await readStdin(context.stdin, {
    prompt: `Token for ${ns} @ ${controlUrl} (input hidden): `,
    stderr: context.stderr,
  })).trim();
  if (!token) throw new CliError("no token provided on stdin");

  // Validate before storing so a typo'd or revoked token is never persisted,
  // and confirm the token actually belongs to this namespace — otherwise it
  // would be stored under [ns] while authenticating as someone else.
  const whoami = await fetchWhoami({
    controlUrl,
    headers: { "x-admin-token": token },
    controlFetch: context.controlFetch,
  });
  const principalNs = namespaceFromPrincipal(whoami.principal);
  if (principalNs !== ns) {
    throw new CliError(
      principalNs
        ? `token principal is namespace "${principalNs}", not "${ns}" — run with --ns ${principalNs}`
        : `this token is not scoped to namespace "${ns}"; wdl token stores tenant tokens under their own namespace`
    );
  }

  const storePath = tokenStorePath(context.env);
  const store = readTokenStore(storePath);
  const previous = store.namespaces[ns] || {};
  store.namespaces[ns] = {
    CONTROL_URL: controlUrl,
    ADMIN_TOKEN: token,
    LABEL: typeof values.label === "string" ? values.label : previous.LABEL,
  };
  // The first stored namespace (no default yet), or an explicit --default,
  // becomes the default used when --ns/WDL_NS is omitted — the store's analogue
  // of a base WDL_NS in a project .env.
  const becameDefault = Boolean(values.default) || !store.defaultNs;
  if (becameDefault) store.defaultNs = ns;
  writeTokenStore(storePath, store);
  context.stdout(
    `Stored token for ${escapeTerminalText(ns)} @ ${escapeTerminalText(controlUrl)} (${maskToken(token)}).`
  );
  if (becameDefault) {
    context.stdout(`${escapeTerminalText(ns)} is now the default namespace (used when --ns is omitted).`);
  }
}

function tokenUse({ context, nsArg }) {
  const ns = nsArg || context.resolveNamespace();
  if (!ns) throw new CliError("token use requires a namespace: wdl token use <namespace>");
  const storePath = tokenStorePath(context.env);
  const store = readTokenStore(storePath);
  if (!store.namespaces[ns]) {
    throw new CliError(`no stored token for namespace "${ns}" — run \`wdl token set --ns ${ns}\` first`);
  }
  store.defaultNs = ns;
  writeTokenStore(storePath, store);
  context.stdout(`Default namespace set to ${escapeTerminalText(ns)} (used when --ns is omitted).`);
}

function tokenList({ values, context }) {
  const store = readTokenStore(tokenStorePath(context.env));
  const rows = Object.keys(store.namespaces).sort().map((ns) => ({
    default: store.defaultNs === ns,
    namespace: ns,
    label: store.namespaces[ns].LABEL || "",
    controlUrl: store.namespaces[ns].CONTROL_URL || "",
    token: maskToken(store.namespaces[ns].ADMIN_TOKEN),
  }));
  writeResult(values.json, rows, () => formatTokenList(rows), context.stdout);
}

function tokenRemove({ context }) {
  const ns = context.resolveNamespace();
  if (!ns) throw new CliError("token rm requires --ns <namespace>");
  const storePath = tokenStorePath(context.env);
  const store = readTokenStore(storePath);
  if (!store.namespaces[ns]) throw new CliError(`no stored token for namespace "${ns}"`);
  delete store.namespaces[ns];
  // Preserve the "a lone stored namespace is the default" invariant: if we
  // removed the default, promote a sole survivor, else clear it (an ambiguous
  // set of remaining namespaces needs an explicit --ns or `wdl token use`).
  if (store.defaultNs === ns) {
    const remaining = Object.keys(store.namespaces);
    store.defaultNs = remaining.length === 1 ? remaining[0] : null;
  }
  writeTokenStore(storePath, store);
  context.stdout(
    `Removed the stored token for ${escapeTerminalText(ns)}. This does not revoke it on the control plane.`
  );
}

// Returns an array of lines; writeResult escapes each one at its choke point.
function formatTokenList(rows) {
  if (rows.length === 0) return ["(no stored tokens)"];
  const header = ["", "NAMESPACE", "LABEL", "CONTROL URL", "TOKEN"];
  const cells = [header, ...rows.map((r) => [r.default ? "*" : "", r.namespace, r.label, r.controlUrl, r.token])];
  const widths = header.map((_, col) => Math.max(...cells.map((l) => l[col].length)));
  const lines = cells.map((l) => l.map((cell, col) => cell.padEnd(widths[col])).join("  ").trimEnd());
  if (rows.some((r) => r.default)) lines.push("", "* default namespace (used when --ns is omitted)");
  return lines;
}

// Read a single line: a TTY prompts without echo; a pipe is read to EOF.
/**
 * @param {{ isTTY?: boolean, setEncoding: (encoding: string) => void, on: Function, off: Function, pause?: Function }} stdin
 * @param {{ prompt?: string, stderr?: (text: string) => void }} [options]
 */
function readStdin(stdin, { prompt, stderr } = {}) {
  if (stdin.isTTY) return readTtyLine(stdin, { prompt, stderr });
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
      "wdl token set --ns <namespace> [--control-url <url>] [--label <text>] [--default]",
      "wdl token list [--json]",
      "wdl token use <namespace>",
      "wdl token rm --ns <namespace>",
    ],
    description: "Store, list, and remove tokens in the local credential store (~/.config/wdl/credentials).",
    options: optionHelp(TOKEN_OPTIONS),
  });
}

if (isMain(import.meta.url)) {
  await main();
}
