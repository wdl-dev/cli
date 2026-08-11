import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseAiBindingFromCfg,
  parseD1DatabasesFromCfg,
  parseDurableObjectsFromCfg,
  parseExportsFromCfg,
  parseKvNamespacesFromCfg,
  parsePlatformBindingsFromCfg,
  parseQueues,
  parseR2BucketsFromCfg,
  parseServicesFromCfg,
  parseTriggers,
  parseWorkflowsFromCfg,
} from "../../lib/wrangler/bindings.js";
import { ESC, assertThrowsNoRawTerminalControls } from "./helpers.js";

test("parseAiBindingFromCfg accepts the singleton binding and rejects unsupported fields", () => {
  assert.equal(parseAiBindingFromCfg({}), null);
  assert.deepEqual(parseAiBindingFromCfg({ ai: { binding: "AI" } }), { binding: "AI" });
  assert.deepEqual(parseAiBindingFromCfg({ ai: { binding: " AI " } }), { binding: "AI" });
  assert.throws(() => parseAiBindingFromCfg({ ai: [] }), /\[ai\] must be a table/);
  assert.throws(() => parseAiBindingFromCfg({ ai: {} }), /\[ai\]\.binding is required/);
  assert.throws(() => parseAiBindingFromCfg({ ai: { binding: "AI", remote: true } }), /unsupported field.*remote/);
  assert.throws(() => parseAiBindingFromCfg({ ai: { binding: "__WDL_AI__" } }), /runtime-internal/);
  assert.throws(() => parseAiBindingFromCfg({ ai: { binding: " __WDL_AI__ " } }), /runtime-internal/);
});

test("parseTriggers: missing/empty yields []", () => {
  assert.deepEqual(parseTriggers(undefined), []);
  assert.deepEqual(parseTriggers(null), []);
  assert.deepEqual(parseTriggers({}), []);
  assert.deepEqual(parseTriggers({ crons: [] }), []);
});

test("parseTriggers: [triggers] crons defaults timezone to UTC", () => {
  assert.deepEqual(parseTriggers({ crons: ["*/5 * * * *", "0 0 * * *"] }), [
    { cron: "*/5 * * * *", timezone: "UTC" },
    { cron: "0 0 * * *", timezone: "UTC" },
  ]);
});

test("parseTriggers: [[triggers.schedules]] preserves timezone", () => {
  assert.deepEqual(
    parseTriggers({
      schedules: [{ cron: "0 9 * * 1-5", timezone: "Asia/Shanghai" }, { cron: "0 0 * * *" }],
    }),
    [
      { cron: "0 9 * * 1-5", timezone: "Asia/Shanghai" },
      { cron: "0 0 * * *", timezone: "UTC" },
    ]
  );
});

test("parseTriggers: merges both forms in order (crons first, then schedules)", () => {
  assert.deepEqual(
    parseTriggers({
      crons: ["*/5 * * * *"],
      schedules: [{ cron: "0 9 * * *", timezone: "Asia/Shanghai" }],
    }),
    [
      { cron: "*/5 * * * *", timezone: "UTC" },
      { cron: "0 9 * * *", timezone: "Asia/Shanghai" },
    ]
  );
});

test("parseTriggers: rejects non-string cron entry", () => {
  assert.throws(() => parseTriggers({ crons: [42] }), /non-empty strings/);
  assert.throws(() => parseTriggers({ schedules: [{}] }), /cron is required/);
});

test("parseTriggers: rejects wrong shape", () => {
  assert.throws(() => parseTriggers([]), /must be a table/);
  assert.throws(() => parseTriggers({ crons: "*/5 * * * *" }), /must be an array/);
  assert.throws(() => parseTriggers({ schedules: {} }), /must be an array of tables/);
});

test("parseTriggers: rejects unsupported Wrangler event triggers and unknown fields", () => {
  assert.throws(
    () => parseTriggers({ events: [] }),
    /\[triggers\] contains unsupported field\(s\): events; WDL supports only crons and schedules/
  );
  assert.throws(() => parseTriggers({ crons: [], eventz: [] }), /\[triggers\] contains unsupported field\(s\): eventz/);
});

test("parseQueues: missing/empty yields empty producers and consumers", () => {
  assert.deepEqual(parseQueues(undefined), { producers: [], consumers: [] });
  assert.deepEqual(parseQueues(null), { producers: [], consumers: [] });
  assert.deepEqual(parseQueues({}), { producers: [], consumers: [] });
});

test("parseQueues: producers normalize delivery_delay", () => {
  assert.deepEqual(parseQueues({ producers: [{ binding: "MY_Q", queue: "orders", delivery_delay: 60 }] }), {
    producers: [{ binding: "MY_Q", queue: "orders", deliveryDelaySeconds: 60 }],
    consumers: [],
  });
});

test("parseQueues: consumers normalize max_batch_timeout and retry_delay", () => {
  const out = parseQueues({
    consumers: [
      {
        queue: "orders",
        max_batch_size: 10,
        max_batch_timeout: 5,
        max_retries: 3,
        retry_delay: 30,
        dead_letter_queue: "orders-dlq",
      },
    ],
  });
  assert.deepEqual(out.consumers, [
    {
      queue: "orders",
      maxBatchSize: 10,
      maxBatchTimeoutMs: 5000,
      maxRetries: 3,
      retryDelaySeconds: 30,
      deadLetterQueue: "orders-dlq",
    },
  ]);
});

test("parseQueues: forwards platform-range batch timeouts for control-side validation", () => {
  assert.deepEqual(parseQueues({ consumers: [{ queue: "orders", max_batch_timeout: 61 }] }).consumers, [
    { queue: "orders", maxBatchTimeoutMs: 61_000 },
  ]);
});

test("parseQueues: omits optional consumer fields when absent", () => {
  assert.deepEqual(parseQueues({ consumers: [{ queue: "orders" }] }), {
    producers: [],
    consumers: [{ queue: "orders" }],
  });
});

test("parseQueues: validates delay fields and rejects unsupported concurrency loudly", () => {
  assert.throws(
    () => parseQueues({ producers: [{ binding: "Q", queue: "q", delivery_delay: 86_401 }] }),
    /delivery_delay/
  );
  assert.throws(
    () => parseQueues({ producers: [{ binding: "Q", queue: "q", delivery_delay: "30" }] }),
    /delivery_delay/
  );
  assert.throws(() => parseQueues({ consumers: [{ queue: "q", retry_delay: -1 }] }), /retry_delay/);
  assert.throws(() => parseQueues({ consumers: [{ queue: "q", retry_delay: true }] }), /retry_delay/);
  assert.throws(() => parseQueues({ consumers: [{ queue: "q", max_batch_timeout: "5" }] }), /max_batch_timeout/);
  assert.throws(() => parseQueues({ consumers: [{ queue: "q", max_batch_timeout: true }] }), /max_batch_timeout/);
  assert.throws(
    () => parseQueues({ consumers: [{ queue: "q", max_concurrency: 4 }] }),
    /max_concurrency not supported/
  );
});

test("parseQueues: rejects missing required fields", () => {
  assert.throws(() => parseQueues({ producers: [{ queue: "q" }] }), /binding is required/);
  assert.throws(() => parseQueues({ producers: [{ binding: "B" }] }), /queue is required/);
  assert.throws(() => parseQueues({ consumers: [{}] }), /queue is required/);
});

test("parseQueues: rejects wrong shape", () => {
  assert.throws(() => parseQueues([]), /must be a table/);
  assert.throws(() => parseQueues({ producers: {} }), /must be an array/);
  assert.throws(() => parseQueues({ consumers: "no" }), /must be an array/);
});

test("parseQueues: rejects runtime-internal producer binding names", () => {
  assert.throws(
    () => parseQueues({ producers: [{ binding: "__WDL_RESERVED__", queue: "q" }] }),
    /runtime-internal bindings/
  );
});

test("parseD1DatabasesFromCfg: absent yields empty and database_id wins", () => {
  assert.deepEqual(parseD1DatabasesFromCfg({}), []);
  assert.deepEqual(
    parseD1DatabasesFromCfg({
      d1_databases: [
        { binding: "DB", database_name: "main", database_id: "cf-id" },
        { binding: "REPORTS", database_id: "compat-main" },
      ],
    }),
    [
      { binding: "DB", databaseId: "cf-id" },
      { binding: "REPORTS", databaseId: "compat-main" },
    ]
  );
});

test("parseD1DatabasesFromCfg: rejects wrong shape and missing fields", () => {
  assert.throws(() => parseD1DatabasesFromCfg({ d1_databases: {} }), /must be an array/);
  assert.throws(() => parseD1DatabasesFromCfg({ d1_databases: [null] }), /entry must be a table/);
  assert.throws(() => parseD1DatabasesFromCfg({ d1_databases: [{ database_name: "main" }] }), /binding is required/);
  assert.throws(
    () => parseD1DatabasesFromCfg({ d1_databases: [{ binding: "DB" }] }),
    /database_name or database_id is required/
  );
  assert.throws(
    () =>
      parseD1DatabasesFromCfg({
        d1_databases: [{ binding: "DB", database_name: "main", databsae_id: "oops" }],
      }),
    /unknown field\(s\): databsae_id/
  );
});

test("parseD1DatabasesFromCfg: accepts recognized wrangler-only fields without using them for deploy binding resolution", () => {
  assert.deepEqual(
    parseD1DatabasesFromCfg({
      d1_databases: [
        {
          binding: "DB",
          database_name: "main",
          preview_database_id: "preview-main",
          migrations_dir: "schema",
          migrations_table: "_migrations",
        },
      ],
    }),
    [{ binding: "DB", databaseId: "main" }]
  );
});

test("parseR2BucketsFromCfg: parses wrangler R2 bucket bindings", () => {
  assert.deepEqual(parseR2BucketsFromCfg({}), []);
  assert.deepEqual(
    parseR2BucketsFromCfg({
      r2_buckets: [{ binding: "BUCKET", bucket_name: "uploads" }],
    }),
    [{ binding: "BUCKET", bucketName: "uploads" }]
  );
  assert.throws(() => parseR2BucketsFromCfg({ r2_buckets: {} }), /must be an array/);
  assert.throws(() => parseR2BucketsFromCfg({ r2_buckets: [null] }), /entry must be a table/);
  assert.throws(() => parseR2BucketsFromCfg({ r2_buckets: [{ bucket_name: "uploads" }] }), /binding is required/);
  assert.throws(() => parseR2BucketsFromCfg({ r2_buckets: [{ binding: "BUCKET" }] }), /bucket_name is required/);
  assert.throws(
    () => parseR2BucketsFromCfg({ r2_buckets: [{ binding: "BUCKET", bucket_name: "Bad_Name" }] }),
    /bucket_name must match/
  );
  assert.throws(
    () =>
      parseR2BucketsFromCfg({
        r2_buckets: [{ binding: "BUCKET", bucket_name: "uploads", preview_bucket_name: "preview" }],
      }),
    /preview_bucket_name is not supported/
  );
  assert.throws(
    () =>
      parseR2BucketsFromCfg({
        r2_buckets: [{ binding: "BUCKET", bucket_name: "uploads", jurisdiction: "eu" }],
      }),
    /jurisdiction is not supported/
  );
  assert.throws(
    () =>
      parseR2BucketsFromCfg({
        r2_buckets: [{ binding: "BUCKET", bucket_name: "uploads", local_dev: {} }],
      }),
    /unknown field\(s\): local_dev/
  );
});

test("parse resource bindings reject runtime-internal WDL names", () => {
  assert.throws(
    () =>
      parseD1DatabasesFromCfg({
        d1_databases: [{ binding: "__WDL_RESERVED__", database_name: "main" }],
      }),
    /runtime-internal bindings/
  );
  assert.throws(
    () =>
      parseR2BucketsFromCfg({
        r2_buckets: [{ binding: "__WDL_RESERVED__", bucket_name: "uploads" }],
      }),
    /runtime-internal bindings/
  );
  assert.throws(
    () =>
      parseServicesFromCfg({
        services: [{ binding: "__WDL_RESERVED__", service: "target" }],
      }),
    /runtime-internal bindings/
  );
});

test("parseDurableObjectsFromCfg: parses local DO bindings with new_classes or new_sqlite_classes migrations", () => {
  assert.deepEqual(parseDurableObjectsFromCfg({}), []);
  assert.deepEqual(
    parseDurableObjectsFromCfg({
      durable_objects: {
        bindings: [{ name: "ROOMS", class_name: "Room" }],
      },
      migrations: [{ tag: "v1", new_classes: ["Room"] }],
    }),
    [{ binding: "ROOMS", className: "Room" }]
  );
  assert.deepEqual(
    parseDurableObjectsFromCfg({
      durable_objects: {
        bindings: [{ name: "ROOMS", class_name: "Room" }],
      },
      migrations: [{ tag: "v1", new_sqlite_classes: ["Room"] }],
    }),
    [{ binding: "ROOMS", className: "Room" }]
  );
  assert.throws(() => parseDurableObjectsFromCfg({ durable_objects: [] }), /must be a table/);
  assert.throws(() => parseDurableObjectsFromCfg({ durable_objects: { bindings: {} } }), /must be an array/);
  assert.throws(
    () =>
      parseDurableObjectsFromCfg({
        durable_objects: { bindings: [{ class_name: "Room", script_name: "other" }] },
        migrations: [{ tag: "v1", new_classes: ["Room"] }],
      }),
    /\[\[durable_objects\.bindings\]\]\.name is required/
  );
  assert.throws(
    () =>
      parseDurableObjectsFromCfg({
        durable_objects: {
          bindings: [{ name: "ROOMS", class_name: "Room", script_name: "other" }],
        },
        migrations: [{ tag: "v1", new_classes: ["Room"] }],
      }),
    /script_name is not supported/
  );
  assert.throws(
    () =>
      parseDurableObjectsFromCfg({
        durable_objects: { bindings: [{ name: "ROOMS", class_name: "Room" }] },
        migrations: [{ tag: "v1", new_classes: ["Other"] }],
      }),
    /must be listed in \[\[migrations\]\]\.new_classes or \[\[migrations\]\]\.new_sqlite_classes/
  );
  assert.throws(
    () =>
      parseDurableObjectsFromCfg({
        durable_objects: { bindings: [{ name: "ROOMS", class_name: "Room" }] },
        migrations: [{ tag: "v1", new_sqlite_classes: [42] }],
      }),
    /new_sqlite_classes entries must be valid JS class declaration names/
  );
  assert.throws(
    () =>
      parseDurableObjectsFromCfg({
        durable_objects: { bindings: [{ name: "ROOMS", class_name: "class" }] },
        migrations: [{ tag: "v1", new_classes: ["class"] }],
      }),
    /new_classes entries must be valid JS class declaration names/
  );
  assert.throws(
    () =>
      parseDurableObjectsFromCfg({
        durable_objects: { bindings: [{ name: "ROOMS", class_name: "Room" }] },
        migrations: [{ tag: "v2", renamed_classes: [{ from: "Old", to: "Room" }] }],
      }),
    /renamed_classes is not supported/
  );
});

test("parseDurableObjectsFromCfg: rejects runtime-internal binding names", () => {
  assert.throws(
    () =>
      parseDurableObjectsFromCfg({
        durable_objects: {
          bindings: [{ name: "__WDL_RESERVED__", class_name: "Room" }],
        },
        migrations: [{ tag: "v1", new_classes: ["Room"] }],
      }),
    /runtime-internal bindings/
  );
});

test("parseKvNamespacesFromCfg: validates shape and non-empty string binding/id", () => {
  assert.deepEqual(parseKvNamespacesFromCfg({}), []);
  assert.deepEqual(parseKvNamespacesFromCfg({ kv_namespaces: [] }), []);
  assert.deepEqual(parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "KV", id: "abc" }] }), [
    { binding: "KV", id: "abc" },
  ]);
  assert.deepEqual(
    // KV ids are control-plane resource ids, not runtime binding names; keep
    // the long-standing whitespace trim explicit and intentional.
    parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "KV", id: "abc " }] }),
    [{ binding: "KV", id: "abc" }]
  );
  assert.throws(() => parseKvNamespacesFromCfg({ kv_namespaces: {} }), /must be an array/);
  assert.throws(() => parseKvNamespacesFromCfg({ kv_namespaces: [null] }), /entry must be a table/);
  assert.throws(() => parseKvNamespacesFromCfg({ kv_namespaces: [{ id: "x" }] }), /needs a non-empty string 'binding'/);
  assert.throws(
    () => parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "", id: "x" }] }),
    /needs a non-empty string 'binding'/
  );
  assert.throws(
    () => parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: ["KV"], id: "x" }] }),
    /needs a non-empty string 'binding'/
  );
  assert.throws(
    () => parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "KV" }] }),
    /'id' must be a non-empty string/
  );
  assert.throws(
    () => parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "KV", id: 123 }] }),
    /'id' must be a non-empty string/
  );
  // binding name grammar still enforced
  assert.throws(
    () => parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "bad-kv", id: "x" }] }),
    /binding must match/
  );
  // unknown keys (typos) are rejected, like the d1/r2 parsers
  assert.throws(
    () => parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "KV", id: "x", bindng: "typo" }] }),
    /unknown field\(s\): bindng/
  );
  // Wrangler's local-dev keys (preview_id, remote) are allowed but ignored
  assert.deepEqual(parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "KV", id: "x", preview_id: "p" }] }), [
    { binding: "KV", id: "x" },
  ]);
  assert.deepEqual(parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "KV", id: "x", remote: true }] }), [
    { binding: "KV", id: "x" },
  ]);
});

test("parseServicesFromCfg: parses wrangler [[services]] entries", () => {
  assert.deepEqual(parseServicesFromCfg({}), []);
  assert.deepEqual(parseServicesFromCfg({ services: [] }), []);
  assert.deepEqual(
    parseServicesFromCfg({
      services: [
        { binding: "AUTH", service: "auth-svc" },
        { binding: "BILLING", service: "billing-svc", entrypoint: "Api", ns: "shared" },
      ],
    }),
    [
      { binding: "AUTH", service: "auth-svc" },
      { binding: "BILLING", service: "billing-svc", entrypoint: "Api", ns: "shared" },
    ]
  );
  assert.throws(() => parseServicesFromCfg({ services: {} }), /must be an array/);
  assert.throws(() => parseServicesFromCfg({ services: [null] }), /entry must be a table/);
  assert.throws(() => parseServicesFromCfg({ services: [{ service: "x" }] }), /needs both 'binding' and 'service'/);
  assert.throws(() => parseServicesFromCfg({ services: [{ binding: "X" }] }), /needs both 'binding' and 'service'/);
  // A present-but-empty value gets the specific non-empty-string error, not "needs both".
  assert.throws(
    () => parseServicesFromCfg({ services: [{ binding: "", service: "y" }] }),
    /binding must be a non-empty string/
  );
  assert.throws(
    () => parseServicesFromCfg({ services: [{ binding: "X", service: "" }] }),
    /service must be a non-empty string/
  );
  // A non-string truthy `service` must be rejected, not passed into the manifest.
  assert.throws(
    () => parseServicesFromCfg({ services: [{ binding: "X", service: 123 }] }),
    /service must be a non-empty string/
  );
  // A non-string `binding` (truthy array) must not be String()-coerced past the
  // binding-name regex.
  assert.throws(
    () => parseServicesFromCfg({ services: [{ binding: ["AB"], service: "y" }] }),
    /binding must be a non-empty string/
  );
  assert.throws(
    () => parseServicesFromCfg({ services: [{ binding: "X", service: "y", entrypoint: "1bad" }] }),
    /entrypoint must be a JS identifier/
  );
  assert.throws(
    () => parseServicesFromCfg({ services: [{ binding: "X", service: "y", ns: "BAD NS" }] }),
    /ns must match/
  );
  assert.deepEqual(parseServicesFromCfg({ services: [{ binding: "SYS", service: "dash", ns: "__reserved__" }] }), [
    { binding: "SYS", service: "dash", ns: "__reserved__" },
  ]);
  assert.throws(
    () => parseServicesFromCfg({ services: [{ binding: "X", service: "y", ns: "admin" }] }),
    /ns must match/
  );
});

test("parseServicesFromCfg: rejects runtime-reserved entrypoint names (__Wdl…__)", () => {
  // CLI fail-fast — the user sees the error before deploy fans out to a
  // round-trip with control. Server-side `validateBindings` +
  // `linkServiceBinding` are the real trust boundary; this is the
  // ergonomic mirror.
  for (const reserved of ["__WdlReserved__", "__WdlSomething__", "__Wdl__"]) {
    assert.throws(
      () =>
        parseServicesFromCfg({
          services: [{ binding: "X", service: "t", entrypoint: reserved }],
        }),
      /reserved for runtime-injected/,
      `expected reserved-entrypoint rejection for ${JSON.stringify(reserved)}`
    );
  }
  // `__WdlNotReserved` lacks the trailing `__`, so it's user-controllable.
  // Defensive sanity that the regex is anchored on both ends.
  assert.doesNotThrow(() =>
    parseServicesFromCfg({
      services: [{ binding: "X", service: "t", entrypoint: "__WdlNotReserved" }],
    })
  );
});

test("wrangler binding parser diagnostics escape terminal controls", () => {
  const bad = `bad${ESC}[2J\nFORGED\rBAD`;
  const badConfigRel = `wrangler${ESC}[2J\nFORGED\rBAD.json`;
  assertThrowsNoRawTerminalControls(
    () => parseQueues({ consumers: [{ queue: "jobs", max_concurrency: 4 }] }, badConfigRel),
    /wrangler\\u001b\[2J\\nFORGED\\rBAD\.json/,
    "config path diagnostics"
  );
  assertThrowsNoRawTerminalControls(
    () => parseQueues({ consumers: [{ queue: bad, max_concurrency: 4 }] }),
    /max_concurrency not supported/,
    "queue diagnostics"
  );
  assertThrowsNoRawTerminalControls(
    () => parseKvNamespacesFromCfg({ kv_namespaces: [{ binding: "KV", id: "x", [bad]: true }] }),
    /unknown field\(s\): bad\\u001b\[2J\\nFORGED\\rBAD/,
    "KV diagnostics"
  );
  assertThrowsNoRawTerminalControls(
    () => parseServicesFromCfg({ services: [{ binding: bad, service: 123 }] }),
    /service must be a non-empty string/,
    "service diagnostics"
  );
  assertThrowsNoRawTerminalControls(
    () =>
      parseDurableObjectsFromCfg({
        durable_objects: { bindings: [{ name: bad, class_name: "Room", script_name: "other" }] },
        migrations: [{ tag: "v1", new_classes: ["Room"] }],
      }),
    /script_name is not supported/,
    "Durable Object diagnostics"
  );
  assertThrowsNoRawTerminalControls(
    () =>
      parseWorkflowsFromCfg({
        workflows: [{ name: bad, binding: "WF", class_name: "Flow", script_name: "other" }],
      }),
    /name must match/,
    "workflow diagnostics"
  );
  assertThrowsNoRawTerminalControls(
    () => parseExportsFromCfg({ exports: [{ entrypoint: "Public", allowed_callers: [bad] }] }),
    /allowed_callers entries must be/,
    "export diagnostics"
  );
  assertThrowsNoRawTerminalControls(
    () => parsePlatformBindingsFromCfg({ platform_bindings: [{ binding: "PAYMENT", platform: bad }] }),
    /platform must match/,
    "platform binding diagnostics"
  );
});

test("parseWorkflowsFromCfg: parses local workflow declarations", () => {
  assert.deepEqual(parseWorkflowsFromCfg({}), []);
  assert.deepEqual(
    parseWorkflowsFromCfg({
      workflows: [
        { name: "order-workflow", binding: "ORDER_WORKFLOW", class_name: "OrderWorkflow" },
        { name: "My_Workflow2", binding: "WF2", class_name: "MyWorkflow" },
      ],
    }),
    [
      { name: "order-workflow", binding: "ORDER_WORKFLOW", className: "OrderWorkflow" },
      { name: "My_Workflow2", binding: "WF2", className: "MyWorkflow" },
    ]
  );
});

test("parseWorkflowsFromCfg: rejects invalid names and unsupported script_name", () => {
  assert.throws(() => parseWorkflowsFromCfg({ workflows: {} }), /must be an array/);
  assert.throws(
    () =>
      parseWorkflowsFromCfg({
        workflows: [{ binding: "WF", class_name: "Flow", script_name: "other" }],
      }),
    /name must match/
  );
  assert.throws(
    () =>
      parseWorkflowsFromCfg({
        workflows: [{ name: "bad:name", binding: "WF", class_name: "Flow" }],
      }),
    /name must match/
  );
  assert.throws(
    () =>
      parseWorkflowsFromCfg({
        workflows: [{ name: "constructor", binding: "WF", class_name: "Flow" }],
      }),
    /reserved Object\.prototype key/
  );
  assert.throws(
    () =>
      parseWorkflowsFromCfg({
        workflows: [{ name: "flow", binding: "bad-binding", class_name: "Flow" }],
      }),
    /binding must match/
  );
  assert.throws(
    () =>
      parseWorkflowsFromCfg({
        workflows: [{ name: "flow", binding: "__WDL_WORKFLOWS_BACKEND__", class_name: "Flow" }],
      }),
    /runtime-internal bindings/
  );
  assert.throws(
    () =>
      parseWorkflowsFromCfg({
        workflows: [{ name: "flow", binding: "WF", class_name: "not-valid" }],
      }),
    /class_name must be a valid JS class declaration name/
  );
  assert.throws(
    () => parseWorkflowsFromCfg({ workflows: [{ name: "flow", binding: "WF", class_name: "class" }] }),
    /class_name must be a valid JS class declaration name/
  );
  assert.throws(
    () =>
      parseWorkflowsFromCfg({
        workflows: [{ name: "flow", binding: "WF", class_name: "__WdlReserved__" }],
      }),
    /reserved for runtime-injected entrypoints/
  );
  assert.throws(
    () =>
      parseWorkflowsFromCfg({
        workflows: [{ name: "flow", binding: "WF", class_name: "Flow", script_name: "other" }],
      }),
    /script_name is not supported/
  );
});

test("parseExportsFromCfg: absent → empty; snake→camel translation", () => {
  assert.deepEqual(parseExportsFromCfg({}), []);
  const out = parseExportsFromCfg({
    exports: [
      {
        entrypoint: "Echo",
        as: "DEMO",
        allowed_callers: ["*"],
        required_caller_secrets: ["KEY_A"],
      },
    ],
  });
  assert.deepEqual(out, [
    {
      entrypoint: "Echo",
      allowedCallers: ["*"],
      as: "DEMO",
      requiredCallerSecrets: ["KEY_A"],
    },
  ]);
});

test("parseExportsFromCfg: missing allowed_callers rejected", () => {
  assert.throws(
    () => parseExportsFromCfg({ exports: [{ entrypoint: "Public" }] }),
    /allowed_callers must be an array of strings/
  );
});

test("parseExportsFromCfg: rejects Wrangler declarative exports objects", () => {
  assert.throws(
    () => parseExportsFromCfg({ exports: { Room: { type: "durable-object", storage: "sqlite" } } }),
    /Wrangler declarative exports objects are not supported/
  );
});

test("parseExportsFromCfg: generated wrapper entrypoint names reject reserved words", () => {
  assert.throws(
    () => parseExportsFromCfg({ exports: [{ entrypoint: "class", allowed_callers: ["*"] }] }),
    /valid JS class declaration name or "default"/
  );
  assert.throws(
    () => parseExportsFromCfg({ exports: [{ entrypoint: "__WdlReserved__", allowed_callers: ["*"] }] }),
    /reserved for runtime-injected entrypoints/
  );
});

test("parseExportsFromCfg: allowed_callers stays tenant-facing", () => {
  assert.throws(
    () =>
      parseExportsFromCfg({
        exports: [{ entrypoint: "Public", allowed_callers: ["__reserved__"] }],
      }),
    /allowed_callers entries must be "\*" or match/
  );
});

test("parseExportsFromCfg: bad `as` grammar rejected", () => {
  assert.throws(
    () =>
      parseExportsFromCfg({
        exports: [{ entrypoint: "Echo", as: "lower-kebab", allowed_callers: ["*"] }],
      }),
    /as must match/
  );
});

test("parseExportsFromCfg: required_caller_secrets must be upper-snake", () => {
  assert.throws(
    () =>
      parseExportsFromCfg({
        exports: [
          {
            entrypoint: "Echo",
            as: "DEMO",
            allowed_callers: ["*"],
            required_caller_secrets: ["lowercase"],
          },
        ],
      }),
    /required_caller_secrets entries must match/
  );
});

test("parsePlatformBindingsFromCfg: absent → empty; default platform=binding", () => {
  assert.deepEqual(parsePlatformBindingsFromCfg({}), []);
  const out = parsePlatformBindingsFromCfg({
    platform_bindings: [{ binding: "DEMO" }, { binding: "PAYMENT", platform: "STRIPE" }],
  });
  assert.deepEqual(out, [
    { binding: "DEMO", platform: "DEMO" },
    { binding: "PAYMENT", platform: "STRIPE" },
  ]);
});

test("parsePlatformBindingsFromCfg: rejects non-upper-snake binding", () => {
  assert.throws(
    () => parsePlatformBindingsFromCfg({ platform_bindings: [{ binding: "lowercase" }] }),
    /binding must match/
  );
});

test("parsePlatformBindingsFromCfg: rejects runtime-internal binding names", () => {
  assert.throws(
    () => parsePlatformBindingsFromCfg({ platform_bindings: [{ binding: "__WDL_RESERVED__" }] }),
    /runtime-internal bindings/
  );
});
