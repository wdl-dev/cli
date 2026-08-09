import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { response } from "./helpers.js";

/** @typedef {import("./helpers.js").ControlCall} ControlCall */

/**
 * Create the standard single-module project used by deploy command tests.
 * TestContext owns cleanup so each test only describes its relevant config.
 * @param {import("node:test").TestContext} t
 * @param {string} config
 * @param {string} [prefix]
 */
export function createDeployProject(t, config, prefix = "wdl-run-deploy-") {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(path.join(dir, "src"), { recursive: true });
  writeFileSync(path.join(dir, "src", "index.js"), "export default {}");
  writeFileSync(path.join(dir, "wrangler.toml"), config);
  return dir;
}

// Shared happy-path execFile stub: answers the version probe and writes the
// bundled entry the deploy pipeline expects in --outdir.
/**
 * @param {string} _cmd
 * @param {readonly string[]} args
 */
export function fakeWranglerExecFile(_cmd, args) {
  if (args.includes("--version")) return "wrangler 4.94.0";
  const outDir = /** @type {string} */ (args.find((arg) => arg.startsWith("--outdir="))).slice("--outdir=".length);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(path.join(outDir, "index.js"), "export default {}");
}

// A deploy issues at most two control calls: deploy, then promote if the CLI
// accepts the deploy response. Record both, answer them in that order, and
// reject anything further.
/**
 * @param {unknown} deployBody
 * @param {unknown} promoteBody
 */
export function deployPromoteFetch(deployBody, promoteBody) {
  const acknowledged = {
    active: true,
    version: /** @type {{ version?: unknown }} */ (deployBody)?.version,
    .../** @type {Record<string, unknown>} */ (promoteBody ?? {}),
  };
  /** @type {ControlCall[]} */
  const calls = [];
  return {
    calls,
    /** @param {string} url @param {import("../../lib/control-fetch.js").ControlFetchInit} [init] */
    controlFetch: async (url, init = {}) => {
      calls.push({ url, init });
      if (calls.length === 1) {
        assert.match(url, /\/deploy$/);
        return response(deployBody, 201);
      }
      if (calls.length === 2) {
        assert.match(url, /\/promote$/);
        return response(acknowledged);
      }
      throw new Error(`unexpected control call #${calls.length}: ${url}`);
    },
  };
}

/**
 * @param {string} cmd
 */
function assertWranglerCommand(cmd) {
  assert.ok(
    cmd === "wrangler" ||
      cmd === process.execPath ||
      path.basename(cmd) === (process.platform === "win32" ? "wrangler.cmd" : "wrangler"),
    `expected wrangler command, got ${cmd}`
  );
}

/**
 * @param {{ cmd: string, args: readonly string[] }} call
 */
export function assertWranglerVersionProbe(call) {
  assertWranglerCommand(call.cmd);
  if (call.cmd === process.execPath) {
    assert.match(call.args[0] || "", /wrangler[\\/]bin[\\/]wrangler\.js$/);
    assert.deepEqual(call.args.slice(1), ["--version"]);
    return;
  }
  assert.deepEqual(call.args, ["--version"]);
}
