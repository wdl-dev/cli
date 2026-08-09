import { test } from "node:test";
import assert from "node:assert/strict";
import { formatWorkersList, runWorkersCommand } from "../../commands/workers.js";
import { ESC, assertNoRawTerminalControls, mockDeps, response } from "./helpers.js";

/** @typedef {import("./helpers.js").ControlCall} ControlCall */

test("workers command lists namespace worker state", async () => {
  const body = {
    namespace: "demo",
    workers: [
      {
        name: "api",
        activeVersion: "v2",
        versions: ["v1", "v2"],
        hasSecrets: true,
        hasWorkflowDefs: true,
      },
    ],
  };
  const { calls, lines, deps } = mockDeps(body);

  await runWorkersCommand(["--ns", "demo", "--control-url", "http://ctl.test"], deps);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/workers");
  assert.deepEqual(/** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ (calls[0].init).headers, {
    "x-admin-token": "tok",
  });
  assert.deepEqual(lines, ["api\tactive=v2\tversions=v1,v2\tsecrets=yes\tworkflow-defs=yes"]);
});

test("workers command does not double-slash paths when CONTROL_URL has a trailing slash", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  await runWorkersCommand(["--ns", "demo"], {
    env: {
      ADMIN_TOKEN: "tok",
      CONTROL_URL: "http://ctl.test/",
    },
    stdout: () => {},
    controlFetch: async (
      /** @type {string} */ url,
      /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
    ) => {
      calls.push({ url, init });
      return response({ namespace: "demo", workers: [] });
    },
  });

  assert.equal(calls[0].url, "http://ctl.test/ns/demo/workers");
});

test("workers command rejects unexpected positional arguments", async () => {
  await assert.rejects(
    () =>
      runWorkersCommand(["demo"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        controlFetch: async () => response({ namespace: "demo", workers: [] }),
      }),
    /Usage:/
  );
});

test("wdl workers escapes control sequences from the control plane but keeps tab columns", async () => {
  const hostile = `${ESC}[2J\nFORGED\rBAD\tCOLUMN\u009b`;
  /** @type {string[]} */
  const lines = [];
  await runWorkersCommand(["--ns", "demo", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: (/** @type {string} */ line) => lines.push(line),
    controlFetch: async () =>
      response({
        workers: [
          {
            name: `worker-${hostile}`,
            activeVersion: `v2-${hostile}`,
            versions: [`v1-${hostile}`],
            hasSecrets: false,
          },
        ],
      }),
  });
  const out = lines.join("\n");
  assertNoRawTerminalControls(out, "workers output");
  assert.match(out, /worker-\\u001b\[2J\\nFORGED\\rBAD\\tCOLUMN\\u009b/);
  assert.match(out, /active=v2-\\u001b\[2J\\nFORGED\\rBAD\\tCOLUMN\\u009b/);
  assert.match(out, /versions=v1-\\u001b\[2J\\nFORGED\\rBAD\\tCOLUMN\\u009b/);
  assert.equal(out.split("\t").length - 1, 4, "only formatter column separators may remain as raw tabs");
});

test("formatWorkersList handles empty and workflow-definition-only entries", () => {
  assert.deepEqual(formatWorkersList({ workers: [] }), ["(no workers)"]);
  assert.deepEqual(
    formatWorkersList({
      workers: [
        {
          name: "draft",
          activeVersion: null,
          versions: [],
          hasSecrets: false,
          hasWorkflowDefs: true,
        },
        {
          name: "legacy",
          activeVersion: "v1",
          versions: ["v1"],
          hasSecrets: false,
        },
        {
          name: "empty",
          activeVersion: null,
          versions: [],
          hasSecrets: false,
          hasWorkflowDefs: false,
        },
      ],
    }),
    [
      "draft\tactive=-\tversions=-\tsecrets=no\tworkflow-defs=yes",
      "legacy\tactive=v1\tversions=v1\tsecrets=no\tworkflow-defs=unknown",
      "empty\tactive=-\tversions=-\tsecrets=no\tworkflow-defs=no",
    ]
  );
});
