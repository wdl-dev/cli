import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inferType,
  toWireModule,
} from "../../lib/bundle-modules.js";

test("bundle module helpers infer file types", () => {
  assert.equal(inferType("worker.js"), "module");
  assert.equal(inferType("x.mjs"), "module");
  assert.equal(inferType("x.cjs"), "cjs");
  assert.equal(inferType("x.py"), "py");
  assert.equal(inferType("x.json"), "json");
  assert.equal(inferType("x.svg"), "text");
  assert.equal(inferType("x.wasm"), "wasm");
  assert.equal(inferType("x.png"), "data");
  assert.equal(inferType("X.JS"), "module");
});

test("toWireModule encodes supported module types", () => {
  assert.equal(toWireModule(Buffer.from("export default {}"), "module"), "export default {}");
  assert.deepEqual(toWireModule(Buffer.from("module.exports = {}"), "cjs"), { cjs: "module.exports = {}" });
  assert.deepEqual(toWireModule(Buffer.from("hello"), "text"), { text: "hello" });
  assert.deepEqual(toWireModule(Buffer.from("{\"a\":1}"), "json"), { json: { a: 1 } });
  assert.deepEqual(toWireModule(Buffer.from([1, 2]), "wasm"), { wasm_b64: "AQI=" });
  assert.deepEqual(toWireModule(Buffer.from([3, 4]), "data"), { data_b64: "AwQ=" });
  assert.throws(() => toWireModule(Buffer.from("print('hi')"), "py"), /Unknown module type "py"/);
  assert.throws(() => toWireModule(Buffer.from("x"), "ruby"), /Unknown module type "ruby"/);
});
