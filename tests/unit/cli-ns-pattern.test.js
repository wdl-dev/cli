import { test } from "node:test";
import assert from "node:assert/strict";
import {
  BINDING_NAME_RE,
  JS_IDENTIFIER_RE,
  NS_PATTERN,
  RESERVED_OBJECT_KEYS,
  RESERVED_TENANT_NS,
  WORKFLOW_INSTANCE_ID_RE,
  WORKFLOW_NAME_RE,
  WDL_RESERVED_BINDING_RE,
  WDL_RESERVED_ENTRYPOINT_RE,
  isValidJsClassDeclarationName,
  isValidJsIdentifier,
  isAdminAcceptableNs,
  isReservedNs,
} from "../../lib/ns-pattern.js";

test("cli namespace pattern accepts tenant namespace grammar", () => {
  const re = new RegExp(`^${NS_PATTERN}$`);
  for (const ok of ["demo", "ns-1", "a", "0123456789", "a-b-c", "a".repeat(63)]) {
    assert.ok(re.test(ok), `expected "${ok}" to match`);
  }
  for (const bad of ["", "UPPER", "with.dot", "ns_underscore", "ns space", "a/b", "-bad", "bad-", "a".repeat(64)]) {
    assert.ok(!re.test(bad), `expected "${bad}" to fail`);
  }
});

test("cli reserved namespace helper is shape-only", () => {
  assert.deepEqual(RESERVED_TENANT_NS, new Set(["admin"]));
  for (const ok of ["__reserved__", "__operator-1__", "__OPERATOR_1__"]) {
    assert.equal(isReservedNs(ok), true, `expected ${JSON.stringify(ok)} accepted`);
  }
  for (const bad of ["__future", "__reserved__:worker", "__reserved__/worker", "demo", "", undefined]) {
    assert.equal(isReservedNs(bad), false, `expected ${JSON.stringify(bad)} rejected`);
  }
});

test("cli WDL_RESERVED_ENTRYPOINT_RE matches platform-reserved entrypoint policy", () => {
  assert.equal(WDL_RESERVED_ENTRYPOINT_RE.source, "^__Wdl[A-Za-z0-9_]*__$");
  assert.equal(WDL_RESERVED_ENTRYPOINT_RE.flags, "");
  assert.ok(WDL_RESERVED_ENTRYPOINT_RE.test("__WdlPlatformReserved__"));
  assert.ok(WDL_RESERVED_ENTRYPOINT_RE.test("__WdlExample1__"));
  assert.ok(WDL_RESERVED_ENTRYPOINT_RE.test("__Wdl__"));
  assert.ok(!WDL_RESERVED_ENTRYPOINT_RE.test("__WdlPlatformReserved"));
  assert.ok(!WDL_RESERVED_ENTRYPOINT_RE.test("WdlPlatformReserved"));
  assert.ok(!WDL_RESERVED_ENTRYPOINT_RE.test("Foo__WdlPlatformReserved__"));
});

test("cli WDL_RESERVED_BINDING_RE matches platform-reserved binding policy", () => {
  assert.equal(WDL_RESERVED_BINDING_RE.source, "^__WDL_[A-Za-z0-9_]*__$");
  assert.equal(WDL_RESERVED_BINDING_RE.flags, "");
  assert.ok(WDL_RESERVED_BINDING_RE.test("__WDL_PLATFORM_RESERVED__"));
  assert.ok(WDL_RESERVED_BINDING_RE.test("__WDL_INTERNAL_1__"));
  assert.ok(WDL_RESERVED_BINDING_RE.test("__WDL_FUTURE_1__"));
  assert.ok(!WDL_RESERVED_BINDING_RE.test("__WdlPlatformReserved__"));
  assert.ok(!WDL_RESERVED_BINDING_RE.test("WDL_PLATFORM_RESERVED"));
  assert.ok(!WDL_RESERVED_BINDING_RE.test("__WDL_PLATFORM_RESERVED"));
});

test("cli JS_IDENTIFIER_RE matches JavaScript binding identifier policy", () => {
  assert.equal(JS_IDENTIFIER_RE.source, "^[A-Za-z_$][A-Za-z0-9_$]*$");
  for (const ok of ["DB", "MY_QUEUE", "authService", "$service", "_private"]) {
    assert.equal(isValidJsIdentifier(ok), true, `expected ${JSON.stringify(ok)} accepted`);
  }
  for (const bad of ["", "1bad", "kebab-name", "with.dot", "space name", null]) {
    assert.equal(isValidJsIdentifier(bad), false, `expected ${JSON.stringify(bad)} rejected`);
  }
});

test("cli class declaration helper rejects reserved class names", () => {
  for (const ok of ["Room", "Counter1", "_Private", "$Workflow"]) {
    assert.equal(isValidJsClassDeclarationName(ok), true, `expected ${JSON.stringify(ok)} accepted`);
  }
  for (const bad of ["", "1bad", "kebab-name", "class", "default", "await", null]) {
    assert.equal(isValidJsClassDeclarationName(bad), false, `expected ${JSON.stringify(bad)} rejected`);
  }
});

test("cli binding and workflow regexes match tenant-facing limits", () => {
  assert.equal(BINDING_NAME_RE.source, "^[A-Za-z_$][A-Za-z0-9_$]{0,63}$");
  assert.equal(WORKFLOW_NAME_RE.source, "^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$");
  assert.equal(WORKFLOW_INSTANCE_ID_RE.source, "^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$");
  assert.ok(BINDING_NAME_RE.test("MY_BINDING"));
  assert.ok(WORKFLOW_NAME_RE.test("orders-v1"));
  assert.ok(WORKFLOW_INSTANCE_ID_RE.test("order_123"));
  assert.ok(!BINDING_NAME_RE.test("bad-binding"));
  assert.ok(!WORKFLOW_NAME_RE.test("_starts-with-underscore"));
  assert.ok(!WORKFLOW_INSTANCE_ID_RE.test("bad/id"));
});

test("cli RESERVED_OBJECT_KEYS protects prototype-shaped manifest keys", () => {
  assert.deepEqual(
    [...RESERVED_OBJECT_KEYS].toSorted(),
    [
      "__proto__",
      "constructor",
      "hasOwnProperty",
      "isPrototypeOf",
      "propertyIsEnumerable",
      "prototype",
      "toLocaleString",
      "toString",
      "valueOf",
    ].toSorted()
  );
});

test("cli isAdminAcceptableNs accepts tenants plus opaque operator reserved sections", () => {
  for (const ok of ["demo", "ns-1", "a", "0123456789", "a-b-c", "__reserved__"]) {
    assert.ok(isAdminAcceptableNs(ok), `expected "${ok}" accepted`);
  }
  for (const bad of [
    "",
    "UPPER",
    "with.dot",
    "ns_underscore",
    "ns space",
    "a/b",
    "-bad",
    "bad-",
    "a".repeat(64),
    "admin",
    "__future",
    "__reserved__:worker",
    "__reserved__/worker",
    null,
    undefined,
    42,
  ]) {
    assert.ok(!isAdminAcceptableNs(bad), `expected "${bad}" rejected`);
  }
});
