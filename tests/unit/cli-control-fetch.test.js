import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { CliError } from "../../lib/common.js";
import {
  DEFAULT_CONTROL_MAX_BODY_BYTES,
  controlFetch,
  readControlResponse,
} from "../../lib/control-fetch.js";
import { currentCliVersion } from "../../lib/package-info.js";

/**
 * @param {{ statusCode?: number, headers?: import("node:http").IncomingHttpHeaders }} [init]
 */
function fakeResponse({ statusCode = 200, headers = {} } = {}) {
  return Object.assign(new EventEmitter(), { statusCode, headers });
}

test("readControlResponse parses bounded response bodies", async () => {
  const res = fakeResponse({ headers: { "content-type": "application/json" } });
  const promise = readControlResponse(res, { maxBodyBytes: 64 });
  res.emit("data", Buffer.from(JSON.stringify({ ok: true })));
  res.emit("end");

  const parsed = await promise;
  assert.equal(parsed.ok, true);
  assert.equal(parsed.status, 200);
  assert.deepEqual(await parsed.json(), { ok: true });
});

test("readControlResponse rejects oversized response bodies", async () => {
  const res = fakeResponse();
  const promise = readControlResponse(res, { maxBodyBytes: 3 });
  res.emit("data", Buffer.from("too large"));
  res.emit("end");

  await assert.rejects(promise, /control response exceeded 3 bytes/);
});

test("default buffered control response cap matches platform response cap", () => {
  assert.equal(DEFAULT_CONTROL_MAX_BODY_BYTES, 16 * 1024 * 1024);
});

test("readControlResponse aborts the stream and ignores further chunks once the cap is exceeded", async () => {
  let destroyed = false;
  const res = Object.assign(new EventEmitter(), {
    statusCode: 200,
    headers: {},
    destroy() { destroyed = true; },
  });
  const promise = readControlResponse(res, { maxBodyBytes: 3 });
  res.emit("data", Buffer.from("over")); // over the cap -> reject + destroy
  res.emit("data", Buffer.from("more")); // must be ignored, not re-accumulated
  res.emit("end"); // a late end must not flip the rejection into a resolve
  await assert.rejects(promise, /control response exceeded 3 bytes/);
  assert.equal(destroyed, true, "the stream is destroyed to stop draining the body");
});

test("readControlResponse can disable the response body cap", async () => {
  const res = fakeResponse();
  const promise = readControlResponse(res, { maxBodyBytes: 0 });
  res.emit("data", Buffer.from("too large for the tiny test cap"));
  res.emit("end");

  assert.equal(await (await promise).text(), "too large for the tiny test cap");
});

test("readControlResponse rejects response stream errors", async () => {
  const res = fakeResponse();
  const promise = readControlResponse(res);
  res.emit("error", new Error("socket closed"));

  await assert.rejects(promise, /socket closed/);
});

test("controlFetch rejects pre-aborted requests before opening a socket", async () => {
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    () => controlFetch("http://127.0.0.1", { signal: controller.signal }),
    /control request aborted/
  );
});

test("controlFetch wraps request socket errors as CliError", async () => {
  /** @type {import("../../lib/control-fetch.js").ControlTransport} */
  const transport = {
    request() {
      const req = Object.assign(new EventEmitter(), {
        write() {},
        end() {
          req.emit("error", Object.assign(new Error("connect refused"), { code: "ECONNREFUSED" }));
        },
        destroy() {},
      });
      return req;
    },
  };

  await assert.rejects(
    () => controlFetch("http://ctl.test/whoami", { transport }),
    (err) => err instanceof CliError &&
      err.message === "control request failed: ECONNREFUSED connect refused"
  );
});

test("controlFetch rejects invalid header values before opening a socket", async () => {
  let opened = false;
  /** @type {import("../../lib/control-fetch.js").ControlTransport} */
  const transport = {
    request() {
      opened = true;
      throw new Error("request should not be opened");
    },
  };

  await assert.rejects(
    async () => controlFetch("http://ctl.test/whoami", {
      headers: { "x-admin-token": "tok\nnext" },
      transport,
    }),
    (err) => err instanceof CliError &&
      err.message.includes('control request failed: invalid HTTP header "x-admin-token"')
  );
  assert.equal(opened, false);
});

test("controlFetch wraps synchronous request construction errors as CliError", async () => {
  /** @type {import("../../lib/control-fetch.js").ControlTransport} */
  const transport = {
    request() {
      throw Object.assign(new Error("bad request options"), { code: "ERR_BAD_REQUEST" });
    },
  };

  await assert.rejects(
    async () => controlFetch("http://ctl.test/whoami", { transport }),
    (err) => err instanceof CliError &&
      err.message === "control request failed: ERR_BAD_REQUEST bad request options"
  );
});

test("controlFetch keeps timeout active while streaming the response body", async () => {
  const res = Object.assign(new PassThrough(), {
    statusCode: 200,
    headers: { "content-type": "application/octet-stream" },
  });
  let requestDestroyError = /** @type {Error | null | undefined} */ (null);
  /** @type {import("../../lib/control-fetch.js").ControlTransport} */
  const transport = {
    request(_opts, onResponse) {
      return Object.assign(new EventEmitter(), {
        write() {},
        end() {
          onResponse(/** @type {import("node:http").IncomingMessage} */ (/** @type {unknown} */ (res)));
          res.write("partial");
        },
        /** @param {Error} [err] */
        destroy(err) {
          requestDestroyError = err;
        },
      });
    },
  };

  const response = await controlFetch("http://ctl.test/object", {
    streamResponse: true,
    timeoutMs: 20,
    transport,
  });

  const body = /** @type {import("node:stream").Readable} */ (response.body);
  await assert.rejects(
    async () => {
      for await (const _chunk of body) {
        // Wait for the transport timeout to destroy the stalled stream.
      }
    },
    /control request timed out after 20ms/
  );
  assert.ok(requestDestroyError);
  assert.match(requestDestroyError.message, /control request timed out after 20ms/);
});

test("controlFetch streaming timeout is idle-based after headers", async () => {
  const res = Object.assign(new PassThrough(), {
    statusCode: 200,
    headers: { "content-type": "application/octet-stream" },
  });
  /** @type {import("../../lib/control-fetch.js").ControlTransport} */
  const transport = {
    request(_opts, onResponse) {
      return Object.assign(new EventEmitter(), {
        write() {},
        end() {
          onResponse(/** @type {import("node:http").IncomingMessage} */ (/** @type {unknown} */ (res)));
          setTimeout(() => res.write("a"), 10);
          setTimeout(() => res.write("b"), 25);
          setTimeout(() => res.end("c"), 40);
        },
        destroy() {},
      });
    },
  };

  const response = await controlFetch("http://ctl.test/object", {
    streamResponse: true,
    timeoutMs: 20,
    transport,
  });

  /** @type {string[]} */
  const chunks = [];
  const body = /** @type {import("node:stream").Readable} */ (response.body);
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk).toString("utf8"));
  }
  assert.equal(chunks.join(""), "abc");
});

test("controlFetch buffers early streaming chunks until caller consumes body", async () => {
  const res = Object.assign(new PassThrough(), {
    statusCode: 200,
    headers: { "content-type": "application/octet-stream" },
  });
  /** @type {import("../../lib/control-fetch.js").ControlTransport} */
  const transport = {
    request(_opts, onResponse) {
      return Object.assign(new EventEmitter(), {
        write() {},
        end() {
          onResponse(/** @type {import("node:http").IncomingMessage} */ (/** @type {unknown} */ (res)));
          res.write("early");
          setTimeout(() => res.end("late"), 5);
        },
        destroy() {},
      });
    },
  };

  const response = await controlFetch("http://ctl.test/object", {
    streamResponse: true,
    timeoutMs: 50,
    transport,
  });
  await new Promise((resolve) => setTimeout(resolve, 10));

  /** @type {string[]} */
  const chunks = [];
  const body = /** @type {import("node:stream").Readable} */ (response.body);
  for await (const chunk of body) {
    chunks.push(Buffer.from(chunk).toString("utf8"));
  }
  assert.equal(chunks.join(""), "earlylate");
});

test("controlFetch forwards streaming source errors to the consumer", async () => {
  const res = Object.assign(new PassThrough(), {
    statusCode: 200,
    headers: { "content-type": "application/octet-stream" },
  });
  /** @type {import("../../lib/control-fetch.js").ControlTransport} */
  const transport = {
    request(_opts, onResponse) {
      return Object.assign(new EventEmitter(), {
        write() {},
        end() {
          onResponse(/** @type {import("node:http").IncomingMessage} */ (/** @type {unknown} */ (res)));
          res.write("partial");
          setTimeout(() => res.emit("error", new Error("socket lost")), 5);
        },
        destroy() {},
      });
    },
  };

  const response = await controlFetch("http://ctl.test/object", {
    streamResponse: true,
    timeoutMs: 50,
    transport,
  });

  const body = /** @type {import("node:stream").Readable} */ (response.body);
  await assert.rejects(
    async () => {
      for await (const _chunk of body) {
        // Consume until the upstream response error is forwarded.
      }
    },
    /socket lost/
  );
});

test("controlFetch carries the URL port in Host and strips IPv6 brackets for the socket", async () => {
  /** @type {Array<import("node:https").RequestOptions & { headers: import("node:http").OutgoingHttpHeaders }>} */
  const seen = [];
  /** @type {import("../../lib/control-fetch.js").ControlTransport} */
  const transport = {
    request(opts, onResponse) {
      seen.push(/** @type {import("node:https").RequestOptions & { headers: import("node:http").OutgoingHttpHeaders }} */ (opts));
      return Object.assign(new EventEmitter(), {
        write() {},
        end() {
          const res = fakeResponse();
          onResponse(/** @type {import("node:http").IncomingMessage} */ (/** @type {unknown} */ (res)));
          res.emit("data", Buffer.from("{}"));
          res.emit("end");
        },
        destroy() {},
      });
    },
  };

  await controlFetch("http://[::1]:8080/whoami", { transport });
  await controlFetch("http://127.0.0.1:9090/whoami", { transport });
  await controlFetch("http://ctl.test/whoami", { transport });

  assert.equal(seen[0].host, "::1");
  assert.equal(seen[0].port, 8080);
  assert.equal(seen[0].headers.Host, "[::1]:8080");
  assert.equal(seen[1].headers.Host, "127.0.0.1:9090");
  // No explicit port: Host stays the bare hostname.
  assert.equal(seen[2].headers.Host, "ctl.test");
  assert.equal(seen[2].headers["User-Agent"], `wdl-cli/${currentCliVersion()}`);
});

test("controlFetch parses CONTROL_CONNECT_HOST host:port overrides", async () => {
  const oldConnectHost = process.env.CONTROL_CONNECT_HOST;
  process.env.CONTROL_CONNECT_HOST = "[::1]:18443";
  /** @type {import("node:https").RequestOptions | null} */
  let seen = null;
  /** @type {import("../../lib/control-fetch.js").ControlTransport} */
  const transport = {
    request(opts, onResponse) {
      seen = opts;
      return Object.assign(new EventEmitter(), {
        write() {},
        end() {
          const res = fakeResponse();
          onResponse(/** @type {import("node:http").IncomingMessage} */ (/** @type {unknown} */ (res)));
          res.emit("data", Buffer.from("{}"));
          res.emit("end");
        },
        destroy() {},
      });
    },
  };

  try {
    await controlFetch("https://ctl.example/whoami", { transport });
  } finally {
    if (oldConnectHost == null) delete process.env.CONTROL_CONNECT_HOST;
    else process.env.CONTROL_CONNECT_HOST = oldConnectHost;
  }

  assert.ok(seen);
  const opts = /** @type {import("node:https").RequestOptions & { headers: import("node:http").OutgoingHttpHeaders }} */ (seen);
  assert.equal(opts.host, "::1");
  assert.equal(opts.port, 18443);
  assert.equal(opts.headers.Host, "ctl.example");
  assert.equal(opts.servername, "ctl.example");
});

test("controlFetch uses init env for CONTROL_CONNECT_HOST overrides", async () => {
  const oldConnectHost = process.env.CONTROL_CONNECT_HOST;
  process.env.CONTROL_CONNECT_HOST = "process.example:19000";
  /** @type {import("node:https").RequestOptions | null} */
  let seen = null;
  /** @type {import("../../lib/control-fetch.js").ControlTransport} */
  const transport = {
    request(opts, onResponse) {
      seen = opts;
      return Object.assign(new EventEmitter(), {
        write() {},
        end() {
          const res = fakeResponse();
          onResponse(/** @type {import("node:http").IncomingMessage} */ (/** @type {unknown} */ (res)));
          res.emit("data", Buffer.from("{}"));
          res.emit("end");
        },
        destroy() {},
      });
    },
  };

  try {
    await controlFetch("http://admin.test:8080/whoami", {
      env: { CONTROL_CONNECT_HOST: "127.0.0.1:18080" },
      transport,
    });
  } finally {
    if (oldConnectHost == null) delete process.env.CONTROL_CONNECT_HOST;
    else process.env.CONTROL_CONNECT_HOST = oldConnectHost;
  }

  assert.ok(seen);
  const opts = /** @type {import("node:https").RequestOptions & { headers: import("node:http").OutgoingHttpHeaders }} */ (seen);
  assert.equal(opts.host, "127.0.0.1");
  assert.equal(opts.port, 18080);
  assert.equal(opts.headers.Host, "admin.test:8080");
});

test("controlFetch rejects invalid CONTROL_CONNECT_HOST ports before opening a socket", () => {
  const oldConnectHost = process.env.CONTROL_CONNECT_HOST;
  try {
    for (const value of ["127.0.0.1:99999", "[::1]:99999", "http://127.0.0.1:99999"]) {
      process.env.CONTROL_CONNECT_HOST = value;
      assert.throws(
        () => controlFetch("http://ctl.test/whoami", {
          transport: {
            request() {
              throw new Error("request should not be opened");
            },
          },
        }),
        (err) => err instanceof CliError &&
          err.message.includes(`Invalid CONTROL_CONNECT_HOST ${JSON.stringify(value)}`)
      );
    }
  } finally {
    if (oldConnectHost == null) delete process.env.CONTROL_CONNECT_HOST;
    else process.env.CONTROL_CONNECT_HOST = oldConnectHost;
  }
});

test("controlFetch omits TLS SNI for HTTPS IP literals", async () => {
  /** @type {import("node:https").RequestOptions | null} */
  let seen = null;
  /** @type {import("../../lib/control-fetch.js").ControlTransport} */
  const transport = {
    request(opts, onResponse) {
      seen = opts;
      return Object.assign(new EventEmitter(), {
        write() {},
        end() {
          const res = fakeResponse();
          onResponse(/** @type {import("node:http").IncomingMessage} */ (/** @type {unknown} */ (res)));
          res.emit("data", Buffer.from("{}"));
          res.emit("end");
        },
        destroy() {},
      });
    },
  };

  await controlFetch("https://127.0.0.1/whoami", { transport });

  assert.ok(seen);
  const opts = /** @type {import("node:https").RequestOptions} */ (seen);
  assert.equal(opts.host, "127.0.0.1");
  assert.equal(opts.port, 443);
  assert.equal(opts.servername, undefined);
});
