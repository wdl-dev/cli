import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { defineCommand } from "../lib/command.js";
import { CliError, defineCliOption, formatHelp, isMain, isNonEmptyString, optionHelp } from "../lib/common.js";
import { warnIfInsecureControlUrl } from "../lib/credentials.js";
import { writeResult } from "../lib/output.js";
import { readTokenStore, tokenStorePath } from "../lib/token-store.js";
import { TokenStoreConfigError, resolveCliConfigState } from "../lib/config-state.js";
import { CLI_ROOT, currentCliVersion, readCliPackageJson } from "../lib/package-info.js";
import {
  ensureControlContextFromConfigState,
  fetchWhoami,
  namespaceFromPrincipal,
  summarizeWhoami,
} from "../lib/whoami.js";
import {
  MIN_WRANGLER_MAJOR,
  parseWranglerMajorVersion,
  resolveWranglerCommand,
  wranglerChildEnv,
} from "../lib/wrangler/command.js";
import { selectWranglerConfigFiles } from "../lib/wrangler/config.js";

const DOCTOR_OPTIONS = [
  defineCliOption("strict", { type: "boolean" }, "--strict", "Exit non-zero if any check fails."),
  "ns",
  "control",
  "json",
  "help",
];

const command = defineCommand({
  name: "doctor",
  summary: "Check local and control-plane readiness.",
  options: DOCTOR_OPTIONS,
  defaults: { execFile: execFileSync },
  autoloadEnv: false,
  usage: usageText,
  run: runDoctor,
});

export const main = command.main;
export const runDoctorCommand = command.run;
export const meta = command.meta;

/**
 * The doctor run context: the framework base plus the injectable `execFile`
 * declared in this command's `defaults`.
 * @typedef {import("../lib/command.js").CommandContext & { execFile: typeof execFileSync }} DoctorContext
 */

/** @param {{ values: import("../lib/command.js").PresetFlags<"ns" | "control" | "json"> & { strict?: boolean }, positionals: string[], context: import("../lib/command.js").CommandContext }} arg */
async function runDoctor({ values, positionals, context: baseContext }) {
  if (positionals.length > 0) throw new CliError(usageText());

  const context = /** @type {DoctorContext} */ (baseContext);
  let tokenStoreError = null;
  let state;
  try {
    state = resolveCliConfigState({ values, env: context.env, cwd: context.cwd, warn: context.warn });
  } catch (err) {
    if (!(err instanceof TokenStoreConfigError)) throw err;
    tokenStoreError = err.message;
    state = resolveCliConfigState({
      values,
      env: context.env,
      cwd: context.cwd,
      readStore: () => ({}),
      warn: context.warn,
    });
  }
  const checks = [
    checkNode(),
    checkCliVersion(),
    checkWrangler({ cwd: context.cwd, env: state.env, execFile: context.execFile }),
    checkControlUrl(state),
    checkToken(state),
    checkNamespace(state),
    tokenStoreError ? check({ ok: false, label: "Token store", detail: tokenStoreError }) : checkTokenStore(state),
    checkWranglerConfig(context.cwd),
  ];
  const remote = await checkRemoteWhoami({
    state,
    controlFetch: context.controlFetch,
    warn: context.warn,
  });
  checks.push(...remote.checks);

  const body = { checks, whoami: remote.whoami, whoamiError: remote.error };
  writeResult(Boolean(values.json), body, () => formatDoctor(checks), context.stdout);
  if (values.strict === true && checks.some((item) => !item.ok)) {
    throw new CliError("doctor checks failed");
  }
}

/**
 * The resolved CLI config state doctor inspects.
 * @typedef {ReturnType<typeof resolveCliConfigState>} ConfigState
 */

/**
 * One readiness check row.
 * @typedef {{ ok: boolean, label: string, detail: string }} DoctorCheck
 */

function checkNode() {
  const pkg = readCliPackageJson();
  const engines = /** @type {{ node?: string } | undefined} */ (pkg.engines);
  const expected = engines?.node || "(unspecified)";
  const ok = satisfiesNodeEngine(process.versions.node, expected);
  return check({
    ok,
    label: `Node.js ${process.versions.node}`,
    detail: ok ? `matches ${expected}` : `requires ${expected}`,
  });
}

function checkCliVersion() {
  return check({
    ok: true,
    label: `wdl-cli ${currentCliVersion()}`,
  });
}

/** @param {{ cwd: string, env: NodeJS.ProcessEnv, execFile: typeof execFileSync }} arg */
function checkWrangler({ cwd, env, execFile }) {
  // The resolver throws on win32 when nothing runnable exists; doctor must
  // report that as a failed check, not crash the whole run.
  let wrangler;
  try {
    wrangler = resolveWranglerCommand({ absProject: cwd, env });
  } catch (err) {
    return check({
      ok: false,
      label: "Wrangler",
      detail: err instanceof Error && err.message ? err.message : String(err),
    });
  }
  try {
    const output = execFile(wrangler.command, [...wrangler.args, "--version"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: wranglerChildEnv(env),
    });
    const version = formatWranglerVersion(output) || readInstalledWranglerVersion(cwd);
    // Mirror the gate `wdl deploy` enforces so doctor can't green-light a
    // Wrangler major that deploy will reject.
    const major = parseWranglerMajorVersion(version);
    const meetsMinimum = major != null && major >= MIN_WRANGLER_MAJOR;
    return check({
      ok: meetsMinimum,
      label: `Wrangler ${version || "(unknown)"}`,
      detail: meetsMinimum
        ? `source: ${wrangler.source}`
        : `wdl deploy requires Wrangler v${MIN_WRANGLER_MAJOR} (wrangler@^${MIN_WRANGLER_MAJOR}); found ${version || "(unknown)"} via ${wrangler.source}`,
    });
  } catch (err) {
    return check({
      ok: false,
      label: "Wrangler",
      detail: err instanceof Error && err.message ? err.message : String(err),
    });
  }
}

/** @param {ConfigState} state */
function checkControlUrl(state) {
  return check({
    ok: !state.controlUrl.error,
    label: state.controlUrl.error ? "CONTROL_URL" : `CONTROL_URL ${state.controlUrl.display}`,
    detail: state.controlUrl.error || `source: ${state.controlUrl.source}`,
  });
}

/** @param {ConfigState} state */
function checkToken(state) {
  return check({
    ok: Boolean(state.token.value),
    label: state.token.value ? `ADMIN_TOKEN ${state.token.display}` : "ADMIN_TOKEN",
    detail: state.token.value ? `source: ${state.token.source}` : "Missing token. Set ADMIN_TOKEN or pass --token.",
  });
}

/** @param {ConfigState} state */
function checkNamespace(state) {
  return check({
    ok: Boolean(state.namespace.value),
    label: state.namespace.value ? `Namespace ${state.namespace.display}` : "Namespace",
    detail: state.namespace.value ? `source: ${state.namespace.source}` : "Missing namespace. Set WDL_NS or pass --ns.",
  });
}

/** @param {ConfigState} state */
function checkTokenStore(state) {
  if (state.tokenStoreDisabled) {
    // The opt-out promises the CLI never reads the store, so don't read it here
    // either — but still flag (statically) that opting out doesn't remove the file.
    return check({
      ok: true,
      label: "Token store disabled",
      detail:
        "WDL_TOKEN_STORE=off / --no-token-store — credentials resolve from flag/env/.env " +
        "only. A store file on disk, if any, stays readable by project build code.",
    });
  }
  /** @type {ReturnType<typeof readTokenStore>} */
  let store;
  try {
    store = readTokenStore(tokenStorePath(state.env));
  } catch (err) {
    return check({
      ok: false,
      label: "Token store",
      detail: err instanceof Error && err.message ? err.message : String(err),
    });
  }
  const count = Object.keys(store.namespaces || {}).length;
  if (count === 0) {
    return check({ ok: true, label: "Token store none" });
  }
  return check({
    ok: true,
    label: `Token store ${count} namespace${count === 1 ? "" : "s"}`,
    detail:
      "readable by project build code during deploy (same OS user) — only deploy " +
      "projects you trust; --no-token-store / WDL_TOKEN_STORE=off opts out.",
  });
}

/** @param {string} cwd */
function checkWranglerConfig(cwd) {
  const { selected, shadowed } = selectWranglerConfigFiles(cwd);
  const name = selected?.name;
  return check({
    ok: Boolean(name),
    label: name ? `Wrangler config ${name}` : "Wrangler config",
    detail: name
      ? shadowed.length > 0
        ? `found in current directory; ignoring ${shadowed.join(", ")} by Wrangler priority`
        : "found in current directory"
      : "not found in current directory; needed for deploy from this path",
  });
}

/**
 * @param {{
 *   state: ConfigState,
 *   controlFetch: import("../lib/command.js").CommandContext["controlFetch"],
 *   warn: (line: string) => void,
 * }} arg
 */
async function checkRemoteWhoami({ state, controlFetch, warn }) {
  let control;
  try {
    control = ensureControlContextFromConfigState(state);
  } catch (err) {
    return {
      whoami: null,
      error: err instanceof Error && err.message ? err.message : String(err),
      checks: [],
    };
  }
  warnIfInsecureControlUrl(control.controlUrl, warn, state.env);

  try {
    const remote = summarizeWhoami(await fetchWhoami({
      controlUrl: control.controlUrl,
      headers: control.headers,
      controlFetch,
      env: state.env,
    }));
    const tokenNs = namespaceFromPrincipal(remote.principal ?? undefined);
    const checks = [
      check({
        ok: true,
        label: `CONTROL_URL reachable`,
        detail: remote.urls.control || control.controlUrl,
      }),
      check({
        ok: true,
        label: "ADMIN_TOKEN valid",
        detail: remote.tokenId ? `token id: ${remote.tokenId}` : "token id unavailable",
      }),
      check({
        ok: true,
        label: `Principal ${remote.principalLabel}`,
      }),
      check({
        ok: remote.compatibility.ok,
        label: `CLI compatibility ${remote.compatibility.label}`,
        detail: remote.compatibility.detail,
      }),
    ];
    if (remote.platformVersion) {
      checks.push(check({ ok: true, label: `Platform ${remote.platformVersion}` }));
    }
    if (state.namespace.value && tokenNs) {
      checks.push(check({
        ok: state.namespace.value === tokenNs,
        label: `Token namespace ${tokenNs}`,
        detail: state.namespace.value === tokenNs
          ? `matches configured namespace ${state.namespace.value}`
          : `configured namespace is ${state.namespace.value}`,
      }));
    }
    return { whoami: remote, error: null, checks };
  } catch (err) {
    return {
      whoami: null,
      error: err instanceof Error && err.message ? err.message : String(err),
      checks: [check({
        ok: false,
        label: "Control /whoami",
        detail: err instanceof Error && err.message ? err.message : String(err),
      })],
    };
  }
}

/**
 * @param {{ ok: boolean, label: string, detail?: string }} arg
 * @returns {DoctorCheck}
 */
function check({ ok, label, detail = "" }) {
  return { ok, label, detail };
}

/** @param {DoctorCheck[]} checks */
function formatDoctor(checks) {
  return checks.map((item) => {
    const line = `${item.ok ? "✓" : "✗"} ${item.label}`;
    return item.detail ? `${line}\n  ${item.detail}` : line;
  });
}

/**
 * @param {string} version
 * @param {string} engine
 */
function satisfiesNodeEngine(version, engine) {
  // Doctor only needs the package's current simple ">=N" engine shape. If the
  // project later adopts a richer range, avoid false negatives until a real
  // semver checker is worth adding.
  const min = /^>=\s*(\d+)/.exec(engine);
  if (!min) return true;
  return Number(version.split(".")[0]) >= Number(min[1]);
}

/** @param {unknown} output */
function formatWranglerVersion(output) {
  const text = String(output).trim();
  const match = text.match(/\b\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?\b/);
  return match ? match[0] : "";
}

/** @param {string} cwd */
function readInstalledWranglerVersion(cwd) {
  for (const dir of [cwd, CLI_ROOT]) {
    try {
      /** @type {{ version?: unknown }} */
      const pkg = JSON.parse(readFileSync(path.join(dir, "node_modules", "wrangler", "package.json"), "utf8"));
      if (isNonEmptyString(pkg.version)) return pkg.version;
    } catch {}
  }
  return "";
}

function usageText() {
  return formatHelp({
    usage: ["wdl doctor [options]"],
    description: "Check local Node.js, wdl-cli, Wrangler, config, credentials, and control-plane /whoami.",
    options: optionHelp(DOCTOR_OPTIONS),
  });
}

if (isMain(import.meta.url)) {
  await main();
}
