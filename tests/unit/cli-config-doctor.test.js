import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runConfigCommand } from "../../commands/config.js";
import { runDoctorCommand } from "../../commands/doctor.js";
import { runWhoamiCommand } from "../../commands/whoami.js";
import { main as wdlMain } from "../../bin/wdl.js";
import { resolveCliConfigState } from "../../lib/config-state.js";
import { tokenStorePath, writeTokenStore } from "../../lib/token-store.js";
import { cliCompatibility, compareSemver, ensureControlContextFromConfigState } from "../../lib/whoami.js";
import { response } from "./helpers.js";

/** @typedef {import("./helpers.js").ControlCall} ControlCall */

/**
 * @template T
 * @param {(dir: string) => T} fn
 * @returns {T}
 */
function withTempDir(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-config-test-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("resolveCliConfigState reports .env section sources and masks token", () => {
  withTempDir((cwd) => {
    writeFileSync(path.join(cwd, ".env"), [
      "CONTROL_URL=https://ctl.base.example",
      "ADMIN_TOKEN=base-token",
      "",
      "[acme]",
      "ADMIN_TOKEN=section-token",
    ].join("\n"));

    const state = resolveCliConfigState({
      values: { ns: "acme" },
      env: {},
      cwd,
    });

    assert.equal(state.namespace.display, "acme");
    assert.equal(state.namespace.source, "--ns");
    assert.equal(state.controlUrl.display, "https://ctl.base.example");
    assert.equal(state.controlUrl.source, ".env CONTROL_URL");
    assert.equal(state.token.display, "****oken");
    assert.equal(state.token.source, ".env [acme].ADMIN_TOKEN");
  });
});

test("resolveCliConfigState resolves the .env namespace over the store default given an empty shell WDL_NS", () => {
  withTempDir((cwd) => {
    const xdg = path.join(cwd, "xdg");
    writeTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg }), {
      defaultNs: "demo",
      namespaces: {
        acme: { CONTROL_URL: "https://acme.store.example", ADMIN_TOKEN: "acme-store-token" },
        demo: { CONTROL_URL: "https://demo.store.example", ADMIN_TOKEN: "demo-store-token" },
      },
    });
    writeFileSync(path.join(cwd, ".env"), [
      "WDL_NS=acme",
      "",
      "[acme]",
      "CONTROL_URL=https://acme.env.example",
      "ADMIN_TOKEN=acme-env-token",
    ].join("\n"));

    const state = resolveCliConfigState({
      env: { WDL_NS: "", XDG_CONFIG_HOME: xdg },
      cwd,
    });

    assert.equal(state.namespace.display, "acme", "the .env namespace wins, not the demo store default");
    assert.equal(state.controlUrl.display, "https://acme.env.example", "control comes from the .env acme section");
  });
});

test("resolveCliConfigState ignores the token store with WDL_TOKEN_STORE=off / --no-token-store", () => {
  withTempDir((cwd) => {
    const xdg = path.join(cwd, "xdg");
    writeTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg }), {
      defaultNs: "demo",
      namespaces: { demo: { CONTROL_URL: "https://demo.store.example", ADMIN_TOKEN: "demo-store-token" } },
    });

    const baseline = resolveCliConfigState({ env: { WDL_NS: "", XDG_CONFIG_HOME: xdg }, cwd });
    assert.equal(baseline.namespace.display, "demo", "baseline: store default namespace resolves");
    assert.ok(baseline.token.value, "baseline: store token gap-fills");

    const viaEnv = resolveCliConfigState({ env: { WDL_NS: "", XDG_CONFIG_HOME: xdg, WDL_TOKEN_STORE: "off" }, cwd });
    assert.ok(!viaEnv.namespace.value, "WDL_TOKEN_STORE=off: no store default namespace");
    assert.ok(!viaEnv.token.value, "WDL_TOKEN_STORE=off: no store token");

    const viaFlag = resolveCliConfigState({ values: { "no-token-store": true }, env: { WDL_NS: "", XDG_CONFIG_HOME: xdg }, cwd });
    assert.ok(!viaFlag.namespace.value, "--no-token-store: no store default namespace");
  });
});

test("a project .env cannot disable the token store (WDL_TOKEN_STORE is not a .env key)", () => {
  withTempDir((cwd) => {
    const xdg = path.join(cwd, "xdg");
    writeTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg }), {
      defaultNs: "demo",
      namespaces: { demo: { CONTROL_URL: "https://demo.store.example", ADMIN_TOKEN: "demo-store-token" } },
    });
    writeFileSync(path.join(cwd, ".env"), "WDL_TOKEN_STORE=off\n");

    const state = resolveCliConfigState({ env: { WDL_NS: "", XDG_CONFIG_HOME: xdg }, cwd });
    assert.equal(state.namespace.display, "demo", ".env WDL_TOKEN_STORE=off is ignored; the store is still used");
    assert.equal(state.tokenStoreDisabled, false, "the opt-out only reads the process env, not .env");
  });
});

test("the dispatcher honors --no-token-store when autoloading credentials", async () => {
  const oldExit = process.exit;
  const oldError = console.error;
  process.exit = (code) => { throw new Error(`exit:${code}`); };
  console.error = () => {};
  try {
    await withTempDir(async (cwd) => {
      const xdg = path.join(cwd, "xdg");
      writeTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg }), {
        defaultNs: "demo",
        namespaces: { demo: { CONTROL_URL: "http://ctl.test", ADMIN_TOKEN: "store-token" } },
      });

      // Assert what the dispatcher resolved from the store into the env it
      // autoloads. loadEnv isolates .env; `secret` with no subcommand fails its
      // arg check before any control fetch, so the command never hits the network.
      /** @type {NodeJS.ProcessEnv} */
      const baseEnv = { XDG_CONFIG_HOME: xdg, WDL_NS: "" };
      await wdlMain(["secret"], { env: baseEnv, loadEnv: () => [] }).catch(() => {});
      assert.equal(baseEnv.WDL_NS, "demo", "store default namespace applied");
      assert.equal(baseEnv.CONTROL_URL, "http://ctl.test", "store control URL gap-filled");
      assert.equal(baseEnv.ADMIN_TOKEN, "store-token", "store token gap-filled");

      /** @type {NodeJS.ProcessEnv} */
      const offEnv = { XDG_CONFIG_HOME: xdg, WDL_NS: "" };
      await wdlMain(["secret", "--no-token-store"], { env: offEnv, loadEnv: () => [] }).catch(() => {});
      assert.equal(offEnv.WDL_NS, "", "--no-token-store: no store default namespace");
      assert.equal(offEnv.CONTROL_URL, undefined, "--no-token-store: no store control URL");
      assert.equal(offEnv.ADMIN_TOKEN, undefined, "--no-token-store: no store token");
    });
  } finally {
    process.exit = oldExit;
    console.error = oldError;
  }
});


test("config explain prints final values and sources", async () => {
  await withTempDir(async (cwd) => {
    writeFileSync(path.join(cwd, ".env"), [
      "CONTROL_URL=https://ctl.base.example",
      "[acme]",
      "ADMIN_TOKEN=section-token",
    ].join("\n"));

    /** @type {string[]} */
    const lines = [];
    await runConfigCommand(["explain", "--ns", "acme"], {
      cwd,
      env: {},
      /** @param {string} line */
      stdout: (line) => lines.push(line),
    });

    const out = lines.join("\n");
    assert.ok(out.includes("namespace:\n  value: acme\n  source: --ns"));
    assert.ok(out.includes("controlUrl:\n  value: https://ctl.base.example\n  source: .env CONTROL_URL"));
    assert.ok(out.includes("token:\n  value: ****oken\n  source: .env [acme].ADMIN_TOKEN"));
  });
});

test("bin does not preload .env for local diagnostic commands", async () => {
  /** @type {string[]} */
  const calls = [];
  const oldLog = console.log;
  console.log = () => {};
  try {
    await wdlMain(["config", "--help"], { loadEnv: () => { calls.push("config"); return []; } });
    await wdlMain(["doctor", "--help"], { loadEnv: () => { calls.push("doctor"); return []; } });
    await wdlMain(["whoami", "--help"], { loadEnv: () => { calls.push("whoami"); return []; } });
  } finally {
    console.log = oldLog;
  }
  assert.deepEqual(calls, []);
});

test("whoami calls control introspection and prints platform compatibility", async () => {
  await withTempDir(async (cwd) => {
    /** @type {ControlCall[]} */
    const calls = [];
    /** @type {string[]} */
    const lines = [];
    await runWhoamiCommand(["--ns", "acme", "--control-url", "http://ctl.test", "--token", "secret-token"], {
      cwd,
      env: {},
      /** @param {string} line */
      stdout: (line) => lines.push(line),
      /** @param {string} url @param {import("../../lib/control-fetch.js").ControlFetchInit} [init] */
      controlFetch: async (url, init = {}) => {
        calls.push({ url, init });
        return response({
          ok: true,
          principal: { kind: "ns", ns: "acme" },
          tokenId: "tok_123",
          requestId: "req_123",
          platformVersion: "wdl.20260531.1",
          minCliVersion: "0.7.1",
          urls: {
            control: "http://ctl.test",
            namespace: "https://acme.wdl.sh",
            assets: "https://assets.example",
          },
        });
      },
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "http://ctl.test/whoami");
    assert.deepEqual(calls[0].init.headers, { "x-admin-token": "secret-token" });
    const out = lines.join("\n");
    assert.match(out, /Control URL: http:\/\/ctl\.test/);
    assert.match(out, /Namespace:\s+acme/);
    assert.match(out, /Principal:\s+ns\/acme/);
    assert.match(out, /Token ID:\s+tok_123/);
    assert.match(out, /Platform:\s+wdl\.20260531\.1/);
    assert.match(out, /Min CLI:\s+0\.7\.1/);
    assert.match(out, /Compat:\s+ok - CLI \d+\.\d+\.\d+\S* satisfies control minimum 0\.7\.1/);
    assert.match(out, /Namespace URL: https:\/\/acme\.wdl\.sh/);
  });
});

test("whoami text reports configured namespace mismatch", async () => {
  await withTempDir(async (cwd) => {
    /** @type {string[]} */
    const lines = [];
    await runWhoamiCommand(["--ns", "configured", "--token", "secret-token"], {
      cwd,
      env: { CONTROL_URL: "https://api.wdl.dev" },
      /** @param {string} line */
      stdout: (line) => lines.push(line),
      controlFetch: async () => response({
        ok: true,
        principal: { kind: "ns", ns: "actual" },
        tokenId: "tok_123",
        minCliVersion: "0.7.1",
        urls: { control: "https://api.wdl.dev" },
      }),
    });

    assert.match(lines.join("\n"), /Configured NS: configured \(token principal is actual\)/);
  });
});

test("doctor reports local checks plus remote whoami", async () => {
  await withTempDir(async (cwd) => {
    mkdirSync(path.join(cwd, "node_modules", ".bin"), { recursive: true });
    writeFileSync(path.join(cwd, "wrangler.jsonc"), "{}");

    /** @type {string[]} */
    const lines = [];
    /** @type {NodeJS.ProcessEnv | undefined} */
    let childEnv;
    /** @type {ControlCall[]} */
    const calls = [];
    const mockWranglerVersion = "9.8.7";
    /**
     * @param {string} _cmd
     * @param {readonly string[]} _args
     * @param {import("node:child_process").ExecFileSyncOptions} options
     */
    const execFile = (_cmd, _args, options) => {
      childEnv = options.env;
      return `${mockWranglerVersion}\n`;
    };
    await runDoctorCommand(["--ns", "acme", "--token", "secret-token"], {
      cwd,
      env: { CONTROL_URL: "https://api.wdl.dev" },
      execFile,
      /** @param {string} line */
      stdout: (line) => lines.push(line),
      /** @param {string} url @param {import("../../lib/control-fetch.js").ControlFetchInit} [init] */
      controlFetch: async (url, init = {}) => {
        calls.push({ url, init });
        return response({
          ok: true,
          principal: { kind: "ns", ns: "acme" },
          tokenId: "tok_123",
          requestId: "req_123",
          platformVersion: "wdl.20260531.1",
          minCliVersion: "0.7.1",
          urls: { control: "https://api.wdl.dev" },
        });
      },
    });

    const out = lines.join("\n");
    assert.match(out, /✓ Node\.js /);
    assert.match(out, /✓ wdl-cli /);
    assert.match(out, new RegExp(`✓ Wrangler ${mockWranglerVersion.replaceAll(".", "\\.")}`));
    assert.match(out, /✓ CONTROL_URL https:\/\/api\.wdl\.dev/);
    assert.match(out, /✓ ADMIN_TOKEN \*\*\*\*oken/);
    assert.match(out, /✓ Namespace acme/);
    assert.match(out, /✓ Wrangler config wrangler\.jsonc/);
    assert.match(out, /✓ CONTROL_URL reachable/);
    assert.match(out, /✓ ADMIN_TOKEN valid/);
    assert.match(out, /✓ Principal ns\/acme/);
    assert.match(out, /✓ CLI compatibility supported/);
    assert.match(out, /✓ Platform wdl\.20260531\.1/);
    assert.match(out, /✓ Token namespace acme\n {2}matches configured namespace acme/);
    assert.ok(childEnv);
    assert.equal(childEnv.ADMIN_TOKEN, undefined);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, "https://api.wdl.dev/whoami");
    assert.deepEqual(calls[0].init.headers, { "x-admin-token": "secret-token" });
    assert.equal(calls[0].init.env?.CONTROL_URL, "https://api.wdl.dev");
  });
});

test("doctor --strict exits non-zero when any check fails", async () => {
  await withTempDir(async (cwd) => {
    writeFileSync(path.join(cwd, "wrangler.jsonc"), "{}");
    /** @type {string[]} */
    const lines = [];

    await assert.rejects(
      () => runDoctorCommand(["--strict", "--ns", "acme", "--token", "secret-token"], {
        cwd,
        env: { CONTROL_URL: "https://api.wdl.dev" },
        execFile: () => "wrangler 3.99.0\n",
        stdout: (/** @type {string} */ line) => lines.push(line),
        controlFetch: async () => response({
          ok: true,
          principal: { kind: "ns", ns: "acme" },
          minCliVersion: "0.7.1",
        }),
      }),
      /doctor checks failed/
    );

    const out = lines.join("\n");
    assert.match(out, /✗ Wrangler 3\.99\.0/);
    assert.match(out, /wdl deploy requires Wrangler v4/);
  });
});

test("doctor reports shadowed Wrangler config files", async () => {
  await withTempDir(async (cwd) => {
    writeFileSync(path.join(cwd, "wrangler.json"), "{}");
    writeFileSync(path.join(cwd, "wrangler.toml"), 'name = "old"\n');
    /** @type {string[]} */
    const lines = [];

    await runDoctorCommand([], {
      cwd,
      env: {},
      execFile: () => "wrangler 4.99.0\n",
      stdout: (/** @type {string} */ line) => lines.push(line),
    });

    const out = lines.join("\n");
    assert.match(out, /✓ Wrangler config wrangler\.json/);
    assert.match(out, /ignoring wrangler\.toml by Wrangler priority/);
  });
});

test("doctor reports the token store namespace count and the build-readable caveat", async () => {
  await withTempDir(async (cwd) => {
    const xdg = path.join(cwd, "xdg");
    writeTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg }), {
      defaultNs: "demo",
      namespaces: {
        demo: { CONTROL_URL: "http://ctl.test", ADMIN_TOKEN: "t1" },
        other: { CONTROL_URL: "http://ctl.test", ADMIN_TOKEN: "t2" },
      },
    });
    /** @type {string[]} */
    const lines = [];
    await runDoctorCommand(["--ns", "demo", "--control-url", "http://ctl.test", "--token", "secret-token"], {
      cwd,
      env: { XDG_CONFIG_HOME: xdg },
      execFile: () => "4.94.0\n",
      /** @param {string} line */
      stdout: (line) => lines.push(line),
      controlFetch: async () =>
        response({ ok: true, principal: { kind: "ns", ns: "demo" }, urls: { control: "http://ctl.test" } }),
    });
    const out = lines.join("\n");
    assert.match(out, /Token store 2 namespaces/);
    assert.match(out, /readable by project build code/);
  });
});

test("doctor reports a corrupt token store as a failed check", async () => {
  await withTempDir(async (cwd) => {
    writeFileSync(path.join(cwd, "wrangler.jsonc"), "{}");
    const xdg = path.join(cwd, "xdg");
    const storePath = tokenStorePath({ XDG_CONFIG_HOME: xdg });
    mkdirSync(path.dirname(storePath), { recursive: true });
    writeFileSync(storePath, "[demo]\nADMIN_TOKEN=\"unterminated\n");
    /** @type {string[]} */
    const lines = [];

    await assert.rejects(
      () => runDoctorCommand(["--strict", "--ns", "demo", "--control-url", "http://ctl.test", "--token", "secret-token"], {
        cwd,
        env: { XDG_CONFIG_HOME: xdg },
        execFile: () => "4.94.0\n",
        /** @param {string} line */
        stdout: (line) => lines.push(line),
        controlFetch: async () =>
          response({ ok: true, principal: { kind: "ns", ns: "demo" }, urls: { control: "http://ctl.test" } }),
      }),
      /doctor checks failed/
    );

    const out = lines.join("\n");
    assert.match(out, /✗ Token store/);
    assert.match(out, /Invalid \.env value: missing closing quote/);
    assert.doesNotMatch(out, /Token store none/);
  });
});

test("doctor reports a corrupt token store even when it blocks credential resolution", async () => {
  await withTempDir(async (cwd) => {
    writeFileSync(path.join(cwd, "wrangler.jsonc"), "{}");
    const xdg = path.join(cwd, "xdg");
    const storePath = tokenStorePath({ XDG_CONFIG_HOME: xdg });
    mkdirSync(path.dirname(storePath), { recursive: true });
    writeFileSync(storePath, "[demo]\nADMIN_TOKEN=\"unterminated\n");
    /** @type {string[]} */
    const lines = [];

    await assert.rejects(
      () => runDoctorCommand(["--strict"], {
        cwd,
        env: { XDG_CONFIG_HOME: xdg, WDL_NS: "demo" },
        execFile: () => "4.94.0\n",
        /** @param {string} line */
        stdout: (line) => lines.push(line),
        controlFetch: async () => {
          throw new Error("whoami should be skipped without resolved credentials");
        },
      }),
      /doctor checks failed/
    );

    const out = lines.join("\n");
    assert.match(out, /✗ Token store/);
    assert.match(out, /Invalid \.env value: missing closing quote/);
    assert.match(out, /✗ ADMIN_TOKEN/);
    assert.match(out, /✗ CONTROL_URL/);
    assert.doesNotMatch(out, /Token store disabled/);
    assert.doesNotMatch(out, /Control \/whoami/);
  });
});

test("doctor honors --no-token-store: reports the store disabled without reading it", async () => {
  await withTempDir(async (cwd) => {
    const xdg = path.join(cwd, "xdg");
    writeTokenStore(tokenStorePath({ XDG_CONFIG_HOME: xdg }), {
      defaultNs: "demo",
      namespaces: { demo: { CONTROL_URL: "http://ctl.test", ADMIN_TOKEN: "t1" } },
    });
    /** @type {string[]} */
    const lines = [];
    await runDoctorCommand(
      ["--ns", "demo", "--control-url", "http://ctl.test", "--token", "secret-token", "--no-token-store"],
      {
        cwd,
        env: { XDG_CONFIG_HOME: xdg },
        execFile: () => "4.94.0\n",
        /** @param {string} line */
        stdout: (line) => lines.push(line),
        controlFetch: async () =>
          response({ ok: true, principal: { kind: "ns", ns: "demo" }, urls: { control: "http://ctl.test" } }),
      },
    );
    const out = lines.join("\n");
    assert.match(out, /Token store disabled/);
    assert.doesNotMatch(out, /Token store \d+ namespace/);
  });
});

test("doctor does not duplicate missing-token errors for skipped whoami", async () => {
  await withTempDir(async (cwd) => {
    /** @type {string[]} */
    const lines = [];
    await runDoctorCommand(["--ns", "acme"], {
      cwd,
      env: {},
      execFile: () => "4.94.0\n",
      /** @param {string} line */
      stdout: (line) => lines.push(line),
      controlFetch: async () => {
        throw new Error("controlFetch should not be called");
      },
    });

    const out = lines.join("\n");
    assert.match(out, /✗ ADMIN_TOKEN\n {2}Missing token\. Set ADMIN_TOKEN or pass --token\./);
    assert.doesNotMatch(out, /Control \/whoami/);
  });
});

test("doctor reports namespace mismatch from whoami", async () => {
  await withTempDir(async (cwd) => {
    /** @type {string[]} */
    const lines = [];
    await runDoctorCommand(["--ns", "configured", "--token", "secret-token"], {
      cwd,
      env: { CONTROL_URL: "https://api.wdl.dev" },
      execFile: () => "4.94.0\n",
      /** @param {string} line */
      stdout: (line) => lines.push(line),
      controlFetch: async () => response({
        ok: true,
        principal: { kind: "ns", ns: "actual" },
        tokenId: "tok_123",
        minCliVersion: "0.7.1",
        urls: { control: "https://api.wdl.dev" },
      }),
    });

    assert.match(lines.join("\n"), /✗ Token namespace actual\n {2}configured namespace is configured/);
  });
});

test("doctor flags a Wrangler major below the deploy minimum", async () => {
  await withTempDir(async (cwd) => {
    /** @type {string[]} */
    const lines = [];
    await runDoctorCommand(["--ns", "acme", "--token", "secret-token"], {
      cwd,
      env: { CONTROL_URL: "https://api.wdl.dev" },
      execFile: () => "3.99.0\n",
      /** @param {string} line */
      stdout: (line) => lines.push(line),
      controlFetch: async () => response({
        ok: true,
        principal: { kind: "ns", ns: "acme" },
        minCliVersion: "0.7.1",
      }),
    });

    const out = lines.join("\n");
    assert.match(out, /✗ Wrangler 3\.99\.0/);
    assert.match(out, /wdl deploy requires Wrangler v4/);
  });
});

test("compareSemver orders pre-releases below their release", () => {
  assert.equal(compareSemver("0.9.0-beta.1", "0.9.0"), -1);
  assert.equal(compareSemver("0.9.0", "0.9.0-beta.1"), 1);
  assert.equal(compareSemver("0.9.0-a", "0.9.0-b"), 0);
  assert.equal(compareSemver("0.9.0+build.5", "0.9.0"), 0);
  assert.equal(compareSemver("0.10.0-beta.1", "0.9.0"), 1);
});

test("cliCompatibility treats a pre-release CLI as older than the release minimum", () => {
  assert.equal(cliCompatibility("0.9.0-beta.1", "0.9.0").ok, false);
  assert.equal(cliCompatibility("0.9.1-beta.1", "0.9.0").ok, true);
  assert.equal(cliCompatibility("0.9.0", "0.9.0").ok, true);
});

test("ensureControlContextFromConfigState fails closed on an unresolved control URL", () => {
  const token = { value: "tok", display: "****", source: "--token", error: null };
  // value:null with no error shouldn't happen, but must never be returned as a string.
  assert.throws(
    () => ensureControlContextFromConfigState({
      controlUrl: { value: null, display: "(unset)", source: "(unset)", error: null },
      token,
    }),
    /No control URL configured/
  );
  // An explicit resolver error is surfaced verbatim.
  assert.throws(
    () => ensureControlContextFromConfigState({
      controlUrl: { value: null, display: "(unset)", source: "--control-url", error: "boom" },
      token,
    }),
    /boom/
  );
  // A fully resolved state yields the admin-token header.
  assert.deepEqual(
    ensureControlContextFromConfigState({
      controlUrl: { value: "https://api.example", display: "https://api.example", source: "--control-url", error: null },
      token,
    }),
    {
      controlUrl: "https://api.example",
      token: "tok",
      headers: { "x-admin-token": "tok" },
    }
  );
});

test("whoami and doctor warn when the token would travel over plain http to a non-local host", async () => {
  const whoamiBody = {
    ok: true,
    principal: { kind: "ns", ns: "acme" },
    tokenId: "tok_123",
    minCliVersion: "0.7.1",
    urls: {},
  };

  // Run in an empty temp cwd so no real repo-root .env feeds the cross-origin
  // guard (which would add a second, unrelated warning).
  await withTempDir(async (cwd) => {
    /** @type {string[]} */
    const whoamiWarnings = [];
    await runWhoamiCommand(["--ns", "acme", "--control-url", "http://ctl.prod.example", "--token", "secret-token"], {
      cwd,
      env: {},
      stdout: () => {},
      /** @param {string} line */
      warn: (line) => whoamiWarnings.push(line),
      controlFetch: async () => response(whoamiBody),
    });
    assert.equal(whoamiWarnings.length, 1);
    assert.match(whoamiWarnings[0], /plain http on a non-local host/);
  });

  await withTempDir(async (cwd) => {
    /** @type {string[]} */
    const doctorWarnings = [];
    await runDoctorCommand(["--ns", "acme", "--control-url", "http://ctl.prod.example", "--token", "secret-token"], {
      cwd,
      env: {},
      execFile: () => "4.94.0\n",
      stdout: () => {},
      /** @param {string} line */
      warn: (line) => doctorWarnings.push(line),
      controlFetch: async () => response(whoamiBody),
    });
    assert.equal(doctorWarnings.length, 1);
    assert.match(doctorWarnings[0], /plain http on a non-local host/);
  });
});

test("whoami and doctor pass effective .env CONTROL_CONNECT_HOST to whoami requests", async () => {
  const whoamiBody = {
    ok: true,
    principal: { kind: "ns", ns: "acme" },
    tokenId: "tok_123",
    minCliVersion: "0.7.1",
    urls: {},
  };

  await withTempDir(async (cwd) => {
    writeFileSync(path.join(cwd, ".env"), [
      "CONTROL_URL=http://admin.test:8080",
      "CONTROL_CONNECT_HOST=127.0.0.1:18080",
      "ADMIN_TOKEN=env-token",
    ].join("\n"));
    /** @type {import("../../lib/control-fetch.js").ControlFetchInit[]} */
    const seen = [];
    await runWhoamiCommand(["--ns", "acme"], {
      cwd,
      env: {},
      stdout: () => {},
      controlFetch: async (
        /** @type {string} */ _url,
        /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {},
      ) => {
        seen.push(init);
        return response(whoamiBody);
      },
    });

    assert.equal(seen[0].env?.CONTROL_CONNECT_HOST, "127.0.0.1:18080");
    assert.deepEqual(seen[0].headers, { "x-admin-token": "env-token" });
  });

  await withTempDir(async (cwd) => {
    writeFileSync(path.join(cwd, ".env"), [
      "CONTROL_URL=http://admin.test:8080",
      "CONTROL_CONNECT_HOST=127.0.0.1:18080",
      "ADMIN_TOKEN=env-token",
    ].join("\n"));
    /** @type {import("../../lib/control-fetch.js").ControlFetchInit[]} */
    const seen = [];
    await runDoctorCommand(["--ns", "acme"], {
      cwd,
      env: {},
      execFile: () => "4.94.0\n",
      stdout: () => {},
      controlFetch: async (
        /** @type {string} */ _url,
        /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {},
      ) => {
        seen.push(init);
        return response(whoamiBody);
      },
    });

    assert.equal(seen[0].env?.CONTROL_CONNECT_HOST, "127.0.0.1:18080");
    assert.deepEqual(seen[0].headers, { "x-admin-token": "env-token" });
  });
});
