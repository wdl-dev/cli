import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { controlFetch, readControlResponse } from "../../lib/control-fetch.js";

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

test("controlFetch keeps timeout active while streaming the response body", async () => {
  const res = Object.assign(new PassThrough(), {
    statusCode: 200,
    headers: { "content-type": "application/octet-stream" },
  });
  let requestDestroyError = /** @type {Error | null} */ (null);
  const transport = {
    request(_opts, onResponse) {
      return Object.assign(new EventEmitter(), {
        write() {},
        end() {
          onResponse(res);
          res.write("partial");
        },
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

  await assert.rejects(
    async () => {
      for await (const _chunk of response.body) {
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
  const transport = {
    request(_opts, onResponse) {
      return Object.assign(new EventEmitter(), {
        write() {},
        end() {
          onResponse(res);
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

  const chunks = [];
  for await (const chunk of response.body) {
    chunks.push(Buffer.from(chunk).toString("utf8"));
  }
  assert.equal(chunks.join(""), "abc");
});

test("controlFetch buffers early streaming chunks until caller consumes body", async () => {
  const res = Object.assign(new PassThrough(), {
    statusCode: 200,
    headers: { "content-type": "application/octet-stream" },
  });
  const transport = {
    request(_opts, onResponse) {
      return Object.assign(new EventEmitter(), {
        write() {},
        end() {
          onResponse(res);
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

  const chunks = [];
  for await (const chunk of response.body) {
    chunks.push(Buffer.from(chunk).toString("utf8"));
  }
  assert.equal(chunks.join(""), "earlylate");
});

test("controlFetch forwards streaming source errors to the consumer", async () => {
  const res = Object.assign(new PassThrough(), {
    statusCode: 200,
    headers: { "content-type": "application/octet-stream" },
  });
  const transport = {
    request(_opts, onResponse) {
      return Object.assign(new EventEmitter(), {
        write() {},
        end() {
          onResponse(res);
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

  await assert.rejects(
    async () => {
      for await (const _chunk of response.body) {
        // Consume until the upstream response error is forwarded.
      }
    },
    /socket lost/
  );
});

test("controlFetch carries the URL port in Host and strips IPv6 brackets for the socket", async () => {
  const seen = [];
  const transport = {
    request(opts, onResponse) {
      seen.push(opts);
      return Object.assign(new EventEmitter(), {
        write() {},
        end() {
          const res = fakeResponse();
          onResponse(res);
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
});
