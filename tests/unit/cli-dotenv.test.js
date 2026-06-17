import { test } from "node:test";
import assert from "node:assert/strict";
import { quoteValue } from "../../lib/dotenv.js";

// The dotenv primitives are mostly covered indirectly (loadCliDotEnv in
// cli-credentials, token-store round-trips); this is the direct quoteValue test.
test("quoteValue escapes backslash before other sequences", () => {
  assert.equal(quoteValue("a\\b"), '"a\\\\b"');
  assert.equal(quoteValue('q"q'), '"q\\"q"');
});
