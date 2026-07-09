// Shared fixtures for the CLI unit tests. Not a test file itself (the test
// runner only globs cli-*.test.js).

import assert from "node:assert/strict";

export const ESC = String.fromCharCode(27);

/**
 * A recorded control-plane call: the URL and the init passed to controlFetch.
 * Shared by the tests that assert on what mockDeps recorded.
 * @typedef {{ url: string, init: import("../../lib/control-fetch.js").ControlFetchInit }} ControlCall
 */

// Human output may intentionally contain LF/TAB for layout; hostile fixtures use
// sentinel text after those bytes so the helper still catches forged lines.
/** @param {string} text @param {string} [target] */
export function assertNoRawTerminalControls(text, target = "output") {
  for (const ch of text) {
    if (ch === "\n" || ch === "\t") continue;
    const code = ch.charCodeAt(0);
    if ((code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f)) {
      assert.fail(`raw terminal control U+${code.toString(16).padStart(4, "0")} must not reach ${target}`);
    }
  }
  assert.doesNotMatch(text, new RegExp(ESC), `raw ESC must not reach ${target}`);
  assert.doesNotMatch(text, /\nFORGED|\rBAD/, `raw line controls must not reach ${target}`);
}

// A minimal fetch Response stand-in. Accepts an object (JSON) or string body
// and exposes json()/text()/arrayBuffer() so it works for control-plane JSON
// responses and R2 streaming/byte tests alike. json() parses the text
// representation like fetch does, so a string body must be valid JSON to be
// consumed through json(), and callers never share a reference with the
// fixture object.
/**
 * @param {unknown} body  Object (JSON-encoded) or pre-serialized string body.
 * @param {number} [status]
 */
export function response(body, status = 200) {
  const text = typeof body === "string" ? body : JSON.stringify(body);
  const bytes = Buffer.from(text);
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => JSON.parse(text),
    text: async () => text,
    arrayBuffer: async () =>
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
  };
}

// Records control-plane calls and stdout lines, returning deps for a command
// runner. env defaults to a bare admin token; pass a richer env (e.g. with
// WDL_NS) when the command resolves the namespace from the environment.
/**
 * @param {unknown} body
 * @param {NodeJS.ProcessEnv} [env]
 */
export function mockDeps(body, env = { ADMIN_TOKEN: "tok" }) {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  return {
    calls,
    lines,
    deps: {
      env,
      /** @param {string} line */
      stdout: (line) => lines.push(line),
      /** @param {string} url @param {import("../../lib/control-fetch.js").ControlFetchInit} [init] */
      controlFetch: async (url, init = {}) => {
        calls.push({ url, init });
        return response(body);
      },
    },
  };
}
