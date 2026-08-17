import { test } from "node:test";
import assert from "node:assert/strict";
import { runDeleteCommand } from "../../commands/delete.js";
import { runR2Command } from "../../commands/r2.js";
import { runSecretCommand } from "../../commands/secret.js";
import { runWorkersCommand } from "../../commands/workers.js";
import { runWorkflowsCommand } from "../../commands/workflows.js";
import { formatHttpError, formatHttpErrorBody, readJsonOrFail, readJsonOrFailWithHint } from "../../lib/common.js";
import { ESC, assertNoRawTerminalControls, response } from "./helpers.js";

/** @typedef {import("./helpers.js").ControlCall} ControlCall */

/** @param {unknown} err */
function assertEscapedBadArg(err) {
  const message = /** @type {Error} */ (err).message;
  assertNoRawTerminalControls(message, "CLI errors");
  assert.match(message, /bad\\u001b\[2J\\nFORGED\\rBAD/);
  return true;
}

test("formatHttpErrorBody matches raw JSON formatting for parsed bodies", () => {
  const body = {
    error: "deploy_failed",
    message: "bad config",
    blockers: ["version-v1"],
  };
  assert.equal(formatHttpErrorBody(409, body), formatHttpError(409, JSON.stringify(body)));
});

test("readJsonOrFailWithHint formats one error-body read and appends code-specific guidance", async () => {
  let textReads = 0;
  await assert.rejects(
    () =>
      readJsonOrFailWithHint(
        {
          status: 409,
          ok: false,
          text: async () => {
            textReads += 1;
            return '{ "error": "retry", "message": "changed" }';
          },
        },
        "mutate",
        (error) => (error === "retry" ? "; rerun the command" : "")
      ),
    { message: "mutate failed: 409 retry: changed; rerun the command" }
  );
  assert.equal(textReads, 1);
});

test("readJsonOrFail compacts redacted D1 lifecycle errors", async () => {
  const errBody = {
    error: "d1_database_initialize_failed",
    namespace: "demo",
    databaseId: "d1_test",
    message: "Internal error",
    upstreamCode: "backend-unavailable",
    upstreamCategory: "internal",
    upstreamRetryable: true,
    upstreamStatus: 503,
  };

  await assert.rejects(() => readJsonOrFail(response(errBody, 503), "create d1 database"), {
    message:
      "create d1 database failed: 503 d1_database_initialize_failed: Internal error namespace=demo databaseId=d1_test upstreamCode=backend-unavailable upstreamCategory=internal upstreamRetryable=true upstreamStatus=503",
  });
});

test("readJsonOrFail omits nested details from compact control errors", async () => {
  await assert.rejects(
    () =>
      readJsonOrFail(
        response(
          {
            error: "d1_database_initialize_failed",
            message: "Internal error",
            upstreamCode: "backend-unavailable",
            detail: {
              message: "unredacted upstream detail",
              internalReference: "ref-1",
            },
          },
          503
        ),
        "create d1 database"
      ),
    {
      message:
        "create d1 database failed: 503 d1_database_initialize_failed: Internal error upstreamCode=backend-unavailable",
    }
  );
});

test("readJsonOrFail keeps diagnostic blockers in compact errors", async () => {
  const blockers = [
    {
      version: "v2",
      referrers: [
        {
          callerNs: "foo",
          callerWorker: "caller",
          callerVersion: "v1",
          binding: "API",
        },
      ],
    },
  ];

  await assert.rejects(
    () =>
      readJsonOrFail(
        response(
          {
            error: "version_referenced",
            namespace: "foo",
            name: "bar",
            blockers,
          },
          409
        ),
        "delete worker"
      ),
    {
      message: `delete worker failed: 409 version_referenced namespace=foo name=bar blockers=${JSON.stringify(blockers)}`,
    }
  );
});

test("readJsonOrFail formats control error-code plus message convention", async () => {
  await assert.rejects(
    () =>
      readJsonOrFail(
        response(
          {
            error: "invalid_request",
            message: "Body must be { value: string }",
          },
          400
        ),
        "put secret"
      ),
    {
      message: "put secret failed: 400 invalid_request: Body must be { value: string }",
    }
  );
});

test("readJsonOrFail avoids duplicate context when structured error has no summary field", async () => {
  await assert.rejects(() => readJsonOrFail(response({ host: "demo.workers.example", slot: "/" }, 409), "promote"), {
    message: 'promote failed: 409 {"host":"demo.workers.example","slot":"/"}',
  });
});

test("readJsonOrFail quotes context values containing whitespace", async () => {
  await assert.rejects(
    () =>
      readJsonOrFail(
        response(
          {
            error: "bad_trace",
            traceId: "abc def ghi",
          },
          400
        ),
        "deploy"
      ),
    { message: 'deploy failed: 400 bad_trace traceId="abc def ghi"' }
  );
});

test("readJsonOrFail escapes decoded terminal control bytes in structured errors", async () => {
  await assert.rejects(
    () =>
      readJsonOrFail(
        response(
          {
            error: "bad\u001b[31m",
            message: "line1\nline2",
            traceId: "osc\u001b]0;pwn\u0007",
          },
          400
        ),
        "deploy"
      ),
    {
      message: "deploy failed: 400 bad\\u001b[31m: line1\\nline2 traceId=osc\\u001b]0;pwn\\u0007",
    }
  );
});

test("readJsonOrFail preserves non-json response bodies", async () => {
  await assert.rejects(
    () =>
      readJsonOrFail(
        {
          status: 502,
          ok: false,
          text: async () => "bad gateway",
        },
        "deploy"
      ),
    { message: "deploy failed: 502 bad gateway" }
  );
});

test("readJsonOrFail includes redirect locations in HTTP errors", async () => {
  await assert.rejects(
    () =>
      readJsonOrFail(
        {
          status: 302,
          ok: false,
          headers: { location: "https://login.example/\u001b[31m" },
          text: async () => "",
        },
        "whoami"
      ),
    { message: "whoami failed: 302 location=https://login.example/\\u001b[31m" }
  );
});

test("readJsonOrFail wraps invalid JSON from successful responses", async () => {
  await assert.rejects(
    () => readJsonOrFail(response("not-json"), "deploy"),
    /deploy failed: response is not valid JSON/
  );
});

test("nsUrl rejects dot path segments before calling control", async () => {
  await assert.rejects(
    () =>
      runSecretCommand(["list", "--ns", ".", "--scope", "ns", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        controlFetch: async () => {
          throw new Error("controlFetch should not be called");
        },
      }),
    /invalid URL path segment: "\."/
  );
});

test("readJsonOrFail surfaces warnings arrays attached to error bodies", async () => {
  const warnings = [{ code: "assets_cleanup_task_failed", message: "queue full" }];

  await assert.rejects(
    () =>
      readJsonOrFail(
        response(
          {
            error: "asset_upload_failed",
            message: "Asset upload failed for logo.png",
            warnings,
          },
          502
        ),
        "deploy"
      ),
    {
      message: `deploy failed: 502 asset_upload_failed: Asset upload failed for logo.png warnings=${JSON.stringify(warnings)}`,
    }
  );
});

test("commands warn when the admin token would travel over plain http to a non-local host", async () => {
  /** @type {string[]} */
  const warnings = [];
  await runWorkersCommand(["--ns", "demo", "--control-url", "http://ctl.prod.example"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: () => {},
    warn: (/** @type {string} */ line) => warnings.push(line),
    controlFetch: async () => response({ workers: [] }),
  });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /plain http on a non-local host/);

  /** @type {string[]} */
  const quiet = [];
  await runWorkersCommand(["--ns", "demo", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: () => {},
    warn: (/** @type {string} */ line) => quiet.push(line),
    controlFetch: async () => response({ workers: [] }),
  });
  assert.deepEqual(quiet, []);

  /** @type {string[]} */
  const connectWarnings = [];
  await runWorkersCommand(["--ns", "demo", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok", CONTROL_CONNECT_HOST: "control.prod.example" },
    stdout: () => {},
    warn: (/** @type {string} */ line) => connectWarnings.push(line),
    controlFetch: async () => response({ workers: [] }),
  });
  assert.equal(connectWarnings.length, 1);
  assert.match(connectWarnings[0], /CONTROL_CONNECT_HOST=control\.prod\.example is non-local/);
});

test("tenant lifecycle commands default namespace from WDL_NS", async () => {
  /** @type {ControlCall[]} */
  const workerCalls = [];
  await runWorkersCommand(["--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
    stdout: () => {},
    controlFetch: async (
      /** @type {string} */ url,
      /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
    ) => {
      workerCalls.push({ url, init });
      return response({ namespace: "demo", workers: [] });
    },
  });
  assert.equal(workerCalls[0].url, "http://ctl.test/ns/demo/workers");

  /** @type {ControlCall[]} */
  const secretCalls = [];
  await runSecretCommand(["list", "--worker", "api", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
    stdout: () => {},
    controlFetch: async (
      /** @type {string} */ url,
      /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
    ) => {
      secretCalls.push({ url, init });
      return response({ keys: [] });
    },
  });
  assert.equal(secretCalls[0].url, "http://ctl.test/ns/demo/worker/api/secrets");

  /** @type {ControlCall[]} */
  const deleteCalls = [];
  await runDeleteCommand(["version", "api", "v1", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
    stdout: () => {},
    controlFetch: async (
      /** @type {string} */ url,
      /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
    ) => {
      deleteCalls.push({ url, init });
      return response({
        namespace: "demo",
        name: "api",
        version: "v1",
        deleted: true,
      });
    },
  });
  assert.equal(deleteCalls[0].url, "http://ctl.test/ns/demo/worker/api/versions/v1");
});

test("commands escape terminal controls in unexpected positional errors", async () => {
  const bad = `bad${ESC}[2J\nFORGED\rBAD`;
  const deps = {
    env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
    controlFetch: async () => {
      throw new Error("controlFetch should not be called");
    },
  };

  await assert.rejects(
    () => runDeleteCommand(["version", "--ns", "demo", "api", "v1", bad], deps),
    assertEscapedBadArg
  );
  await assert.rejects(() => runR2Command(["buckets", "list", bad, "--ns", "demo"], deps), assertEscapedBadArg);
  await assert.rejects(() => runWorkflowsCommand(["list", "--ns", "demo", bad], deps), assertEscapedBadArg);
});
