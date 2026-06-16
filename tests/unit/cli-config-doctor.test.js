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
import { maskToken } from "../../lib/common.js";
import { tokenStorePath, writeTokenStore } from "../../lib/token-store.js";
import { cliCompatibility, compareSemver } from "../../lib/whoami.js";
import { response } from "./helpers.js";

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

test("maskToken never reveals most of a short token", () => {
  assert.equal(maskToken("abcd"), "****");
  assert.equal(maskToken("ab"), "****");
  // A 4-char suffix of a 5-8 char token would reveal half or more of it.
  assert.equal(maskToken("abcde"), "****");
  assert.equal(maskToken("abcdefgh"), "****");
  assert.equal(maskToken("abcdefghi"), "****fghi");
});

test("config explain prints final values and sources", async () => {
  await withTempDir(async (cwd) => {
    writeFileSync(path.join(cwd, ".env"), [
      "CONTROL_URL=https://ctl.base.example",
      "[acme]",
      "ADMIN_TOKEN=section-token",
    ].join("\n"));

    const lines = [];
    await runConfigCommand(["explain", "--ns", "acme"], {
      cwd,
      env: {},
      stdout: (line) => lines.push(line),
    });

    const out = lines.join("\n");
    assert.ok(out.includes("namespace:\n  value: acme\n  source: --ns"));
    assert.ok(out.includes("controlUrl:\n  value: https://ctl.base.example\n  source: .env CONTROL_URL"));
    assert.ok(out.includes("token:\n  value: ****oken\n  source: .env [acme].ADMIN_TOKEN"));
  });
});

test("bin does not preload .env for local diagnostic commands", async () => {
  const calls = [];
  const oldLog = console.log;
  console.log = () => {};
  try {
    await wdlMain(["config", "--help"], { loadEnv: () => calls.push("config") });
    await wdlMain(["doctor", "--help"], { loadEnv: () => calls.push("doctor") });
    await wdlMain(["whoami", "--help"], { loadEnv: () => calls.push("whoami") });
  } finally {
    console.log = oldLog;
  }
  assert.deepEqual(calls, []);
});

test("whoami calls control introspection and prints platform compatibility", async () => {
  await withTempDir(async (cwd) => {
    const calls = [];
    const lines = [];
    await runWhoamiCommand(["--ns", "acme", "--control-url", "http://ctl.test", "--token", "secret-token"], {
      cwd,
      env: {},
      stdout: (line) => lines.push(line),
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

    assert.deepEqual(calls, [{
      url: "http://ctl.test/whoami",
      init: { headers: { "x-admin-token": "secret-token" } },
    }]);
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
    const lines = [];
    await runWhoamiCommand(["--ns", "configured", "--token", "secret-token"], {
      cwd,
      env: { CONTROL_URL: "https://api.wdl.dev" },
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

    const lines = [];
    let childEnv = /** @type {any} */ (null);
    const calls = [];
    const mockWranglerVersion = "9.8.7";
    const execFile = (_cmd, _args, options) => {
      childEnv = options.env;
      return `${mockWranglerVersion}\n`;
    };
    await runDoctorCommand(["--ns", "acme", "--token", "secret-token"], {
      cwd,
      env: { CONTROL_URL: "https://api.wdl.dev" },
      execFile,
      stdout: (line) => lines.push(line),
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
    assert.deepEqual(calls, [{
      url: "https://api.wdl.dev/whoami",
      init: { headers: { "x-admin-token": "secret-token" } },
    }]);
  });
});

test("doctor does not duplicate missing-token errors for skipped whoami", async () => {
  await withTempDir(async (cwd) => {
    const lines = [];
    await runDoctorCommand(["--ns", "acme"], {
      cwd,
      env: {},
      execFile: () => "4.94.0\n",
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
    const lines = [];
    await runDoctorCommand(["--ns", "configured", "--token", "secret-token"], {
      cwd,
      env: { CONTROL_URL: "https://api.wdl.dev" },
      execFile: () => "4.94.0\n",
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
    const lines = [];
    await runDoctorCommand(["--ns", "acme", "--token", "secret-token"], {
      cwd,
      env: { CONTROL_URL: "https://api.wdl.dev" },
      execFile: () => "3.99.0\n",
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
    const whoamiWarnings = [];
    await runWhoamiCommand(["--ns", "acme", "--control-url", "http://ctl.prod.example", "--token", "secret-token"], {
      cwd,
      env: {},
      stdout: () => {},
      warn: (line) => whoamiWarnings.push(line),
      controlFetch: async () => response(whoamiBody),
    });
    assert.equal(whoamiWarnings.length, 1);
    assert.match(whoamiWarnings[0], /plain http on a non-local host/);
  });

  await withTempDir(async (cwd) => {
    const doctorWarnings = [];
    await runDoctorCommand(["--ns", "acme", "--control-url", "http://ctl.prod.example", "--token", "secret-token"], {
      cwd,
      env: {},
      execFile: () => "4.94.0\n",
      stdout: () => {},
      warn: (line) => doctorWarnings.push(line),
      controlFetch: async () => response(whoamiBody),
    });
    assert.equal(doctorWarnings.length, 1);
    assert.match(doctorWarnings[0], /plain http on a non-local host/);
  });
});
