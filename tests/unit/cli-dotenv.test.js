import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteValue } from "../../lib/dotenv.js";

// The dotenv dialect primitives are mostly exercised through loadCliDotEnv
// (cli-credentials) and the token-store round-trips (cli-token-store); this is
// the one direct unit test of the quoting helper.
test("quoteValue escapes backslash before other sequences", () => {
  assert.equal(quoteValue("a\\b"), '"a\\\\b"');
  assert.equal(quoteValue('q"q'), '"q\\"q"');
});
