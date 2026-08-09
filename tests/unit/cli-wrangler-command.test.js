import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  checkWranglerVersion,
  formatWranglerFailure,
  parseWranglerMajorVersion,
  probeWranglerVersion,
  resolveWranglerCommand,
  wranglerChildEnv,
} from "../../lib/wrangler/command.js";
import { ESC, assertNoRawTerminalControls, assertThrowsNoRawTerminalControls } from "./helpers.js";

/** @param {string} output */
function versionExecFile(output) {
  return /** @type {typeof import("node:child_process").execFileSync} */ (/** @type {unknown} */ (() => output));
}

test("parseWranglerMajorVersion accepts common wrangler --version output", () => {
  assert.equal(parseWranglerMajorVersion("4.94.0"), 4);
  assert.equal(parseWranglerMajorVersion("wrangler 4.94.0"), 4);
  assert.equal(parseWranglerMajorVersion(" ⛅️ wrangler 4.94.0\n"), 4);
  assert.equal(parseWranglerMajorVersion("not a version"), null);
});

test("probeWranglerVersion returns one parsed version shape for deploy and doctor", () => {
  const base = {
    cwd: "/tmp",
    env: {},
    wrangler: { command: "wrangler", args: [] },
  };
  let fallbackCalls = 0;
  assert.deepEqual(
    probeWranglerVersion({
      ...base,
      execFile: versionExecFile("wrangler 4.114.0\n"),
      fallbackVersion: () => {
        fallbackCalls += 1;
        return "4.113.0";
      },
    }),
    {
      version: "4.114.0",
      major: 4,
    }
  );
  assert.equal(fallbackCalls, 0);
  assert.deepEqual(probeWranglerVersion({ ...base, execFile: versionExecFile(""), fallbackVersion: () => "4.114.0" }), {
    version: "4.114.0",
    major: 4,
  });
});

test("checkWranglerVersion escapes unparsable version diagnostics", () => {
  const execFile = /** @type {typeof import("node:child_process").execFileSync} */ (
    /** @type {unknown} */ (() => `bad\u009b31m\nFORGED\rBAD`)
  );
  assertThrowsNoRawTerminalControls(
    () =>
      checkWranglerVersion({
        execFile,
        cwd: "/tmp/project",
        env: {},
        wrangler: { command: "wrangler", args: [] },
      }),
    /could not parse version/,
    "wrangler version parse"
  );
});

test("checkWranglerVersion escapes failed version probe diagnostics", () => {
  const execFile = /** @type {typeof import("node:child_process").execFileSync} */ (
    /** @type {unknown} */ (
      () => {
        const err = new Error(`boom${ESC}[2J\nFORGED\rBAD\u009b`);
        Object.assign(err, {
          stdout: `out${ESC}[2J\nline\rBAD`,
          stderr: "err\u009b31m",
        });
        throw err;
      }
    )
  );
  assert.throws(
    () =>
      checkWranglerVersion({
        execFile,
        cwd: "/tmp/project",
        env: {},
        wrangler: { command: "wrangler", args: [] },
      }),
    (err) => {
      const message = /** @type {Error} */ (err).message;
      assertNoRawTerminalControls(message, "wrangler version failure");
      assert.match(message, /boom\\u001b\[2J\\nFORGED\\rBAD\\u009b/);
      assert.match(message, /out\\u001b\[2J\nline\\rBAD\nerr\\u009b31m/);
      return true;
    }
  );
});

test("checkWranglerVersion ENOENT hint mentions the npx opt-in", () => {
  const execFile = /** @type {typeof import("node:child_process").execFileSync} */ (
    /** @type {unknown} */ (
      () => {
        const err = new Error("spawn wrangler ENOENT");
        Object.assign(err, { code: "ENOENT" });
        throw err;
      }
    )
  );
  assert.throws(
    () =>
      checkWranglerVersion({
        execFile,
        cwd: "/tmp/project",
        env: {},
        wrangler: { command: "wrangler", args: [] },
      }),
    /WDL_ALLOW_NPX_WRANGLER=1/
  );
});

test("formatWranglerFailure escapes captured dry-run diagnostics", () => {
  const message = formatWranglerFailure(
    Object.assign(new Error(`boom${ESC}[2J\nFORGED\rBAD\u009b`), {
      stdout: `out${ESC}[2J\nline\rBAD`,
      stderr: "err\u009b31m",
    })
  );
  assertNoRawTerminalControls(message, "wrangler build failure");
  assert.match(message, /boom\\u001b\[2J\\nFORGED\\rBAD\\u009b/);
  assert.match(message, /out\\u001b\[2J\nline\\rBAD\nerr\\u009b31m/);
});

test("resolveWranglerCommand prefers explicit WDL_WRANGLER_BIN", () => {
  assert.deepEqual(
    resolveWranglerCommand({
      absProject: "/project",
      env: { WDL_WRANGLER_BIN: "/opt/wrangler" },
      packageDirs: [],
    }),
    { command: "/opt/wrangler", args: [], source: "WDL_WRANGLER_BIN" }
  );
});

test("resolveWranglerCommand prefers project-local wrangler without npx", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-wrangler-bin-"));
  try {
    const binDir = path.join(dir, "node_modules", ".bin");
    mkdirSync(binDir, { recursive: true });
    const bin = path.join(binDir, process.platform === "win32" ? "wrangler.cmd" : "wrangler");
    writeFileSync(bin, "");

    assert.deepEqual(
      resolveWranglerCommand({
        absProject: dir,
        env: { WDL_ALLOW_NPX_WRANGLER: "1" },
        packageDirs: [],
      }),
      { command: bin, args: [], source: "project" }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWranglerCommand uses PATH wrangler by default", () => {
  assert.deepEqual(
    resolveWranglerCommand({
      absProject: "/project",
      env: {},
      packageDirs: [],
    }),
    { command: "wrangler", args: [], source: "path" }
  );
});

test("resolveWranglerCommand labels the CLI package wrangler as package", () => {
  const resolved = resolveWranglerCommand({
    absProject: "/project",
    env: { PATH: "" },
  });
  assert.equal(resolved.source, "package");
  assert.ok(
    resolved.command.includes("node") || resolved.command.includes("wrangler"),
    "package resolver should return a runnable wrangler command"
  );
});

test("resolveWranglerCommand prefers PATH wrangler before npx", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-wrangler-path-"));
  try {
    const bin = path.join(dir, process.platform === "win32" ? "wrangler.cmd" : "wrangler");
    writeFileSync(bin, "");

    assert.deepEqual(
      resolveWranglerCommand({
        absProject: "/project",
        env: { PATH: dir, WDL_ALLOW_NPX_WRANGLER: "1" },
        packageDirs: [],
      }),
      { command: bin, args: [], source: "path" }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWranglerCommand only uses npx when explicitly allowed", () => {
  assert.deepEqual(
    resolveWranglerCommand({
      absProject: "/project",
      env: { WDL_ALLOW_NPX_WRANGLER: "1" },
      packageDirs: [],
    }),
    { command: "npx", args: ["--yes", "wrangler"], source: "npx" }
  );
});

test("resolveWranglerCommand ignores unrelated cwd local wrangler", () => {
  const cwd = mkdtempSync(path.join(tmpdir(), "wdl-wrangler-cwd-"));
  const packageDir = mkdtempSync(path.join(tmpdir(), "wdl-wrangler-package-"));
  const originalCwd = process.cwd();
  try {
    const cwdBinDir = path.join(cwd, "node_modules", ".bin");
    mkdirSync(cwdBinDir, { recursive: true });
    writeFileSync(path.join(cwdBinDir, process.platform === "win32" ? "wrangler.cmd" : "wrangler"), "");
    process.chdir(cwd);

    const packageBinDir = path.join(packageDir, "node_modules", ".bin");
    mkdirSync(packageBinDir, { recursive: true });
    const packageBin = path.join(packageBinDir, process.platform === "win32" ? "wrangler.cmd" : "wrangler");
    writeFileSync(packageBin, "");

    assert.deepEqual(
      resolveWranglerCommand({
        absProject: "/trusted/project",
        env: {},
        packageDirs: [packageDir],
      }),
      { command: packageBin, args: [], source: "package" }
    );
  } finally {
    process.chdir(originalCwd);
    rmSync(cwd, { recursive: true, force: true });
    rmSync(packageDir, { recursive: true, force: true });
  }
});

test("resolveWranglerCommand on win32 runs the wrangler JS entry via node instead of the .cmd shim", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-wrangler-win32-"));
  try {
    const pkgBin = path.join(dir, "node_modules", "wrangler", "bin");
    mkdirSync(pkgBin, { recursive: true });
    const script = path.join(pkgBin, "wrangler.js");
    writeFileSync(script, "");
    const shimDir = path.join(dir, "node_modules", ".bin");
    mkdirSync(shimDir, { recursive: true });
    writeFileSync(path.join(shimDir, "wrangler.cmd"), "");

    assert.deepEqual(resolveWranglerCommand({ absProject: dir, env: {}, packageDirs: [], platform: "win32" }), {
      command: process.execPath,
      args: [script],
      source: "project",
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWranglerCommand on win32 prefers the package script next to a PATH .cmd shim", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-wrangler-win32-path-"));
  try {
    writeFileSync(path.join(dir, "wrangler.cmd"), "");
    const pkgBin = path.join(dir, "node_modules", "wrangler", "bin");
    mkdirSync(pkgBin, { recursive: true });
    const script = path.join(pkgBin, "wrangler.js");
    writeFileSync(script, "");

    assert.deepEqual(
      resolveWranglerCommand({
        absProject: "/project",
        env: { PATH: dir },
        packageDirs: [],
        platform: "win32",
      }),
      { command: process.execPath, args: [script], source: "path" }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveWranglerCommand on win32 fails loudly when only a bare PATH .cmd shim exists", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-wrangler-win32-bare-shim-"));
  try {
    writeFileSync(path.join(dir, "wrangler.cmd"), "");
    // A bare "wrangler" fallback would resolve back to the unrunnable shim
    // (or ENOENT); the resolver must refuse with an actionable error instead.
    assert.throws(
      () =>
        resolveWranglerCommand({
          absProject: "/project",
          env: { PATH: dir },
          packageDirs: [],
          platform: "win32",
        }),
      /No runnable wrangler found/
    );
    // The npx opt-in still provides a working escape hatch.
    assert.deepEqual(
      resolveWranglerCommand({
        absProject: "/project",
        env: { PATH: dir, WDL_ALLOW_NPX_WRANGLER: "1" },
        packageDirs: [],
        platform: "win32",
      }),
      { command: "npx", args: ["--yes", "wrangler"], source: "npx" }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("wranglerChildEnv scrubs control env, hides Wrangler's banner, and disables telemetry", () => {
  assert.deepEqual(
    wranglerChildEnv({
      ADMIN_TOKEN: "secret",
      CONTROL_CONNECT_HOST: "ctl.connect.example",
      CONTROL_URL: "https://ctl.example",
      WDL_NS: "tenant",
      // Legacy alias the CLI no longer reads, but must still scrub so a stale
      // export does not leak the control endpoint into the bundler.
      ADMIN_URL: "https://legacy-admin.example",
      CLOUDFLARE_API_TOKEN: "real-cloudflare-token",
      WRANGLER_HIDE_BANNER: "false",
      WRANGLER_SEND_METRICS: "true",
      PATH: "/bin",
      KEEP_ME: "ok",
    }),
    {
      CLOUDFLARE_API_TOKEN: "dry-run-dummy",
      WRANGLER_HIDE_BANNER: "true",
      WRANGLER_SEND_METRICS: "false",
      PATH: "/bin",
      KEEP_ME: "ok",
    }
  );
});
