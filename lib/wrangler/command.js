import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CliError } from "../common.js";
import { WRANGLER_SCRUB_KEYS } from "../dotenv.js";
import { escapeTerminalLines, escapeTerminalText, formatDiagnosticValue } from "../output.js";

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const resolveFromHere = createRequire(import.meta.url);
export const MIN_WRANGLER_MAJOR = 4;

/**
 * The subset of an `execFileSync` failure / spawn error the formatters read.
 * @typedef {object} ExecFailure
 * @property {number | null} [status]
 * @property {NodeJS.Signals | null} [signal]
 * @property {string} [message]
 * @property {string} [code]
 * @property {string | Buffer} [stdout]
 * @property {string | Buffer} [stderr]
 */

/**
 * @param {unknown} err
 * @returns {ExecFailure}
 */
function asExecFailure(err) {
  return err && typeof err === "object" ? /** @type {ExecFailure} */ (err) : {};
}

/**
 * @param {{
 *   absProject?: string,
 *   env?: NodeJS.ProcessEnv,
 *   packageDirs?: string[],
 *   platform?: NodeJS.Platform,
 * }} [options]
 */
export function resolveWranglerCommand({
  absProject,
  env = process.env,
  packageDirs = [CLI_DIR],
  platform = process.platform,
} = {}) {
  // Keep deploy offline by default. `npx --yes wrangler` may hit the
  // registry, so only use it when explicitly requested.
  if (env.WDL_WRANGLER_BIN) {
    return { command: env.WDL_WRANGLER_BIN, args: [], source: "WDL_WRANGLER_BIN" };
  }

  if (absProject) {
    const projectLocal = localWrangler(path.resolve(absProject), platform);
    if (projectLocal) return { ...projectLocal, source: "project" };
  }

  for (const dir of uniquePaths(packageDirs)) {
    if (dir === CLI_DIR) {
      const bundled = bundledWrangler();
      if (bundled) return { ...bundled, source: "package" };
    }
    const local = localWrangler(dir, platform);
    if (local) return { ...local, source: "package" };
  }

  const fromPath = pathWrangler(env, platform);
  if (fromPath) return { ...fromPath, source: "path" };

  if (env.WDL_ALLOW_NPX_WRANGLER === "1") {
    return { command: "npx", args: ["--yes", "wrangler"], source: "npx" };
  }

  if (platform === "win32") {
    // A bare `wrangler` exec on win32 either ENOENTs or resolves back to a
    // .cmd shim Node refuses to run.
    throw new CliError(
      "No runnable wrangler found. Install wrangler@^4 in the Worker project " +
      "(npm i -D wrangler), set WDL_WRANGLER_BIN to a runnable wrangler entry, " +
      "or set WDL_ALLOW_NPX_WRANGLER=1."
    );
  }

  return { command: "wrangler", args: [], source: "path" };
}

/**
 * @param {{
 *   execFile?: typeof execFileSync,
 *   cwd: string,
 *   env: NodeJS.ProcessEnv,
 *   wrangler: { command: string, args: string[] },
 * }} options
 */
export function checkWranglerVersion({ execFile = execFileSync, cwd, env, wrangler }) {
  let output;
  try {
    output = execFile(wrangler.command, [...wrangler.args, "--version"], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      env: wranglerChildEnv(env),
    });
  } catch (err) {
    throw new CliError(formatWranglerVersionFailure(err));
  }

  const parsed = parseWranglerMajorVersion(output);
  if (parsed == null) {
    throw new CliError(
      `wrangler version check failed: could not parse version from ${formatDiagnosticValue(String(output).trim())}`
    );
  }
  if (parsed < MIN_WRANGLER_MAJOR) {
    throw new CliError(
      `wdl deploy requires Wrangler v${MIN_WRANGLER_MAJOR} (wrangler@^${MIN_WRANGLER_MAJOR}); ` +
      `found v${parsed}. Upgrade the Worker project's wrangler dependency before deploying.`
    );
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @returns {NodeJS.ProcessEnv}
 */
export function wranglerChildEnv(env) {
  /** @type {NodeJS.ProcessEnv} */
  const childEnv = { ...env, CLOUDFLARE_API_TOKEN: "dry-run-dummy" };
  for (const key of WRANGLER_SCRUB_KEYS) {
    delete childEnv[key];
  }
  return childEnv;
}

/**
 * @param {unknown} rawErr
 * @returns {string}
 */
export function formatWranglerFailure(rawErr) {
  const err = asExecFailure(rawErr);
  const reason = escapeTerminalText(err.status ?? err.signal ?? err.message ?? "unknown");
  const output = [err.stdout, err.stderr]
    .map(toText)
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!output) return `wrangler build failed (${reason})`;
  return `wrangler build failed (${reason})\n${escapeTerminalLines(truncateOutput(output))}`;
}

/**
 * @param {unknown} output
 * @returns {number | null}
 */
export function parseWranglerMajorVersion(output) {
  const text = toText(output);
  const match = text.match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/);
  if (!match) return null;
  return Number(match[1]);
}

/**
 * @param {Array<string | undefined>} paths
 * @returns {string[]}
 */
function uniquePaths(paths) {
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const p of paths) {
    if (!p) continue;
    const resolved = path.resolve(p);
    if (seen.has(resolved)) continue;
    seen.add(resolved);
    out.push(resolved);
  }
  return out;
}

// On win32 the node_modules/.bin entry is a .cmd shim, and Node >= 20.12
// refuses to execFile batch files without a shell (CVE-2024-27980 hardening).
// Run the wrangler package's JS entry with the current Node instead.
/**
 * @param {string} dir
 * @param {NodeJS.Platform} platform
 * @returns {{ command: string, args: string[] } | null}
 */
function localWrangler(dir, platform) {
  if (platform === "win32") {
    const script = wranglerScript(dir);
    return script ? { command: process.execPath, args: [script] } : null;
  }
  const bin = path.join(dir, "node_modules", ".bin", "wrangler");
  if (existsSync(bin)) return { command: bin, args: [] };
  const script = wranglerScript(dir);
  return script ? { command: process.execPath, args: [script] } : null;
}

/**
 * @param {string} dir
 * @returns {string | null}
 */
function wranglerScript(dir) {
  const script = path.join(dir, "node_modules", "wrangler", "bin", "wrangler.js");
  return existsSync(script) ? script : null;
}

function bundledWrangler() {
  try {
    const packageJson = resolveFromHere.resolve("wrangler/package.json");
    const script = path.join(path.dirname(packageJson), "bin", "wrangler.js");
    return existsSync(script) ? { command: process.execPath, args: [script] } : null;
  } catch {
    return null;
  }
}

/**
 * @param {NodeJS.ProcessEnv} env
 * @param {NodeJS.Platform} platform
 * @returns {{ command: string, args: string[] } | null}
 */
function pathWrangler(env, platform) {
  const pathValue = env.PATH || "";
  for (const dir of pathValue.split(path.delimiter)) {
    if (!dir) continue;
    if (platform === "win32") {
      // A .cmd shim can't be exec'd without a shell (CVE-2024-27980
      // hardening), so it only marks a candidate dir: npm prefixes keep the
      // package next to the shim, and only its JS entry is runnable. A bare
      // shim without the package is skipped — keep scanning.
      if (!existsSync(path.join(dir, "wrangler.cmd"))) continue;
      const script = wranglerScript(dir);
      if (script) return { command: process.execPath, args: [script] };
      continue;
    }
    const bin = path.join(dir, "wrangler");
    if (existsSync(bin)) return { command: bin, args: [] };
  }
  return null;
}

/**
 * @param {unknown} rawErr
 * @returns {string}
 */
function formatWranglerVersionFailure(rawErr) {
  const err = asExecFailure(rawErr);
  const reason = escapeTerminalText(err.status ?? err.signal ?? err.message ?? "unknown");
  const output = [err.stdout, err.stderr]
    .map(toText)
    .filter(Boolean)
    .join("\n")
    .trim();
  const shownOutput = escapeTerminalLines(truncateOutput(output));
  let message = output
    ? `wrangler version check failed (${reason})\n${shownOutput}`
    : `wrangler version check failed (${reason})`;
  if (err.code === "ENOENT") {
    message +=
      "\nNo runnable wrangler found. Install wrangler@^4 in the Worker project " +
      "(npm i -D wrangler), set WDL_WRANGLER_BIN to a runnable wrangler entry, " +
      "or set WDL_ALLOW_NPX_WRANGLER=1.";
  }
  return message;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function toText(value) {
  if (!value) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

/**
 * @param {string} text
 * @param {number} [max]
 * @returns {string}
 */
function truncateOutput(text, max = 4000) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... output truncated ...`;
}
