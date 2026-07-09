// Internal lightweight command framework. Every control-plane command shares
// the same shell: parse argv with a few flag presets, short-circuit on --help,
// wrap the run body in CliError handling, and resolve namespace / control
// context the same way. defineCommand owns that shell so each command file is
// just its metadata + option set plus a run({ values, positionals, context }) body.
//
// Deliberately NOT abstracted: namespace and control resolution stay explicit
// calls in the run body (context.resolveNamespace() / context.resolveControl())
// rather than eager framework steps. Each command interleaves command-specific
// validation between those resolves and the work, and that ordering decides
// which error a user sees first — keeping the calls in the body preserves it.

import { parseArgs } from "node:util";
import { controlFetch as defaultControlFetch } from "./control-fetch.js";
import { CliError, encodePath, optionParseOptions, printHelpIfRequested, readJsonOrFail, runCliMain, throwHttpErrorIfNotOk } from "./common.js";
import { resolveControlContext, resolveNamespace, warnIfInsecureControlUrl } from "./credentials.js";
import { escapeTerminalText } from "./output.js";

/**
 * Flag-preset names accepted in a command's `options` list; each expands to
 * the matching shared option specs:
 *   "ns"      -> --ns
 *   "control" -> --control-url, --token, --no-token-store
 *   "endpoint"-> --control-url
 *   "env"     -> --env
 *   "json"    -> --json
 *   "yes"     -> --yes
 *   "help"    -> -h, --help
 * @typedef {string} OptionPreset
 */

/**
 * @template U
 * @typedef {(U extends unknown ? (k: U) => void : never) extends (k: infer I) => void ? I : never} UnionToIntersection
 */

/**
 * The parsed `values` each option preset contributes, keyed by preset name.
 * Keep in sync with CLI_OPTION_PRESETS in common.js: a command names its presets
 * via PresetFlags<...> instead of re-typing their flags, so the schema and the
 * handler's `values` type can't drift. A preset's value keys need not match its
 * name — "control" contributes "control-url", "token", and "no-token-store".
 * @typedef {object} PresetValueMap
 * @property {{ ns?: string }} ns
 * @property {{ env?: string }} env
 * @property {{ "control-url"?: string, token?: string, "no-token-store"?: boolean }} control
 * @property {{ "control-url"?: string }} endpoint
 * @property {{ json?: boolean }} json
 * @property {{ yes?: boolean }} yes
 * @property {{ help?: boolean }} help
 */

/**
 * The `values` contributed by a set of option presets, e.g.
 * `PresetFlags<"ns" | "control" | "json">`. Intersect with a command's own
 * flags: `PresetFlags<"ns"> & { raw?: boolean }`.
 * @template {keyof PresetValueMap} P
 * @typedef {UnionToIntersection<PresetValueMap[P]>} PresetFlags
 */

/**
 * The object handed to every command's run body. Framework members are typed,
 * so a misspelled access (e.g. `context.fetchJson` typed as `fetchJsonn`) is a
 * typecheck error rather than a silent undefined. Commands that inject extra
 * deps intersect this type, e.g. `CommandContext & { execFile: ... }`.
 * @typedef {object} CommandContext
 * @property {NodeJS.ProcessEnv} env
 * @property {(line?: string) => void} stdout
 * @property {(text: string) => void} stderr
 * @property {(line: string) => void} warn   Line-based warning channel (no trailing newline).
 * @property {NodeJS.ReadStream} stdin
 * @property {string} cwd
 * @property {typeof defaultControlFetch} controlFetch
 * @property {Record<string, unknown>} values        Parsed flag values.
 * @property {string[]} positionals               Parsed positional args.
 * @property {() => (string | undefined)} resolveNamespace
 * @property {() => { controlUrl: string, headers: Record<string, string>, token: string }} resolveControl
 * @property {(...segments: string[]) => string} nsUrl  Encoded /ns/<ns>/... URL.
 * @property {(url: string, init: import("./control-fetch.js").ControlFetchInit, label: string) => Promise<unknown>} fetchJson    controlFetch + readJsonOrFail.
 * @property {(url: string, init: import("./control-fetch.js").ControlFetchInit, label: string) => Promise<import("./control-fetch.js").ControlResponse>} fetchStream  controlFetch + status check; returns the raw Response.
 */

// Injectable deps every command understands, with production defaults.
// Recomputed per call so process.cwd()/process.stdin reflect each invocation.
function standardDefaults() {
  return {
    env: process.env,
    stdout: (/** @type {string} */ line = "") => console.log(line),
    stderr: (/** @type {string} */ text) => process.stderr.write(text),
    // Framework warnings go through this line-based channel rather than
    // stderr: commands override stderr with differing newline conventions
    // (raw write vs console.error), which a shared emitter can't know.
    warn: (/** @type {string} */ line) => console.error(line),
    stdin: process.stdin,
    cwd: process.cwd(),
    controlFetch: defaultControlFetch,
  };
}

// options is a list mixing preset names and option specs.
/** @param {Iterable<import("./common.js").OptionListItem>} options */
function buildParseOptions(options) {
  return optionParseOptions(options);
}

// `run` below uses method syntax (not `run: (ctx) => …`) on purpose: it makes
// the param bivariant, so a command can declare a narrowed `values` shape (e.g.
// `{ env?: string }`) and still satisfy this `Record<string, unknown>` slot.
/**
 * @param {{
 *   name: string,
 *   summary: string,
 *   options?: Array<import("./common.js").OptionListItem>,
 *   defaults?: Record<string, unknown>,
 *   autoloadEnv?: boolean,
 *   usage: () => string,
 *   run(ctx: { values: Record<string, unknown>, positionals: string[], context: CommandContext }): Promise<unknown> | unknown,
 * }} spec
 * @returns {{ main: (argv?: string[]) => Promise<void>, run: (argv?: string[], deps?: object) => Promise<unknown>, meta: { name: string, summary: string, autoloadEnv: boolean, parseOptions: import("node:util").ParseArgsOptionsConfig } }}
 */
export function defineCommand(spec) {
  const { name, summary, options = [], defaults = {}, autoloadEnv = true, usage, run } = spec;
  if (typeof name !== "string" || !name) throw new Error("defineCommand: name must be a non-empty string");
  if (typeof summary !== "string" || !summary) throw new Error("defineCommand: summary must be a non-empty string");
  if (typeof usage !== "function") throw new Error("defineCommand: usage must be a function");
  if (typeof run !== "function") throw new Error("defineCommand: run must be a function");
  const parseOptions = buildParseOptions(options);

  // The exported runner keeps the (argv, deps) signature the test suite calls
  // directly. It does NOT swallow errors — main() does that via runCliMain so
  // tests can still assert on the thrown CliError.
  async function runCommand(argv = process.argv.slice(2), deps = {}) {
    const { values, positionals } = (() => {
      try {
        return parseArgs({
          args: argv,
          options: parseOptions,
          allowPositionals: true,
        });
      } catch (err) {
        const message = err instanceof Error && err.message ? err.message : String(err);
        throw new CliError(escapeTerminalText(message));
      }
    })();

    const context = buildContext(deps, defaults, values, positionals);

    if (printHelpIfRequested(values.help || isHelpAlias(positionals), usage, context.stdout)) return undefined;

    return await run({ values, positionals, context });
  }

  async function main(argv = process.argv.slice(2)) {
    await runCliMain(runCommand, argv);
  }

  // parseOptions rides on meta so the dispatcher can pre-scan argv (ns
  // overlay, help detection) with the command's own flag schema.
  return { main, run: runCommand, meta: { name, summary, autoloadEnv, parseOptions } };
}

// Exported for the bin dispatcher's lenient pre-scan, which must classify
// help requests with the same rule the strict parse uses.
/** @param {string[]} positionals */
export function isHelpAlias(positionals) {
  return positionals.length === 1 && positionals[0] === "help";
}

/**
 * @param {Record<string, unknown>} deps
 * @param {Record<string, unknown>} commandDefaults
 * @param {Record<string, unknown>} values
 * @param {string[]} positionals
 * @returns {CommandContext}
 */
function buildContext(deps, commandDefaults, values, positionals) {
  /** @type {Record<string, unknown>} */
  const merged = { ...standardDefaults(), ...commandDefaults };
  /** @type {Record<string, unknown>} */
  const context = {};
  // Known deps fall back to the merged defaults; an explicitly injected dep
  // (including one set to undefined) wins so tests can override anything.
  for (const key of Object.keys(merged)) {
    context[key] = Object.hasOwn(deps, key) ? deps[key] : merged[key];
  }
  // Pass through any extra injected deps the command declares no default for
  // (e.g. execFile, transport, sleepFn, now, stdoutStream). Object.hasOwn (not
  // `in`) so a dep named like an Object.prototype member still passes through.
  for (const key of Object.keys(deps)) {
    if (!Object.hasOwn(context, key)) context[key] = deps[key];
  }

  const env = /** @type {NodeJS.ProcessEnv} */ (context.env);
  const warn = /** @type {(line: string) => void} */ (context.warn);
  const controlFetch = /** @type {typeof defaultControlFetch} */ (context.controlFetch);

  context.values = values;
  context.positionals = positionals;
  /** @returns {string | undefined} */
  const resolveNamespaceFn = () => resolveNamespace(values, env);
  context.resolveNamespace = resolveNamespaceFn;
  /** @type {ReturnType<typeof resolveControlContext> | undefined} */
  let controlMemo;
  const resolveControlFn = () => (controlMemo ??= (() => {
    const control = resolveControlContext(values, env);
    warnIfInsecureControlUrl(control.controlUrl, warn, env);
    return control;
  })());
  context.resolveControl = resolveControlFn;

  // Build a control URL under the resolved namespace, encoding each segment, e.g.
  // nsUrl("worker", name, "versions", v) -> .../ns/<ns>/worker/<name>/versions/<v>.
  // Fail-fast on an unresolved namespace: callers validate --ns and throw their
  // own usageText first, so this only fires if a command forgets that check —
  // better an internal-invariant error than a silent .../ns/undefined/... fetch.
  context.nsUrl = (/** @type {string[]} */ ...segments) => {
    const { controlUrl } = resolveControlFn();
    const ns = resolveNamespaceFn();
    if (!ns) throw new CliError("nsUrl: namespace not resolved (command must validate --ns first)");
    const base = `${controlUrl}/ns/${encodePath(ns)}`;
    return segments.length === 0
      ? base
      : `${base}/${segments.map((s) => encodePath(s)).join("/")}`;
  };

  // controlFetch + readJsonOrFail in one call — the pair most commands repeat.
  /**
   * @param {string} url
   * @param {import("./control-fetch.js").ControlFetchInit} init
   * @param {string} label
   */
  context.fetchJson = async (url, init, label) => {
    const res = await controlFetch(url, { ...init, env: init.env ?? env });
    return readJsonOrFail(res, label);
  };

  // controlFetch + status check for non-JSON / streaming bodies (e.g. r2 get/head).
  // Returns the raw Response so the caller can consume res.body / res.headers.
  /**
   * @param {string} url
   * @param {import("./control-fetch.js").ControlFetchInit} init
   * @param {string} label
   */
  context.fetchStream = async (url, init, label) => {
    const res = await controlFetch(url, { ...init, env: init.env ?? env });
    await throwHttpErrorIfNotOk(res, label);
    return res;
  };

  return /** @type {CommandContext} */ (/** @type {unknown} */ (context));
}
