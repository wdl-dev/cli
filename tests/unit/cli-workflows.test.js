import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflowsCommand } from "../../commands/workflows.js";
import { formatInstanceList, formatInstanceStatus, formatWorkflowList } from "../../lib/workflows-format.js";
import { ESC, assertNoRawTerminalControls, mockDeps, response } from "./helpers.js";

/** @typedef {import("./helpers.js").ControlCall} ControlCall */

test("workflows commands call encoded control endpoints", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  const deps = {
    env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
    stdout: (/** @type {string} */ line) => lines.push(line),
    controlFetch: async (
      /** @type {string} */ url,
      /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
    ) => {
      calls.push({ url, init });
      if (url.endsWith("/workflows")) {
        return response({
          workflows: [
            {
              worker: "api",
              name: "orders",
              binding: "ORDERS",
              className: "OrderWorkflow",
              activeVersion: "v2",
              workflowKey: "wf_1234",
            },
            {
              worker: "api",
              name: "legacy",
              binding: null,
              className: "LegacyWorkflow",
              activeVersion: "v2",
              workflowKey: "wf_retired",
              retired: true,
            },
          ],
        });
      }
      if (url.includes("/instances?")) {
        return response({ instances: [{ id: "order/1", status: "queued" }], cursor: "1" });
      }
      if (url.includes("/status-instance?")) {
        return response({
          id: "status-instance",
          status: "completed",
          output: { ok: true },
          steps: { entries: [{ ordinal: 0, name: "load", status: "completed" }], truncated: false },
        });
      }
      return response({ id: "order/1", status: "paused" });
    },
  };

  await runWorkflowsCommand(["list", "--ns", "demo space"], deps);
  await runWorkflowsCommand(
    ["instances", "--ns", "demo space", "api", "orders", "--limit", "5", "--cursor", "0"],
    deps
  );
  await runWorkflowsCommand(
    ["status", "--ns", "demo space", "api", "orders", "status-instance", "--include-steps", "--step-limit", "10"],
    deps
  );
  await runWorkflowsCommand(["pause", "--ns", "demo space", "api", "orders", "order/1"], deps);
  await runWorkflowsCommand(["resume", "--ns", "demo space", "api", "orders", "order/1"], deps);
  await runWorkflowsCommand(["restart", "--ns", "demo space", "api", "orders", "order/1", "--yes"], deps);
  await runWorkflowsCommand(["terminate", "--ns", "demo space", "api", "orders", "order/1", "--yes"], deps);

  assert.equal(calls[0].url, "http://ctl.test/ns/demo%20space/workflows");
  assert.equal(calls[1].url, "http://ctl.test/ns/demo%20space/workflows/api/orders/instances?limit=5&cursor=0");
  assert.equal(
    calls[2].url,
    "http://ctl.test/ns/demo%20space/workflows/api/orders/instances/status-instance?includeSteps=true&stepLimit=10"
  );
  assert.equal(calls[3].url, "http://ctl.test/ns/demo%20space/workflows/api/orders/instances/order%2F1/pause");
  assert.equal(calls[3].init.method, "POST");
  assert.equal(calls[4].url, "http://ctl.test/ns/demo%20space/workflows/api/orders/instances/order%2F1/resume");
  assert.equal(calls[4].init.method, "POST");
  assert.equal(calls[5].url, "http://ctl.test/ns/demo%20space/workflows/api/orders/instances/order%2F1/restart");
  assert.equal(calls[5].init.method, "POST");
  assert.equal(calls[6].url, "http://ctl.test/ns/demo%20space/workflows/api/orders/instances/order%2F1/terminate");
  assert.equal(calls[6].init.method, "POST");
  assert.deepEqual(calls[0].init.headers, { "x-admin-token": "tok" });
  assert.ok(lines.includes("api/orders\tbinding=ORDERS\tclass=OrderWorkflow\tactive=v2\tkey=wf_1234\tretired=no"));
  assert.ok(lines.includes("api/legacy\tbinding=-\tclass=LegacyWorkflow\tactive=v2\tkey=wf_retired\tretired=yes"));
  assert.ok(lines.includes("Next cursor: 1"));
  assert.ok(lines.includes("steps=1"));
  assert.equal(lines.at(-1), "OK demo space/api/orders/order/1 terminate status=paused");
});

test("workflow formatters escape control fields but preserve their own layout", () => {
  const hostile = `${ESC}[2J\nFORGED\rBAD\tCOLUMN\u009b`;
  const lines = [
    ...formatWorkflowList({
      workflows: [
        {
          worker: hostile,
          name: hostile,
          binding: hostile,
          className: hostile,
          activeVersion: hostile,
          workflowKey: hostile,
          retired: true,
        },
      ],
    }),
    ...formatInstanceList({
      instances: [{ id: hostile, status: hostile }],
      cursor: hostile,
    }),
    ...formatInstanceStatus({
      id: hostile,
      status: hostile,
      output: { value: hostile },
      error: { message: hostile },
      steps: {
        entries: [{ ordinal: 0, name: hostile, status: hostile }],
      },
    }),
  ];
  const out = lines.join("\n");

  assertNoRawTerminalControls(out, "workflow formatter output");
  assert.ok(out.includes("\\u001b[2J\\nFORGED\\rBAD\\tCOLUMN\\u009b"));
  assert.equal(out.split("\t").length - 1, 7, "only formatter-owned column separators may remain as raw tabs");
});

test("workflow lifecycle status lines escape control fields and preserve JSON", async () => {
  const hostile = `${ESC}[2J\nFORGED\rBAD\tCOLUMN\u009b`;
  const body = { id: `id-${hostile}`, status: `status-${hostile}` };
  const human = mockDeps(body);

  await runWorkflowsCommand(
    ["pause", "api", "orders", "instance", "--ns", "demo", "--control-url", "http://ctl.test"],
    human.deps
  );

  assert.equal(human.lines.length, 1);
  assertNoRawTerminalControls(human.lines[0], "workflow lifecycle status");
  assert.ok(human.lines[0].includes("id-\\u001b[2J\\nFORGED\\rBAD\\tCOLUMN\\u009b"));
  assert.equal(human.lines[0].includes("\t"), false, "status lines must not preserve raw tabs");

  const json = mockDeps(body);
  await runWorkflowsCommand(
    ["pause", "api", "orders", "instance", "--ns", "demo", "--control-url", "http://ctl.test", "--json"],
    json.deps
  );
  assert.deepEqual(JSON.parse(json.lines[0]), body);
});

test("workflows list accepts flags before the subcommand", async () => {
  const { calls, lines, deps } = mockDeps({ workflows: [] });

  await runWorkflowsCommand(["--ns", "demo", "--control-url", "http://ctl.test", "list"], deps);

  assert.equal(calls[0].url, "http://ctl.test/ns/demo/workflows");
  assert.deepEqual(lines, ["(no workflows)"]);
});

test("workflows commands reject unexpected positional arguments", async () => {
  /** @type {boolean[]} */
  const calls = [];
  const deps = {
    env: { CONTROL_URL: "http://ctl.test" },
    controlFetch: async () => {
      calls.push(true);
      return response({});
    },
  };

  await assert.rejects(
    () => runWorkflowsCommand(["list", "--ns", "demo", "extra"], deps),
    /workflows list received unexpected argument: extra/
  );
  await assert.rejects(
    () => runWorkflowsCommand(["instances", "--ns", "demo", "api", "orders", "extra"], deps),
    /workflows instances received unexpected argument: extra/
  );
  await assert.rejects(
    () => runWorkflowsCommand(["status", "--ns", "demo", "api", "orders", "id", "--step-limit", "10"], deps),
    /--step-limit requires --include-steps/
  );
  await assert.rejects(
    () => runWorkflowsCommand(["restart", "--ns", "demo", "api", "orders", "id", "extra", "--yes"], deps),
    /workflows restart received unexpected argument: extra/
  );
  assert.equal(calls.length, 0);
});
