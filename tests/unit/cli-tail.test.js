import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { SSE_MAX_LINE_CHARS, SseParser, runTailCommand } from "../../commands/tail.js";
import { CliError } from "../../lib/common.js";
import { ESC, assertNoRawTerminalControls } from "./helpers.js";

test("SseParser dispatches event/id/data on blank line per SSE rules", () => {
  /** @type {import("../../commands/tail.js").SseEvent[]} */
  const events = [];
  const parser = new SseParser((event) => events.push(event));

  parser.push('event: worker_console\nid: 1700000000000-0\ndata: {"a":');
  parser.push("1}\n");
  parser.push('data: "trailing"\n\n');
  parser.push(":hb\n\n");
  parser.push("data: hello\n\n");

  assert.deepEqual(events, [
    { event: "worker_console", id: "1700000000000-0", data: '{"a":1}\n"trailing"' },
    { event: "message", id: "1700000000000-0", data: "hello" },
  ]);
});

test("SseParser handles CRLF line endings and flushes trailing events", () => {
  /** @type {import("../../commands/tail.js").SseEvent[]} */
  const events = [];
  const parser = new SseParser((event) => events.push(event));

  parser.push("event: ping\r\ndata: x\r\n\r\n");
  parser.push("event: late\ndata: y");
  parser.flush();

  assert.equal(events.length, 2);
  assert.equal(events[0].event, "ping");
  assert.equal(events[0].data, "x");
  assert.equal(events[1].event, "late");
  assert.equal(events[1].data, "y");
});

test("SseParser rejects overlong lines", () => {
  const parser = new SseParser(() => {});
  assert.throws(() => parser.push(`data: ${"x".repeat(SSE_MAX_LINE_CHARS)}`), /SSE line exceeded/);
});

test("SseParser bounds cumulative event data and resets after dispatch", () => {
  /** @type {import("../../commands/tail.js").SseEvent[]} */
  const events = [];
  const parser = new SseParser((event) => events.push(event));
  parser.maxEventBytes = 5;

  parser.push("data: abc\ndata: d\n\n");
  parser.push("data: 12345\n\n");
  assert.deepEqual(
    events.map((event) => event.data),
    ["abc\nd", "12345"]
  );

  assert.throws(() => parser.push("data: abc\ndata: de\n"), /SSE event exceeded 5 bytes/);

  const multibyte = new SseParser(() => {});
  multibyte.maxEventBytes = 3;
  assert.throws(() => multibyte.push("data: \u00e9\u00e9\n"), /SSE event exceeded 3 bytes/);
});

test("wdl tail rejects errors raised while flushing a trailing SSE event", async () => {
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        res.emit("data", 'data: {"event":"worker_console","message":["x"]}');
        res.emit("end");
      });
      return req;
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"], {
        env: {},
        stdout: () => {
          throw new CliError("stdout stop");
        },
        stderr: () => {},
        transport: fakeTransport,
      }),
    { message: "stdout stop" }
  );
});

test("wdl tail rejects --since for multi-worker sessions", async () => {
  await assert.rejects(
    () =>
      runTailCommand(["foo", "bar", "--since", "1-0", "--ns", "demo", "--token", "t"], {
        env: {},
        stdout: () => {},
        stderr: () => {},
      }),
    /single-worker/i
  );
});

test("wdl tail rejects invalid max-reconnects input", async () => {
  const bad = `forever${ESC}[2J\nFORGED\rBAD\u009b`;
  await assert.rejects(
    () =>
      runTailCommand(
        ["foo", "--max-reconnects", bad, "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"],
        { env: {}, stdout: () => {}, stderr: () => {} }
      ),
    (err) => {
      const message = /** @type {Error} */ (err).message;
      assert.match(message, /--max-reconnects must be a non-negative integer/);
      assert.match(message, /forever\\u001b\[2J\\nFORGED\\rBAD\\u009b/);
      assertNoRawTerminalControls(message, "--max-reconnects errors");
      return true;
    }
  );
});

test("wdl tail requires at least one positional worker", async () => {
  await assert.rejects(
    () =>
      runTailCommand(["--ns", "demo", "--token", "t"], {
        env: {},
        stdout: () => {},
        stderr: () => {},
      }),
    /Specify one or more worker names/
  );
});

test("wdl tail help short-circuits before max-reconnects validation", async () => {
  /** @type {string[]} */
  const stdoutLines = [];
  await runTailCommand(["--help", "--max-reconnects", "forever"], {
    env: {},
    stdout: (/** @type {string} */ line) => stdoutLines.push(line),
    stderr: () => {},
  });

  assert.ok(stdoutLines.some((line) => /--max-reconnects/.test(line)));
});

test("wdl tail escapes control error details", async () => {
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = Object.assign(fakeHttpRes(), { statusCode: 500 });
        cb(res);
        res.emit(
          "data",
          Buffer.from(
            JSON.stringify({
              message: "bad\u001b[31m\nline",
            })
          )
        );
        res.emit("end");
      });
      return req;
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"], {
        env: {},
        stdout: () => {},
        stderr: () => {},
        transport: fakeTransport,
      }),
    { message: "bad\\u001b[31m\\nline" }
  );
});

/** @returns {import("../../lib/control-fetch.js").ControlClientRequest} */
function fakeHttpReq() {
  return /** @type {import("../../lib/control-fetch.js").ControlClientRequest} */ (
    /** @type {unknown} */ (
      Object.assign(new EventEmitter(), {
        end() {},
        destroy() {},
      })
    )
  );
}

/** @returns {import("node:http").IncomingMessage} */
function fakeHttpRes() {
  return /** @type {import("node:http").IncomingMessage} */ (
    /** @type {unknown} */ (
      Object.assign(new EventEmitter(), {
        statusCode: 200,
        headers: {},
        setEncoding() {},
      })
    )
  );
}

test("wdl tail renders fetch, scheduled, and queue invocation events", async () => {
  /** @type {string[]} */
  const stdoutLines = [];
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        const events = [
          {
            event: "worker_scheduled",
            phase: "start",
            ts: 1,
            cron: "*/5 * * * *",
            scheduled_time: 123,
          },
          {
            event: "worker_queue",
            phase: "finish",
            ts: 2,
            queue: "jobs",
            batch_size: 3,
            outcome: "ok",
            duration_ms: 7,
          },
          {
            event: "worker_fetch",
            worker: "foo",
            phase: "finish",
            ts: 3,
            method: "GET",
            path: "/api/inspections",
            path_truncated: true,
            status: 204,
            outcome: "ok",
            duration_ms: 4,
          },
        ];
        for (const payload of events) {
          res.emit("data", `event: ${payload.event}\ndata: ${JSON.stringify(payload)}\n\n`);
        }
        res.emit("error", new CliError("test stop"));
      });
      return req;
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"], {
        env: {},
        stdout: (/** @type {string} */ line) => stdoutLines.push(line),
        stderr: () => {},
        transport: fakeTransport,
      }),
    { message: "test stop" }
  );

  assert.match(stdoutLines[0], /scheduled start cron="\*\/5 \* \* \* \*" scheduled_time=123/);
  assert.match(stdoutLines[1], /queue finish name=jobs batch_size=3 outcome=ok duration_ms=7/);
  assert.match(
    stdoutLines[2],
    /fetch finish method=GET path="\/foo\/api\/inspections" \(truncated\) status=204 outcome=ok duration_ms=4/
  );
  assert.ok(!stdoutLines.some((line) => line.includes('{"event"')));
});

test("wdl tail escapes terminal control sequences in rendered events", async () => {
  /** @type {string[]} */
  const stdoutLines = [];
  let emitted = false;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        if (!emitted) {
          emitted = true;
          const consoleEvent = JSON.stringify({
            event: "worker_console",
            console_level: "log",
            message: "\u001b]0;owned\u0007evil",
            ts: 1,
          });
          const exceptionEvent = JSON.stringify({
            event: "worker_exception",
            name: "Error",
            message: "boom",
            stack: "Error: boom\n    at fetch (\u001b[2Jworker.js:1)",
            ts: 2,
          });
          res.emit(
            "data",
            `event: worker_console\ndata: ${consoleEvent}\n\n` + `event: worker_exception\ndata: ${exceptionEvent}\n\n`
          );
        }
        res.emit("error", new CliError("test stop"));
      });
      return req;
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"], {
        env: {},
        stdout: (/** @type {string} */ line) => stdoutLines.push(line),
        stderr: () => {},
        transport: fakeTransport,
        sleepFn: async () => {},
      }),
    { message: "test stop" }
  );

  const out = stdoutLines.join("\n");
  assert.ok(!out.includes("\u001b"), "raw ESC byte must never reach the terminal");
  assert.ok(out.includes("\\u001b]0;owned\\u0007evil"), `console message must be escaped, got ${JSON.stringify(out)}`);
  // The stack keeps its real newline but each line is escaped.
  assert.ok(out.includes("    at fetch (\\u001b[2Jworker.js:1)"), "stack lines must be escaped");
});

test("wdl tail accepts bare CONTROL_URL hosts by defaulting to https", async () => {
  /** @type {import("node:https").RequestOptions[]} */
  const requestsSeen = [];
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(opts, cb) {
      requestsSeen.push(opts);
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        res.emit("error", new CliError("test stop"));
      });
      return req;
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(["kv-demo"], {
        env: {
          ADMIN_TOKEN: "tok",
          CONTROL_URL: "ctl.uat.example",
          WDL_NS: "demo",
        },
        stdout: () => {},
        stderr: () => {},
        transport: fakeTransport,
      }),
    { message: "test stop" }
  );

  assert.equal(requestsSeen[0].host, "ctl.uat.example");
  assert.equal(requestsSeen[0].port, 443);
  assert.equal(
    /** @type {import("node:http").OutgoingHttpHeaders} */ (requestsSeen[0].headers).Host,
    "ctl.uat.example"
  );
  assert.equal(requestsSeen[0].path, "/ns/demo/logs/tail?worker=kv-demo");
});

test("wdl tail uses effective CONTROL_CONNECT_HOST for SSE sockets", async () => {
  /** @type {import("node:https").RequestOptions[]} */
  const requestsSeen = [];
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(opts, cb) {
      requestsSeen.push(opts);
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        res.emit("error", new CliError("test stop"));
      });
      return req;
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(["kv-demo"], {
        env: {
          ADMIN_TOKEN: "tok",
          CONTROL_URL: "http://admin.test:8080",
          CONTROL_CONNECT_HOST: "127.0.0.1:18080",
          WDL_NS: "demo",
        },
        stdout: () => {},
        stderr: () => {},
        transport: fakeTransport,
      }),
    { message: "test stop" }
  );

  assert.equal(requestsSeen[0].host, "127.0.0.1");
  assert.equal(requestsSeen[0].port, 18080);
  assert.equal(
    /** @type {import("node:http").OutgoingHttpHeaders} */ (requestsSeen[0].headers).Host,
    "admin.test:8080"
  );
  assert.equal(requestsSeen[0].path, "/ns/demo/logs/tail?worker=kv-demo");
});

test("wdl tail rejects invalid auth headers before opening an SSE request", async () => {
  let opened = false;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} _cb
     */
    request(_opts, _cb) {
      opened = true;
      throw new Error("request should not be opened");
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(["foo", "--ns", "demo", "--token", "tok\nnext", "--control-url", "http://ctl.test"], {
        env: {},
        stdout: () => {},
        stderr: () => {},
        transport: fakeTransport,
        sleepFn: async () => {
          throw new Error("tail should not enter the reconnect loop");
        },
      }),
    (err) =>
      err instanceof CliError && err.message.includes('control request failed: invalid HTTP header "x-admin-token"')
  );
  assert.equal(opened, false);
});

test("wdl tail abort destroys the SSE request with a tolerated abort error", async () => {
  /** @type {Array<Error & { code?: string }>} */
  const destroyedWith = [];
  let requestCount = 0;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} _cb
     */
    request(_opts, _cb) {
      requestCount += 1;
      const emitter = new EventEmitter();
      const req = /** @type {import("../../lib/control-fetch.js").ControlClientRequest} */ (
        /** @type {unknown} */ (
          Object.assign(emitter, {
            end() {},
            /** @param {Error & { code?: string }} [err] */
            destroy(err) {
              if (err) destroyedWith.push(err);
              setImmediate(() =>
                emitter.emit("error", err || Object.assign(new Error("socket closed"), { code: "ECONNRESET" }))
              );
            },
          })
        )
      );
      setImmediate(() => process.emit("SIGINT"));
      return req;
    },
  };

  await runTailCommand(["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"], {
    env: {},
    stdout: () => {},
    stderr: () => {},
    transport: fakeTransport,
    sleepFn: async () => {
      throw new Error("tail should not reconnect after abort");
    },
  });

  assert.equal(requestCount, 1);
  assert.equal(destroyedWith.length, 1);
  assert.equal(destroyedWith[0].name, "AbortError");
  assert.equal(destroyedWith[0].code, "ABORT_ERR");
});

test("wdl tail sends --since on the initial URL, not duplicated as Last-Event-ID", async () => {
  /** @type {Array<{ path: import("node:https").RequestOptions["path"], headers: import("node:http").OutgoingHttpHeaders }>} */
  const requestsSeen = [];
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(opts, cb) {
      requestsSeen.push({
        path: opts.path,
        headers: { .../** @type {import("node:http").OutgoingHttpHeaders} */ (opts.headers) },
      });
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        res.emit("error", new CliError("test stop"));
      });
      return req;
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(["foo", "--since", "100-0", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"], {
        env: {},
        stdout: () => {},
        stderr: () => {},
        transport: fakeTransport,
      }),
    { message: "test stop" }
  );

  assert.equal(requestsSeen[0].path, "/ns/demo/logs/tail?worker=foo&since=100-0");
  assert.equal(requestsSeen[0].headers["last-event-id"], undefined);
});

test("wdl tail keeps --since on reconnect until the server provides an event id", async () => {
  /** @type {Array<{ path: import("node:https").RequestOptions["path"], headers: import("node:http").OutgoingHttpHeaders }>} */
  const requestsSeen = [];
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(opts, cb) {
      requestsSeen.push({
        path: opts.path,
        headers: { .../** @type {import("node:http").OutgoingHttpHeaders} */ (opts.headers) },
      });
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        if (requestsSeen.length === 1) {
          res.emit("error", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
          return;
        }
        res.emit("error", new CliError("test stop"));
      });
      return req;
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(["foo", "--since", "100-0", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"], {
        env: {},
        stdout: () => {},
        stderr: () => {},
        transport: fakeTransport,
        sleepFn: async () => {},
      }),
    { message: "test stop" }
  );

  assert.equal(requestsSeen[0].path, "/ns/demo/logs/tail?worker=foo&since=100-0");
  assert.equal(requestsSeen[1].path, "/ns/demo/logs/tail?worker=foo&since=100-0");
  assert.equal(requestsSeen[1].headers["last-event-id"], undefined);
});

test("wdl tail switches from --since to Last-Event-ID after receiving an event id", async () => {
  /** @type {Array<{ path: import("node:https").RequestOptions["path"], headers: import("node:http").OutgoingHttpHeaders }>} */
  const requestsSeen = [];
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(opts, cb) {
      requestsSeen.push({
        path: opts.path,
        headers: { .../** @type {import("node:http").OutgoingHttpHeaders} */ (opts.headers) },
      });
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        if (requestsSeen.length === 1) {
          res.emit(
            "data",
            `id: 101-0\nevent: worker_console\ndata: ${JSON.stringify({
              event: "worker_console",
              console_level: "log",
              message: "hello",
              ts: 1,
            })}\n\n`
          );
          res.emit("error", Object.assign(new Error("socket hang up"), { code: "ECONNRESET" }));
          return;
        }
        res.emit("error", new CliError("test stop"));
      });
      return req;
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(["foo", "--since", "100-0", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"], {
        env: {},
        stdout: () => {},
        stderr: () => {},
        transport: fakeTransport,
        sleepFn: async () => {},
      }),
    { message: "test stop" }
  );

  assert.equal(requestsSeen[0].path, "/ns/demo/logs/tail?worker=foo&since=100-0");
  assert.equal(requestsSeen[1].path, "/ns/demo/logs/tail?worker=foo");
  assert.equal(requestsSeen[1].headers["last-event-id"], "101-0");
});

test("wdl tail prints a connected status after SSE handshake", async () => {
  /** @type {string[]} */
  const stderrLines = [];
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        res.emit("error", new CliError("test stop"));
      });
      return req;
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"], {
        env: {},
        stdout: () => {},
        stderr: (/** @type {string} */ line) => stderrLines.push(line),
        transport: fakeTransport,
      }),
    { message: "test stop" }
  );

  assert.ok(stderrLines.includes("tail connected; waiting for events…"));
});

test("wdl tail reconnects with Last-Event-ID after transport errors", async () => {
  /** @type {Array<{ path: import("node:https").RequestOptions["path"], headers: import("node:http").OutgoingHttpHeaders }>} */
  const requestsSeen = [];
  /** @type {string[]} */
  const stderrLines = [];
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(opts, cb) {
      requestsSeen.push({
        path: opts.path,
        headers: { .../** @type {import("node:http").OutgoingHttpHeaders} */ (opts.headers) },
      });
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        if (requestsSeen.length === 1) {
          setImmediate(() => {
            res.emit(
              "data",
              `id: 100-0\nevent: worker_console\ndata: ${JSON.stringify({
                event: "worker_console",
                console_level: "log",
                message: "hello",
                ts: 1,
              })}\n\n`
            );
            setImmediate(() => {
              res.emit(
                "error",
                Object.assign(new Error(`socket hang up${ESC}[2J\nFORGED\rBAD`), {
                  code: "ECONNRESET",
                })
              );
            });
          });
        } else {
          setImmediate(() => {
            res.emit("error", new CliError("test stop"));
          });
        }
      });
      return req;
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"], {
        env: {},
        stdout: () => {},
        stderr: (/** @type {string} */ line) => stderrLines.push(line),
        transport: fakeTransport,
        sleepFn: async () => {},
      }),
    { message: "test stop" }
  );

  assert.ok(requestsSeen.length >= 2);
  assert.equal(requestsSeen[0].headers["last-event-id"], undefined);
  assert.equal(requestsSeen[1].headers["last-event-id"], "100-0");
  const transportLine = stderrLines.find((line) => /transport error/i.test(line));
  assert.ok(transportLine);
  assert.match(transportLine, /socket hang up\\u001b\[2J\\nFORGED\\rBAD/);
  assertNoRawTerminalControls(transportLine, "tail transport diagnostics");
});

test("wdl tail treats session recycle warnings as control-initiated reconnects", async () => {
  /** @type {number[]} */
  const sleepCalls = [];
  /** @type {string[]} */
  const stderrLines = [];
  let requestCount = 0;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      requestCount += 1;
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        if (requestCount === 1) {
          setImmediate(() => {
            res.emit(
              "data",
              `event: tail_warning\ndata: ${JSON.stringify({
                event: "tail_warning",
                code: "session_idle",
                message: "client idle",
              })}\n\n`
            );
            res.emit("end");
          });
        } else {
          setImmediate(() => {
            res.emit("error", new CliError("test stop"));
          });
        }
      });
      return req;
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"], {
        env: {},
        stdout: () => {},
        stderr: (/** @type {string} */ line) => stderrLines.push(line),
        transport: fakeTransport,
        sleepFn: async (/** @type {number} */ ms) => sleepCalls.push(ms),
      }),
    { message: "test stop" }
  );

  assert.deepEqual(sleepCalls, [1000]);
  assert.ok(stderrLines.some((line) => /tail session_idle: client idle/.test(line)));
  assert.ok(!stderrLines.some((line) => /! tail_warning session_idle/.test(line)));
});

test("wdl tail --raw still treats session recycle warnings as control-initiated reconnects", async () => {
  /** @type {number[]} */
  const sleepCalls = [];
  /** @type {string[]} */
  const stdoutLines = [];
  let requestCount = 0;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      requestCount += 1;
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        if (requestCount <= 3) {
          setImmediate(() => {
            res.emit(
              "data",
              `event: tail_warning\ndata: ${JSON.stringify({
                event: "tail_warning",
                code: "session_idle",
                message: "client idle",
              })}\n\n`
            );
            res.emit("end");
          });
        } else {
          setImmediate(() => {
            res.emit("error", new CliError("test stop"));
          });
        }
      });
      return req;
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(["foo", "--raw", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"], {
        env: {},
        stdout: (/** @type {string} */ line) => stdoutLines.push(line),
        stderr: () => {},
        transport: fakeTransport,
        sleepFn: async (/** @type {number} */ ms) => sleepCalls.push(ms),
      }),
    { message: "test stop" }
  );

  assert.deepEqual(sleepCalls, [1000, 1000, 1000]);
  assert.equal(stdoutLines.length, 3);
  assert.deepEqual(JSON.parse(stdoutLines[0]), {
    event: "tail_warning",
    code: "session_idle",
    message: "client idle",
  });
});

test("wdl tail --raw treats non-object SSE JSON payloads as raw values", async () => {
  /** @type {string[]} */
  const stdoutLines = [];
  let requestCount = 0;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      requestCount += 1;
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        if (requestCount === 1) {
          setImmediate(() => {
            res.emit("data", "data: null\n\n");
            res.emit("end");
          });
        } else {
          setImmediate(() => {
            res.emit("error", new CliError("test stop"));
          });
        }
      });
      return req;
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(["foo", "--raw", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"], {
        env: {},
        stdout: (/** @type {string} */ line) => stdoutLines.push(line),
        stderr: () => {},
        transport: fakeTransport,
        sleepFn: async () => {},
      }),
    { message: "test stop" }
  );

  assert.deepEqual(
    stdoutLines.map((line) => JSON.parse(line)),
    [{ event: "message", raw: null }]
  );
});

test("wdl tail increases backoff until a stable session resets it", async () => {
  /** @type {number[]} */
  const sleepCalls = [];
  /** @type {string[]} */
  const stderrLines = [];
  let nowMs = 0;
  let requestCount = 0;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      requestCount += 1;
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        setImmediate(() => {
          if (requestCount === 1 || requestCount === 2) {
            res.emit("end");
            return;
          }
          if (requestCount === 3) {
            nowMs += 31_000;
            res.emit("end");
            return;
          }
          res.emit("error", new CliError("test stop"));
        });
      });
      return req;
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(["foo", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"], {
        env: {},
        stdout: () => {},
        stderr: (/** @type {string} */ line) => stderrLines.push(line),
        transport: fakeTransport,
        now: () => nowMs,
        sleepFn: async (/** @type {number} */ ms) => {
          sleepCalls.push(ms);
          nowMs += ms;
        },
      }),
    { message: "test stop" }
  );

  assert.deepEqual(sleepCalls, [1000, 2000, 1000]);
  assert.ok(stderrLines.some((line) => /reconnecting in 2000ms/.test(line)));
});

test("wdl tail gives up after reconnects repeatedly hit the cap", async () => {
  /** @type {number[]} */
  const sleepCalls = [];
  let requestCount = 0;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      requestCount += 1;
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        setImmediate(() => res.emit("end"));
      });
      return req;
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(
        ["foo", "--max-reconnects", "2", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"],
        {
          env: {},
          stdout: () => {},
          stderr: () => {},
          transport: fakeTransport,
          sleepFn: async (/** @type {number} */ ms) => sleepCalls.push(ms),
        }
      ),
    /gave up after 2 consecutive reconnects/
  );

  assert.equal(requestCount, 5);
  assert.deepEqual(sleepCalls, [1000, 2000, 4000, 5000]);
});

test("wdl tail --max-reconnects 0 disables the cap", async () => {
  /** @type {number[]} */
  const sleepCalls = [];
  let requestCount = 0;
  const fakeTransport = {
    /**
     * @param {import("node:https").RequestOptions} _opts
     * @param {(res: import("node:http").IncomingMessage) => void} cb
     */
    request(_opts, cb) {
      requestCount += 1;
      const req = fakeHttpReq();
      setImmediate(() => {
        const res = fakeHttpRes();
        cb(res);
        setImmediate(() => {
          if (requestCount >= 6) {
            res.emit("error", new CliError("test stop"));
          } else {
            res.emit("end");
          }
        });
      });
      return req;
    },
  };

  await assert.rejects(
    () =>
      runTailCommand(
        ["foo", "--max-reconnects", "0", "--ns", "demo", "--token", "t", "--control-url", "http://ctl.test"],
        {
          env: {},
          stdout: () => {},
          stderr: () => {},
          transport: fakeTransport,
          sleepFn: async (/** @type {number} */ ms) => sleepCalls.push(ms),
        }
      ),
    { message: "test stop" }
  );

  assert.equal(requestCount, 6);
  assert.deepEqual(sleepCalls, [1000, 2000, 4000, 5000, 5000]);
});
