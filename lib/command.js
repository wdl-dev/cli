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
import {
  CliError,
  encodePath,
  optionParseOptions,
  printHelpIfRequested,
  readJsonOrFail,
  resolveControlContext,
  resolveNamespace,
  runCliMain,
  throwHttpErrorIfNotOk,
  warnIfInsecureControlUrl,
} from "./common.js";

/**
 * Flag-preset names accepted in a command's `options` list; each expands to
 * the matching shared option specs:
 *   "ns"      -> --ns
 *   "control" -> --control-url, --token
 *   "env"     -> --env
 *   "json"    -> --json
 *   "yes"     -> --yes
 *   "help"    -> -h, --help
 * @typedef {string} OptionPreset
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
 * @property {Record<string, any>} values        Parsed flag values.
 * @property {string[]} positionals               Parsed positional args.
 * @property {() => (string | undefined)} resolveNamespace
 * @property {() => { controlUrl: string, headers: Record<string, string>, token: string }} resolveControl
 * @property {(...segments: string[]) => string} nsUrl  Encoded /ns/<ns>/... URL.
 * @property {(url: string, init: object, label: string) => Promise<any>} fetchJson    controlFetch + readJsonOrFail.
 * @property {(url: string, init: object, label: string) => Promise<any>} fetchStream  controlFetch + status check; returns the raw Response.
 */

// Injectable deps every command understands, with production defaults.
// Recomputed per call so process.cwd()/process.stdin reflect each invocation.
function standardDefaults() {
  return {
    env: process.env,
    stdout: (line = "") => console.log(line),
    stderr: (text) => process.stderr.write(text),
    // Framework warnings go through this line-based channel rather than
    // stderr: commands override stderr with differing newline conventions
    // (raw write vs console.error), which a shared emitter can't know.
    warn: (line) => console.error(line),
    stdin: process.stdin,
    cwd: process.cwd(),
    controlFetch: defaultControlFetch,
  };
}

// options is a list mixing preset names and option specs.
function buildParseOptions(options) {
  return optionParseOptions(options);
}

/**
 * @param {{
 *   name: string,
 *   summary: string,
 *   options?: Array<OptionPreset | object>,
 *   defaults?: Record<string, unknown>,
 *   autoloadEnv?: boolean,
 *   usage: () => string,
 *   run: (ctx: { values: Record<string, any>, positionals: string[], context: CommandContext }) => Promise<unknown> | unknown,
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
    const { values, positionals } = parseArgs({
      args: argv,
      options: parseOptions,
      allowPositionals: true,
    });

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
export function isHelpAlias(positionals) {
  return positionals.length === 1 && positionals[0] === "help";
}

/** @returns {CommandContext} */
function buildContext(deps, commandDefaults, values, positionals) {
  const merged = { ...standardDefaults(), ...commandDefaults };
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

  context.values = values;
  context.positionals = positionals;
  context.resolveNamespace = () => resolveNamespace(values, context.env);
  let controlMemo;
  context.resolveControl = () => (controlMemo ??= (() => {
    const control = resolveControlContext(values, context.env);
    warnIfInsecureControlUrl(control.controlUrl, context.warn);
    return control;
  })());

  // Build a control URL under the resolved namespace, encoding each segment, e.g.
  // nsUrl("worker", name, "versions", v) -> .../ns/<ns>/worker/<name>/versions/<v>.
  // Fail-fast on an unresolved namespace: callers validate --ns and throw their
  // own usageText first, so this only fires if a command forgets that check —
  // better an internal-invariant error than a silent .../ns/undefined/... fetch.
  context.nsUrl = (...segments) => {
    const { controlUrl } = context.resolveControl();
    const ns = context.resolveNamespace();
    if (!ns) throw new CliError("nsUrl: namespace not resolved (command must validate --ns first)");
    const base = `${controlUrl}/ns/${encodePath(ns)}`;
    return segments.length === 0
      ? base
      : `${base}/${segments.map((s) => encodePath(s)).join("/")}`;
  };

  // controlFetch + readJsonOrFail in one call — the pair most commands repeat.
  context.fetchJson = async (url, init, label) => {
    const res = await context.controlFetch(url, init);
    return readJsonOrFail(res, label);
  };

  // controlFetch + status check for non-JSON / streaming bodies (e.g. r2 get/head).
  // Returns the raw Response so the caller can consume res.body / res.headers.
  context.fetchStream = async (url, init, label) => {
    const res = await context.controlFetch(url, init);
    await throwHttpErrorIfNotOk(res, label);
    return res;
  };

  return /** @type {CommandContext} */ (context);
}
