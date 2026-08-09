import { test } from "node:test";
import assert from "node:assert/strict";
import { runDeleteCommand } from "../../commands/delete.js";
import { formatWorkerDelete } from "../../lib/delete-format.js";
import { ESC, mockDeps, response, stdinFrom, ttyStdinLine } from "./helpers.js";

/** @typedef {import("./helpers.js").ControlCall} ControlCall */

test("delete version calls the version hard-delete endpoint", async () => {
  const { calls, lines, deps } = mockDeps({
    namespace: "demo",
    name: "api",
    version: "v1",
    deleted: true,
    assets: { cleanupTaskId: null, skippedSharedPrefix: false, warnings: [] },
  });

  await runDeleteCommand(["version", "--ns", "demo", "api", "v1", "--control-url", "http://ctl.test"], deps);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/worker/api/versions/v1");
  assert.equal(/** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ (calls[0].init).method, "DELETE");
  assert.deepEqual(lines, ["OK demo/api@v1 deleted"]);
});

test("delete output does not expose internal cleanup task ids", async () => {
  const { lines, deps } = mockDeps({
    namespace: "demo",
    name: "api",
    activeDeleted: "v1",
    versionsDeleted: ["v1"],
    deleted: true,
    assets: { cleanupTaskId: "s3cleanup:internal", queueHint: "sent", warnings: [] },
  });

  await runDeleteCommand(["worker", "--ns", "demo", "api", "--yes", "--control-url", "http://ctl.test"], deps);

  assert.equal(
    lines.some((line) => line.includes("s3cleanup:internal")),
    false
  );
  assert.equal(
    lines.some((line) => line.includes("cleanup task")),
    false
  );
});

test("delete output projects asset warnings before printing", async () => {
  const { lines, deps } = mockDeps({
    namespace: "demo",
    name: "api",
    activeDeleted: "v1",
    versionsDeleted: ["v1"],
    deleted: true,
    assets: {
      warnings: [
        {
          code: "asset_cleanup_skipped",
          message: "cleanup skipped",
          internalTaskId: "s3cleanup:internal",
        },
      ],
    },
  });

  await runDeleteCommand(["worker", "--ns", "demo", "api", "--yes", "--control-url", "http://ctl.test"], deps);

  assert.equal(
    lines.some((line) => line.includes('{"code":"asset_cleanup_skipped","message":"cleanup skipped"}')),
    true
  );
  assert.equal(
    lines.some((line) => line.includes("s3cleanup:internal")),
    false
  );
});

test("delete worker supports dry-run query and raw json output", async () => {
  const body = {
    dryRun: true,
    namespace: "demo",
    name: "api",
    deleted: true,
    activeDeleted: "v2",
    versionsDeleted: ["v1", "v2"],
    affectedHosts: ["demo.workers.example"],
    queueConsumersRemoved: 1,
    hasWorkerSecrets: true,
    hasWorkflowDefs: true,
  };
  const { calls, lines, deps } = mockDeps(body);

  await runDeleteCommand(
    ["worker", "--ns", "demo", "api", "--dry-run", "--json", "--control-url", "http://ctl.test"],
    deps
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/worker/api/delete?dry_run=1");
  assert.equal(/** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ (calls[0].init).method, "POST");
  assert.deepEqual(lines, [JSON.stringify(body, null, 2)]);
});

test("delete worker dry-run reports state presence without overstating deletion", () => {
  const base = {
    dryRun: true,
    namespace: "demo",
    name: "api",
    activeDeleted: null,
    versionsDeleted: [],
  };
  assert.deepEqual(
    formatWorkerDelete({
      ...base,
      deleted: true,
      hasWorkerSecrets: true,
      hasWorkflowDefs: true,
    }),
    [
      "DRY RUN demo/api wouldDelete=yes active=- versions=-",
      "  worker secrets present",
      "  workflow definitions present",
    ]
  );
  assert.deepEqual(formatWorkerDelete({ ...base, deleted: false, hasWorkflowDefs: false }), [
    "DRY RUN demo/api wouldDelete=no active=- versions=-",
  ]);
  assert.deepEqual(formatWorkerDelete({ ...base, deleted: false }), [
    "DRY RUN demo/api wouldDelete=no active=- versions=-",
  ]);
});

test("delete worker dry-run renders workflow blockers in human output", async () => {
  const hostile = `bad${ESC}[2J\nFORGED\rBAD`;
  const body = {
    dryRun: true,
    namespace: `demo-${hostile}`,
    name: `api-${hostile}`,
    deleted: false,
    activeDeleted: `v2-${hostile}`,
    versionsDeleted: [`v1-${hostile}`],
    affectedHosts: [`host-${hostile}.example`],
    hasWorkerSecrets: true,
    hasWorkflowDefs: true,
    blockers: [
      {
        version: `v1-${hostile}`,
        referrers: [
          {
            callerNs: `ns-${hostile}`,
            callerWorker: `worker-${hostile}`,
            callerVersion: `version-${hostile}`,
            binding: `binding-${hostile}`,
          },
        ],
      },
    ],
    workflowBlocker: {
      error: `workflow_instances_active-${hostile}`,
      message: `demo/api has active workflow instances ${hostile}`,
      count: 1,
      blockers: [{ workflowKey: `wf-${hostile}`, instanceId: `inst-${hostile}` }],
    },
  };
  const { lines, deps } = mockDeps(body);

  await runDeleteCommand(["worker", "--ns", "demo", "api", "--dry-run", "--control-url", "http://ctl.test"], deps);

  const joined = lines.join("\n");
  assert.doesNotMatch(joined, new RegExp(ESC), "raw ESC must not reach delete dry-run output");
  assert.doesNotMatch(joined, /\nFORGED|\rBAD/, "raw line controls must not forge delete dry-run output");
  assert.ok(lines.some((line) => /workflow blocker/.test(line)));
  assert.match(joined, /DRY RUN demo-bad\\u001b\[2J\\nFORGED\\rBAD\/api-bad\\u001b\[2J\\nFORGED\\rBAD/);
  assert.match(joined, /affected hosts: host-bad\\u001b\[2J\\nFORGED\\rBAD\.example/);
  assert.match(joined, /worker secrets present/);
  assert.match(joined, /workflow definitions present/);
  assert.match(joined, /binding=binding-bad\\u001b\[2J\\nFORGED\\rBAD/);
  assert.match(joined, /workflow_instances_active-bad\\u001b\[2J\\nFORGED\\rBAD/);
  assert.match(joined, /wf-bad\\u001b\[2J\\nFORGED\\rBAD instance=inst-bad\\u001b\[2J\\nFORGED\\rBAD/);
});

test("delete worker requires confirmation unless --yes or --dry-run is used", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  await assert.rejects(
    () =>
      runDeleteCommand(["worker", "--ns", "demo", "api", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdin: stdinFrom(""),
        controlFetch: async (
          /** @type {string} */ url,
          /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
        ) => {
          calls.push({ url, init });
          return response({});
        },
      }),
    /Refusing to delete worker "demo\/api" without interactive confirmation/
  );
  assert.equal(calls.length, 0);

  await runDeleteCommand(["worker", "--ns", "demo", "api", "--yes", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: () => {},
    controlFetch: async (
      /** @type {string} */ url,
      /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
    ) => {
      calls.push({ url, init });
      return response({
        namespace: "demo",
        name: "api",
        deleted: true,
        versionsDeleted: ["v1"],
      });
    },
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/worker/api/delete");
});

test("delete worker proceeds after interactive confirmation", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const prompts = [];
  const stdin = ttyStdinLine("yes\n");

  await runDeleteCommand(["worker", "--ns", "demo", "api", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdin,
    stderr: (/** @type {string} */ text) => prompts.push(text),
    stdout: () => {},
    controlFetch: async (
      /** @type {string} */ url,
      /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
    ) => {
      calls.push({ url, init });
      return response({
        namespace: "demo",
        name: "api",
        deleted: true,
        versionsDeleted: ["v1"],
      });
    },
  });

  assert.equal(calls.length, 1);
  assert.deepEqual(prompts, ['Are you sure you want to delete worker "demo/api"? [y/N] ']);
  assert.equal(stdin.paused, true);
});

test("delete command exposes only documented destructive subcommands", async () => {
  await assert.rejects(
    () =>
      runDeleteCommand(["ver", "--ns", "demo", "api", "v1"], {
        env: { ADMIN_TOKEN: "tok" },
        controlFetch: async () => response({}),
      }),
    /unknown subcommand: ver/
  );
  await assert.rejects(
    () =>
      runDeleteCommand(["rm", "--ns", "demo", "api"], {
        env: { ADMIN_TOKEN: "tok" },
        controlFetch: async () => response({}),
      }),
    /unknown subcommand: rm/
  );
});

test("delete worker help lists workflow definitions among deleted state", async () => {
  /** @type {string[]} */
  const lines = [];
  await runDeleteCommand(["worker", "--help"], {
    env: {},
    stdout: (/** @type {string} */ line) => lines.push(line),
    controlFetch: async () => {
      throw new Error("controlFetch should not be called for help");
    },
  });
  assert.match(
    lines.join("\n"),
    /Delete a worker, its versions, secrets, workflow definitions, routes, and queue consumers\./
  );
});

test("delete command rejects unexpected positional arguments", async () => {
  const deps = {
    env: { ADMIN_TOKEN: "tok" },
    controlFetch: async () => {
      throw new Error("controlFetch should not be called");
    },
  };
  await assert.rejects(
    () => runDeleteCommand(["version", "--ns", "demo", "api", "v1", "extra"], deps),
    /delete version received unexpected argument: extra/
  );
  await assert.rejects(
    () => runDeleteCommand(["worker", "--ns", "demo", "--worker", "api", "extra"], deps),
    /delete worker received unexpected argument: extra/
  );
});
