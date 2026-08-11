import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { test } from "node:test";

import { runAiCommand } from "../../commands/ai.js";
import { mockDeps, response } from "./helpers.js";

/** @typedef {import("./helpers.js").ControlCall} ControlCall */

const PROVIDER = {
  kind: "openai",
  models: {
    primary: {
      upstreamModel: "gpt-5",
      protocol: "responses",
      transports: ["http", "sse"],
    },
  },
};

test("ai providers list and models render bounded summaries", async () => {
  /** @type {string[]} */
  const providerLines = [];
  await runAiCommand(["providers", "list", "--ns", "demo", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: (/** @type {string} */ line) => providerLines.push(line),
    controlFetch: async () =>
      response({
        providers: [{ name: "openai", kind: "openai", models: PROVIDER.models, credentialConfigured: true }],
      }),
  });
  assert.deepEqual(providerLines, ["openai kind=openai models=1 credential=configured"]);

  /** @type {string[]} */
  const modelLines = [];
  await runAiCommand(["models", "--ns", "demo", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: (/** @type {string} */ line) => modelLines.push(line),
    controlFetch: async () =>
      response({ models: [{ id: "openai/primary", protocol: "responses", transports: ["http", "sse"] }] }),
  });
  assert.deepEqual(modelLines, ["openai/primary protocol=responses transports=http,sse"]);
});

test("ai providers list and models support JSON and empty output", async () => {
  /** @type {string[]} */
  const jsonLines = [];
  const body = { providers: [] };
  await runAiCommand(["providers", "list", "--json", "--ns", "demo", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: (/** @type {string} */ line) => jsonLines.push(line),
    controlFetch: async () => response(body),
  });
  assert.deepEqual(jsonLines, [JSON.stringify(body, null, 2)]);

  /** @type {string[]} */
  const emptyLines = [];
  await runAiCommand(["models", "--ns", "demo", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: (/** @type {string} */ line) => emptyLines.push(line),
    controlFetch: async () => response({ models: [] }),
  });
  assert.deepEqual(emptyLines, ["(no configured AI models)"]);
});

test("ai providers get encodes path segments and prints credential state", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  await runAiCommand(["providers", "get", "provider/name", "--ns", "demo", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: (/** @type {string} */ line) => lines.push(line),
    controlFetch: async (
      /** @type {string} */ url,
      /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
    ) => {
      calls.push({ url, init });
      return response({
        provider: {
          name: "provider/name",
          revision: "0123456789abcdef0123456789abcdef",
          kind: "openai",
          models: PROVIDER.models,
          credentialConfigured: false,
        },
      });
    },
  });
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/ai/providers/provider%2Fname");
  assert.deepEqual(lines, [
    "name: provider/name",
    "kind: openai",
    "revision: 0123456789abcdef0123456789abcdef",
    "credential: missing",
    "model: primary (responses)",
  ]);
});

test("ai providers put reads project-local JSON and warns that credentials were cleared", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-ai-provider-"));
  try {
    writeFileSync(path.join(dir, "provider.json"), JSON.stringify(PROVIDER));
    /** @type {ControlCall[]} */
    const calls = [];
    /** @type {string[]} */
    const lines = [];
    await runAiCommand(
      ["providers", "put", "openai", "--file", "provider.json", "--ns", "demo", "--control-url", "http://ctl.test"],
      {
        cwd: dir,
        env: { ADMIN_TOKEN: "tok" },
        stdout: (/** @type {string} */ line) => lines.push(line),
        controlFetch: async (
          /** @type {string} */ url,
          /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
        ) => {
          calls.push({ url, init });
          return response({ provider: { name: "openai", revision: "0".repeat(32), ...PROVIDER } });
        },
      }
    );
    assert.equal(calls[0].url, "http://ctl.test/ns/demo/ai/providers/openai");
    assert.equal(calls[0].init.method, "PUT");
    assert.deepEqual(JSON.parse(/** @type {string} */ (calls[0].init.body)), PROVIDER);
    assert.deepEqual(lines, ["OK AI provider openai saved; credential cleared, configure it before use"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("ai providers put rejects invalid or out-of-project files before control", async () => {
  const parent = mkdtempSync(path.join(tmpdir(), "wdl-ai-provider-files-"));
  const dir = path.join(parent, "project");
  mkdirSync(dir);
  writeFileSync(path.join(dir, "bad.json"), "[");
  writeFileSync(path.join(parent, "outside.json"), JSON.stringify(PROVIDER));
  try {
    let calls = 0;
    const deps = {
      cwd: dir,
      env: { ADMIN_TOKEN: "tok" },
      controlFetch: async () => {
        calls += 1;
        return response({});
      },
    };
    await assert.rejects(
      runAiCommand(
        ["providers", "put", "openai", "--file", "bad.json", "--ns", "demo", "--control-url", "http://ctl.test"],
        deps
      ),
      /must contain valid JSON/
    );
    await assert.rejects(
      runAiCommand(
        ["providers", "put", "openai", "--file", "../outside.json", "--ns", "demo", "--control-url", "http://ctl.test"],
        deps
      ),
      /must stay inside the project/
    );
    assert.equal(calls, 0);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("ai credential put reads a hidden credential and CASes the current provider revision", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  const revision = "0123456789abcdef0123456789abcdef";
  await runAiCommand(["credential", "put", "openai", "--ns", "demo", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdin: Readable.from(["secret-key\n"]),
    stdout: (/** @type {string} */ line) => lines.push(line),
    controlFetch: async (
      /** @type {string} */ url,
      /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
    ) => {
      calls.push({ url, init });
      return calls.length === 1
        ? response({ provider: { name: "openai", revision, ...PROVIDER } })
        : response({ ok: true, provider: "openai", revision, credentialConfigured: true });
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/ai/providers/openai");
  assert.equal(calls[1].url, "http://ctl.test/ns/demo/ai/providers/openai/credential");
  assert.equal(calls[1].init.method, "PUT");
  assert.deepEqual(JSON.parse(/** @type {string} */ (calls[1].init.body)), {
    revision,
    credential: "secret-key",
  });
  assert.deepEqual(lines, ["OK AI credential configured for openai"]);
  assert.equal(lines.join("\n").includes("secret-key"), false);
});

test("ai credential put rejects an empty credential before mutation", async () => {
  let calls = 0;
  await assert.rejects(
    runAiCommand(["credential", "put", "openai", "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
      stdin: Readable.from(["\n"]),
      controlFetch: async () => {
        calls += 1;
        return response({ provider: { name: "openai", revision: "0".repeat(32), ...PROVIDER } });
      },
    }),
    /must not be empty/
  );
  assert.equal(calls, 1);
});

test("ai providers delete confirms and deletes metadata with its credential", async () => {
  const { calls, deps } = mockDeps({ ok: true, deleted: true });
  /** @type {string[]} */
  const lines = [];
  await runAiCommand(["providers", "delete", "openai", "--yes", "--ns", "demo", "--control-url", "http://ctl.test"], {
    ...deps,
    stdout: (/** @type {string} */ line) => lines.push(line),
  });
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/ai/providers/openai");
  assert.equal(calls[0].init.method, "DELETE");
  assert.deepEqual(lines, ["OK AI provider openai and its credential deleted"]);
});

test("ai rejects incomplete and unknown commands", async () => {
  await assert.rejects(
    runAiCommand(["providers", "put", "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
    }),
    /requires <provider>/
  );
  await assert.rejects(
    runAiCommand(["unknown", "--ns", "demo", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok" },
    }),
    /unknown ai command/
  );
});
