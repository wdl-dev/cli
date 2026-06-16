import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WRANGLER_SCRUB_KEYS, CliError } from "../common.js";

const CLI_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
export const MIN_WRANGLER_MAJOR = 4;

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

  for (const dir of uniquePaths([absProject, ...packageDirs])) {
    if (!dir) continue;
    const local = localWrangler(dir, platform);
    if (local) return { ...local, source: "local" };
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
      `wrangler version check failed: could not parse version from ${JSON.stringify(String(output).trim())}`
    );
  }
  if (parsed < MIN_WRANGLER_MAJOR) {
    throw new CliError(
      `wdl deploy requires Wrangler v${MIN_WRANGLER_MAJOR} (wrangler@^${MIN_WRANGLER_MAJOR}); ` +
      `found v${parsed}. Upgrade the Worker project's wrangler dependency before deploying.`
    );
  }
}

export function wranglerChildEnv(env) {
  const childEnv = { ...env, CLOUDFLARE_API_TOKEN: "dry-run-dummy" };
  for (const key of WRANGLER_SCRUB_KEYS) {
    delete childEnv[key];
  }
  return childEnv;
}

export function formatWranglerFailure(err) {
  const reason = err?.status ?? err?.signal ?? err?.message ?? "unknown";
  const output = [err?.stdout, err?.stderr]
    .map(toText)
    .filter(Boolean)
    .join("\n")
    .trim();
  if (!output) return `wrangler build failed (${reason})`;
  return `wrangler build failed (${reason})\n${truncateOutput(output)}`;
}

export function parseWranglerMajorVersion(output) {
  const text = toText(output);
  const match = text.match(/\b(\d+)\.(\d+)\.(\d+)(?:[-+][0-9A-Za-z.-]+)?\b/);
  if (!match) return null;
  return Number(match[1]);
}

function uniquePaths(paths) {
  const seen = new Set();
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

function wranglerScript(dir) {
  const script = path.join(dir, "node_modules", "wrangler", "bin", "wrangler.js");
  return existsSync(script) ? script : null;
}

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

function formatWranglerVersionFailure(err) {
  const reason = err?.status ?? err?.signal ?? err?.message ?? "unknown";
  const output = [err?.stdout, err?.stderr]
    .map(toText)
    .filter(Boolean)
    .join("\n")
    .trim();
  let message = output
    ? `wrangler version check failed (${reason})\n${truncateOutput(output)}`
    : `wrangler version check failed (${reason})`;
  if (err?.code === "ENOENT") {
    message +=
      "\nNo runnable wrangler found. Install wrangler@^4 in the Worker project " +
      "(npm i -D wrangler), or set WDL_WRANGLER_BIN to a runnable wrangler entry.";
  }
  return message;
}

function toText(value) {
  if (!value) return "";
  return Buffer.isBuffer(value) ? value.toString("utf8") : String(value);
}

function truncateOutput(text, max = 4000) {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... output truncated ...`;
}
