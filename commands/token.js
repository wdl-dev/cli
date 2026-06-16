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
  flagSet,
  formatHelp,
  isMain,
  maskToken,
  optionHelp,
  readSecretStdin,
  resolveControlUrl,
  warnIfInsecureControlUrl,
  writeResult,
  writeStatusLine,
} from "../lib/common.js";
import { isAdminAcceptableNs } from "../lib/ns-pattern.js";
import { fetchWhoami, namespaceFromPrincipal } from "../lib/whoami.js";
import { readTokenStore, tokenStorePath, writeTokenStore } from "../lib/token-store.js";

const TOKEN_OPTIONS = [
  defineCliOption("label", { type: "string" }, "--label <text>", "Human label shown by `wdl token list` (set)."),
  defineCliOption("default", { type: "boolean" }, "--default", "Make this the default namespace, used when --ns is omitted (set)."),
  // Custom ns option: set/use/rm mutate the global store and ignore ambient
  // WDL_NS, so the shared preset's "(env: WDL_NS)" wording would mislead here.
  defineCliOption("ns", { type: "string" }, "--ns <ns>", "Namespace for set/use/rm (required; ignores WDL_NS)."),
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
      return tokenUse({ values, context, nsArg: rest[0] });
    case "rm":
      return tokenRemove({ values, context });
    default:
      throw new CliError(usageText());
  }
}

async function tokenSet({ values, context }) {
  // set/use/rm mutate the global store, so they name the target namespace from
  // an explicit --ns only -- never the ambient WDL_NS a user may have exported
  // for an unrelated command.
  const ns = flagSet(values, "ns") ? values.ns : null;
  if (!ns) throw new CliError("token set requires --ns <namespace>");
  // The namespace becomes a `[section]` key in the store file, so it must match
  // the same grammar store/.env sections use (tenant namespaces plus operator-
  // reserved `__name__` sections). A value with `]` or newlines (e.g. echoed
  // back via --ns from a misconfigured control plane) would otherwise inject
  // lines/sections and corrupt the file on the next read.
  if (!isAdminAcceptableNs(ns)) {
    throw new CliError(`invalid namespace "${escapeTerminalText(ns)}"`);
  }
  // The control URL comes from flags/shell only, never the store — we are
  // writing the store, so it cannot supply its own endpoint. Give a token-set
  // message rather than resolveControlUrl's generic "set it in .env" hint,
  // which would be backwards here (the store exists to avoid a .env).
  if (!values["control-url"] && !context.env.CONTROL_URL) {
    throw new CliError(
      `token set needs the control URL for ${ns}: pass --control-url <url> (a stored token is scoped to one control plane).`
    );
  }
  const controlUrl = resolveControlUrl(values, context.env);
  // Warn before a plaintext token travels unencrypted, like every other path
  // that sends the token.
  warnIfInsecureControlUrl(controlUrl, context.warn);

  const token = (await readSecretStdin(context.stdin, {
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
        ? `token principal is namespace "${escapeTerminalText(principalNs)}", not "${escapeTerminalText(ns)}" — run with --ns ${escapeTerminalText(principalNs)}`
        : `this token is not scoped to namespace "${escapeTerminalText(ns)}"; wdl token stores tenant tokens under their own namespace`
    );
  }

  const storePath = tokenStorePath(context.env);
  const store = readTokenStore(storePath);
  const previous = Object.hasOwn(store.namespaces, ns) ? store.namespaces[ns] : {};
  const wasEmpty = Object.keys(store.namespaces).length === 0;
  // defineProperty, not `store.namespaces[ns] = …`: a namespace named "__proto__"
  // would otherwise hit the prototype setter and never create an own section
  // (mirrors readTokenStore's section creation).
  Object.defineProperty(store.namespaces, ns, {
    value: {
      CONTROL_URL: controlUrl,
      ADMIN_TOKEN: token,
      LABEL: typeof values.label === "string" ? values.label : previous.LABEL,
    },
    writable: true,
    enumerable: true,
    configurable: true,
  });
  // Only the first stored namespace (an empty store) auto-becomes the default,
  // or an explicit --default. A later set must NOT silently steal the default
  // just because it is currently null — the default may have been deliberately
  // cleared by removing it from an ambiguous set.
  const becameDefault = Boolean(values.default) || wasEmpty;
  if (becameDefault) store.defaultNs = ns;
  writeTokenStore(storePath, store);
  writeStatusLine(context.stdout, `Stored token for ${ns} @ ${controlUrl} (${maskToken(token)}).`);
  if (becameDefault) {
    writeStatusLine(context.stdout, `${ns} is now the default namespace (used when --ns is omitted).`);
  }
}

function tokenUse({ values, context, nsArg }) {
  // For `use` the WDL_NS fallback is also pointless: it already overrides the
  // store default at resolution time, so inheriting it here would only reswitch
  // the default to a namespace the user did not name.
  const ns = nsArg || (flagSet(values, "ns") ? values.ns : null);
  if (!ns) throw new CliError("token use requires a namespace: wdl token use <namespace>");
  const storePath = tokenStorePath(context.env);
  const store = readTokenStore(storePath);
  if (!Object.hasOwn(store.namespaces, ns)) {
    throw new CliError(`no stored token for namespace "${escapeTerminalText(ns)}" — run \`wdl token set --ns ${escapeTerminalText(ns)}\` first`);
  }
  store.defaultNs = ns;
  writeTokenStore(storePath, store);
  writeStatusLine(context.stdout, `Default namespace set to ${ns} (used when --ns is omitted).`);
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

function tokenRemove({ values, context }) {
  // For `rm` the stakes are highest -- it deletes and rewrites with no
  // confirmation -- so it likewise takes an explicit --ns only.
  const ns = flagSet(values, "ns") ? values.ns : null;
  if (!ns) throw new CliError("token rm requires an explicit --ns <namespace>");
  const storePath = tokenStorePath(context.env);
  const store = readTokenStore(storePath);
  if (!Object.hasOwn(store.namespaces, ns)) throw new CliError(`no stored token for namespace "${escapeTerminalText(ns)}"`);
  delete store.namespaces[ns];
  // Keep the "a lone stored namespace is the default" invariant after any
  // removal: a sole survivor becomes the default even if an earlier removal
  // already cleared it; removing the current default from a still-ambiguous set
  // clears it (an explicit --ns or `wdl token use` is then needed).
  const remaining = Object.keys(store.namespaces);
  if (remaining.length === 1) store.defaultNs = remaining[0];
  else if (store.defaultNs === ns) store.defaultNs = null;
  writeTokenStore(storePath, store);
  writeStatusLine(context.stdout, `Removed the stored token for ${ns}. This does not revoke it on the control plane.`);
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
