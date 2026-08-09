import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable, Writable } from "node:stream";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runR2Command } from "../../commands/r2.js";
import { LONG_CONTROL_TIMEOUT_MS, UNLIMITED_CONTROL_BODY_BYTES } from "../../lib/control-fetch.js";
import { mockDeps, response, stdinFrom } from "./helpers.js";

/** @typedef {import("./helpers.js").ControlCall} ControlCall */

test("r2 buckets and objects commands call encoded control endpoints", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  /** @type {string[]} */
  const bytes = [];
  const stdoutStream = new Writable({
    write(chunk, _encoding, callback) {
      bytes.push(Buffer.from(chunk).toString("utf8"));
      callback();
    },
  });
  const deps = {
    env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
    stdout: (/** @type {string} */ line) => lines.push(line),
    stdoutStream,
    controlFetch: async (
      /** @type {string} */ url,
      /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
    ) => {
      calls.push({ url, init });
      if (init.method === "DELETE") {
        return response({
          namespace: "demo space",
          bucket: "uploads",
          key: "dir/file.txt",
          status: "ok",
        });
      }
      if (init.method === "HEAD") {
        return {
          status: 200,
          ok: true,
          headers: {
            "content-length": "11",
            "content-type": "text/plain",
            "cache-control": "max-age=60",
            etag: '"abc"',
            "last-modified": "Wed, 22 Apr 2026 00:00:00 GMT",
            "x-amz-meta-source": "unit",
            "x-amz-meta-__proto__": "pwned",
          },
          text: async () => "",
        };
      }
      if (url.includes("/objects/dir/file.txt")) {
        return {
          status: 200,
          ok: true,
          headers: {},
          body: Readable.from([Buffer.from("object-"), Buffer.from("body")]),
          arrayBuffer: async () => {
            throw new Error("r2 get should stream the response body");
          },
          text: async () => "object-body",
        };
      }
      if (url.endsWith("/r2/buckets?limit=5")) {
        return response({
          namespace: "demo space",
          buckets: [{ name: "uploads" }],
          truncated: false,
        });
      }
      return response({
        namespace: "demo space",
        bucket: "uploads",
        objects: [{ key: "dir/file.txt", size: 11, etag: "abc", uploaded: "2026-04-22T00:00:00.000Z" }],
        delimitedPrefixes: ["dir/"],
        truncated: false,
      });
    },
  };

  await runR2Command(["buckets", "list", "--ns", "demo space", "--limit", "5"], deps);
  await runR2Command(["objects", "list", "--ns", "demo space", "uploads", "--prefix", "dir/"], deps);
  await runR2Command(["objects", "get", "--ns", "demo space", "uploads", "dir/file.txt"], deps);
  await runR2Command(["objects", "head", "--ns", "demo space", "uploads", "dir/file.txt"], deps);
  await runR2Command(["objects", "delete", "--ns", "demo space", "uploads", "dir/file.txt", "--yes"], deps);

  assert.equal(calls[0].url, "http://ctl.test/ns/demo%20space/r2/buckets?limit=5");
  assert.equal(calls[1].url, "http://ctl.test/ns/demo%20space/r2/buckets/uploads/objects?prefix=dir%2F");
  assert.equal(calls[2].url, "http://ctl.test/ns/demo%20space/r2/buckets/uploads/objects/dir/file.txt");
  assert.equal(calls[2].init.timeoutMs, LONG_CONTROL_TIMEOUT_MS);
  assert.equal(calls[2].init.maxBodyBytes, UNLIMITED_CONTROL_BODY_BYTES);
  assert.equal(calls[3].url, "http://ctl.test/ns/demo%20space/r2/buckets/uploads/objects/dir/file.txt");
  assert.equal(calls[3].init.method, "HEAD");
  assert.equal(calls[4].url, "http://ctl.test/ns/demo%20space/r2/buckets/uploads/objects/dir/file.txt");
  assert.equal(calls[4].init.method, "DELETE");
  assert.equal(bytes.join(""), "object-body");
  assert.deepEqual(lines.slice(0, 4), [
    "R2 buckets in demo space:",
    "  uploads",
    "R2 objects in demo space/uploads:",
    "  <prefix> dir/",
  ]);
  assert.ok(lines.includes("R2 object demo space/uploads/dir/file.txt:"));
  assert.ok(lines.includes("  customMetadata.source: unit"));
  assert.ok(
    lines.includes("  customMetadata.__proto__: pwned"),
    "a control-supplied __proto__ metadata key is not dropped"
  );
  assert.equal(lines.at(-1), "OK demo space/uploads/dir/file.txt deleted");
});

test("r2 object head --json keeps a __proto__ metadata key and drops a bare x-amz-meta-", async () => {
  /** @type {string[]} */
  const lines = [];
  const deps = {
    env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
    stdout: (/** @type {string} */ line) => lines.push(line),
    controlFetch: async () => ({
      status: 200,
      ok: true,
      headers: {
        "content-length": "0",
        "x-amz-meta-source": "unit",
        "x-amz-meta-__proto__": "pwned",
        "x-amz-meta-": "dropped",
      },
      text: async () => "",
    }),
  };
  await runR2Command(
    ["objects", "head", "--ns", "demo", "uploads", "k", "--json", "--control-url", "http://ctl.test"],
    deps
  );
  const meta = JSON.parse(/** @type {string} */ (lines.find((l) => l.trim().startsWith("{")))).customMetadata;
  // JSON.parse re-materializes __proto__ as an own data property, so read the
  // descriptor — `meta.__proto__` would go through the prototype accessor instead.
  assert.equal(Object.getOwnPropertyDescriptor(meta, "__proto__")?.value, "pwned");
  assert.equal(meta.source, "unit");
  assert.ok(!Object.hasOwn(meta, ""), "a bare x-amz-meta- header produces no empty metadata key");
});

test("r2 buckets list accepts flags before the group/action", async () => {
  const { calls, deps } = mockDeps({ namespace: "demo", buckets: [] });

  await runR2Command(["--ns", "demo", "--control-url", "http://ctl.test", "buckets", "list"], deps);

  assert.equal(calls[0].url, "http://ctl.test/ns/demo/r2/buckets");
});

test("r2 list --limit is validated locally", async () => {
  const { calls, deps } = mockDeps({ namespace: "demo", buckets: [] });

  await runR2Command(["buckets", "list", "--ns", "demo", "--limit", "1000", "--control-url", "http://ctl.test"], deps);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/r2/buckets?limit=1000");

  await assert.rejects(
    () =>
      runR2Command(["buckets", "list", "--ns", "demo", "--limit", "1001", "--control-url", "http://ctl.test"], deps),
    /--limit must be an integer/
  );
  await assert.rejects(
    () =>
      runR2Command(
        ["objects", "list", "--ns", "demo", "uploads", "--limit", "1.5", "--control-url", "http://ctl.test"],
        deps
      ),
    /--limit must be an integer/
  );
  assert.equal(calls.length, 1);
});

test("r2 object get waits for stdout backpressure", async () => {
  /** @type {string[]} */
  const events = [];
  const stdoutStream = Object.assign(new EventEmitter(), {
    /** @param {Buffer} chunk */
    write(chunk) {
      events.push(`write:${Buffer.from(chunk).toString("utf8")}`);
      if (events.length === 1) {
        setTimeout(() => {
          events.push("drain");
          stdoutStream.emit("drain");
        }, 5);
        return false;
      }
      return true;
    },
  });

  await runR2Command(["objects", "get", "--ns", "demo", "uploads", "file.txt"], {
    env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
    stdoutStream,
    controlFetch: async () => ({
      status: 200,
      ok: true,
      headers: {},
      body: Readable.from([Buffer.from("a"), Buffer.from("b")]),
      text: async () => "",
    }),
  });

  assert.deepEqual(events, ["write:a", "drain", "write:b"]);
});

test("r2 object get refuses raw output to an interactive terminal", async () => {
  const stdoutStream = Object.assign(new EventEmitter(), {
    isTTY: true,
    write() {
      throw new Error("stdout should not be written");
    },
  });
  await assert.rejects(
    () =>
      runR2Command(["objects", "get", "--ns", "demo", "uploads", "file.txt"], {
        env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
        stdoutStream,
        controlFetch: async () => {
          throw new Error("controlFetch should not be called");
        },
      }),
    /refuses to write raw object bytes to an interactive terminal/
  );
});

test("r2 object get --out escapes a control-char path in the success line", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-r2-out-escape-"));
  try {
    const esc = String.fromCharCode(27);
    const outPath = path.join(dir, `file${esc}[2J.bin`);
    /** @type {string[]} */
    const lines = [];
    await runR2Command(
      ["objects", "get", "--ns", "demo", "uploads", "file.txt", "--out", outPath, "--control-url", "http://ctl.test"],
      {
        env: { ADMIN_TOKEN: "tok" },
        stdout: (/** @type {string} */ line) => lines.push(line),
        controlFetch: async () => ({
          status: 200,
          ok: true,
          headers: {},
          body: Readable.from([Buffer.from("ab")]),
          text: async () => "",
        }),
      }
    );
    const out = lines.join("\n");
    assert.doesNotMatch(out, new RegExp(esc), "raw ESC from --out path must not reach stdout");
    assert.match(out, /OK wrote 2 bytes to/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("r2 object get, head, and delete reject blank keys", async () => {
  const deps = {
    env: { CONTROL_URL: "http://ctl.test" },
    controlFetch: async () => {
      throw new Error("controlFetch should not be called");
    },
  };

  await assert.rejects(
    () => runR2Command(["objects", "get", "--ns", "demo", "uploads", "   "], deps),
    /R2 object key is required/
  );
  await assert.rejects(
    () => runR2Command(["objects", "head", "--ns", "demo", "uploads", "   "], deps),
    /R2 object key is required/
  );
  await assert.rejects(
    () => runR2Command(["objects", "delete", "--ns", "demo", "uploads", "   ", "--yes"], deps),
    /R2 object key is required/
  );
});

test("r2 object key preserves empty path segments but rejects dot segments", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  const deps = {
    env: { ADMIN_TOKEN: "tok" },
    stdout: () => {},
    controlFetch: async (
      /** @type {string} */ url,
      /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
    ) => {
      calls.push({ url, init });
      return {
        status: 200,
        ok: true,
        headers: {},
        text: async () => "",
      };
    },
  };
  await runR2Command(["objects", "head", "bkt", "a//b", "--ns", "demo", "--control-url", "http://ctl.test"], deps);
  await runR2Command(["objects", "head", "bkt", "/a", "--ns", "demo", "--control-url", "http://ctl.test"], deps);
  await runR2Command(["objects", "head", "bkt", "a/", "--ns", "demo", "--control-url", "http://ctl.test"], deps);

  assert.equal(calls[0].url, "http://ctl.test/ns/demo/r2/buckets/bkt/objects/a//b");
  assert.equal(calls[1].url, "http://ctl.test/ns/demo/r2/buckets/bkt/objects//a");
  assert.equal(calls[2].url, "http://ctl.test/ns/demo/r2/buckets/bkt/objects/a/");

  await assert.rejects(
    () =>
      runR2Command(["objects", "get", "bkt", "a/./b", "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdout: () => {},
        controlFetch: async () => response({}),
      }),
    /must not contain \. or \.\. path segments/
  );
});

test("r2 commands reject unexpected positional arguments", async () => {
  const deps = {
    env: { CONTROL_URL: "http://ctl.test" },
    controlFetch: async () => {
      throw new Error("controlFetch should not be called");
    },
  };
  await assert.rejects(
    () => runR2Command(["buckets", "list", "extra", "--ns", "demo"], deps),
    /r2 buckets list received unexpected argument: extra/
  );
  await assert.rejects(
    () => runR2Command(["objects", "list", "uploads", "extra", "--ns", "demo"], deps),
    /r2 objects list received unexpected argument: extra/
  );
  await assert.rejects(
    () => runR2Command(["objects", "get", "uploads", "key", "extra", "--ns", "demo"], deps),
    /r2 objects get received unexpected argument: extra/
  );
});

test("r2 streaming commands format JSON control errors", async () => {
  const deps = {
    env: { ADMIN_TOKEN: "tok", CONTROL_URL: "http://ctl.test" },
    controlFetch: async () =>
      response(
        {
          error: "r2_object_not_found",
          message: "R2 object not found",
        },
        404
      ),
  };

  await assert.rejects(() => runR2Command(["objects", "get", "--ns", "demo", "uploads", "missing.txt"], deps), {
    message: "get R2 object failed: 404 r2_object_not_found: R2 object not found",
  });
});

test("r2 object delete requires confirmation unless --yes is used", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  await assert.rejects(
    () =>
      runR2Command(["objects", "delete", "--ns", "demo", "uploads", "a.txt", "--control-url", "http://ctl.test"], {
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
    /Refusing to delete R2 object "demo\/uploads\/a.txt" without interactive confirmation/
  );
  assert.equal(calls.length, 0);
});
