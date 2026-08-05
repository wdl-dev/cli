import { test } from "node:test";
import assert from "node:assert/strict";
import { formatDiagnosticValue, maskToken, writeJsonOr, writeStatusLine } from "../../lib/output.js";

test("writeStatusLine escapes terminal control bytes in the assembled line", () => {
  /** @type {string[]} */
  const lines = [];
  writeStatusLine((/** @type {string} */ l) => lines.push(l), `ok ${String.fromCharCode(27)}[2J done`);
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], new RegExp(String.fromCharCode(27)), "raw ESC must not pass through");
});

test("formatDiagnosticValue renders values JSON.stringify would misrepresent", () => {
  assert.equal(formatDiagnosticValue(Number.NaN), "NaN");
  assert.equal(formatDiagnosticValue(Number.POSITIVE_INFINITY), "Infinity");
  assert.equal(formatDiagnosticValue(Number.NEGATIVE_INFINITY), "-Infinity");
  assert.equal(formatDiagnosticValue(0), "0");
  assert.equal(formatDiagnosticValue("restart"), '"restart"');
  assert.equal(formatDiagnosticValue(null), "null");
  assert.equal(formatDiagnosticValue(new Date(0)), "datetime 1970-01-01T00:00:00.000Z");
  assert.doesNotMatch(
    formatDiagnosticValue(`bad${String.fromCharCode(27)}[2J`),
    new RegExp(String.fromCharCode(27)),
    "raw ESC must not pass through"
  );
});

test("writeJsonOr emits JSON and reports handled, or defers to the human path", () => {
  /** @type {string[]} */
  const out = [];
  assert.equal(
    writeJsonOr(true, { a: 1 }, (/** @type {string} */ l) => out.push(l)),
    true
  );
  assert.equal(out[0], JSON.stringify({ a: 1 }, null, 2));
  out.length = 0;
  assert.equal(
    writeJsonOr(false, { a: 1 }, (/** @type {string} */ l) => out.push(l)),
    false
  );
  assert.equal(out.length, 0, "nothing written when not json");
});

test("maskToken never reveals most of a short token", () => {
  assert.equal(maskToken("abcd"), "****");
  assert.equal(maskToken("ab"), "****");
  // A 4-char suffix of a 5-8 char token would reveal half or more of it.
  assert.equal(maskToken("abcde"), "****");
  assert.equal(maskToken("abcdefgh"), "****");
  assert.equal(maskToken("abcdefghi"), "****fghi");
});
