import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runSecretCommand } from "../../commands/secret.js";
import { ESC, assertNoRawTerminalControls, mockDeps, response, stdinFrom, ttyStdinLine } from "./helpers.js";

/** @typedef {import("./helpers.js").ControlCall} ControlCall */

test("secret list accepts flags before the subcommand and inline command-word values", async () => {
  const { calls, deps } = mockDeps({ keys: [] });

  await runSecretCommand(["--ns", "demo", "--worker", "api", "--control-url", "http://ctl.test", "list"], deps);
  await runSecretCommand(["--ns", "demo", "--worker=put", "--control-url", "http://ctl.test", "list"], deps);
  await runSecretCommand(["--ns=list", "--scope", "ns", "--control-url", "http://ctl.test", "list"], deps);

  assert.equal(calls[0].url, "http://ctl.test/ns/demo/worker/api/secrets");
  assert.equal(calls[1].url, "http://ctl.test/ns/demo/worker/put/secrets");
  assert.equal(calls[2].url, "http://ctl.test/ns/list/secrets");
});

test("secret rejects separated command-word option values before the subcommand", async () => {
  let calls = 0;
  const deps = {
    env: { ADMIN_TOKEN: "tok" },
    controlFetch: async () => {
      calls += 1;
      return response({ keys: [] });
    },
  };

  for (const args of [
    ["--ns", "demo", "--worker", "put", "--control-url", "http://ctl.test", "list"],
    ["--ns", "list", "--scope", "ns", "--control-url", "http://ctl.test", "list"],
  ]) {
    await assert.rejects(() => runSecretCommand(args, deps), /put the command before its options or use --flag=value/);
  }
  assert.equal(calls, 0);
});

test("secret list uses encoded namespace and worker path segments", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  await runSecretCommand(["list", "--ns", "demo space", "--worker", "api/slash", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: (/** @type {string} */ line) => lines.push(line),
    controlFetch: async (
      /** @type {string} */ url,
      /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
    ) => {
      calls.push({ url, init });
      return response({ keys: ["A", "B"] });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo%20space/worker/api%2Fslash/secrets");
  assert.deepEqual(calls[0].init.headers, { "x-admin-token": "tok" });
  assert.deepEqual(lines, ["A", "B"]);
});

test("secret list supports raw json output", async () => {
  /** @type {string[]} */
  const lines = [];
  await runSecretCommand(["list", "--json", "--ns", "demo", "--scope", "ns", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: (/** @type {string} */ line) => lines.push(line),
    controlFetch: async () => response({ namespace: "demo", keys: ["A", "B"] }),
  });

  assert.deepEqual(lines, [JSON.stringify({ namespace: "demo", keys: ["A", "B"] }, null, 2)]);
});

test("secret list tolerates a response without a keys array", async () => {
  /** @type {string[]} */
  const lines = [];
  await runSecretCommand(["list", "--ns", "demo", "--scope", "ns", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdout: (/** @type {string} */ line) => lines.push(line),
    controlFetch: async () => response({ namespace: "demo" }),
  });
  assert.deepEqual(lines, ["(no secrets)"]);
});

test("secret put reads stdin, trims one newline, and encodes key", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  await runSecretCommand(["put", "--ns", "demo", "--scope", "ns", "KEY/ONE", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok", CONTROL_CONNECT_HOST: "127.0.0.1:18080" },
    stdin: stdinFrom("secret-value\n"),
    stdout: (/** @type {string} */ line) => lines.push(line),
    controlFetch: async (
      /** @type {string} */ url,
      /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
    ) => {
      calls.push({ url, init });
      return response({ deleted: false });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/secrets/KEY%2FONE");
  assert.equal(calls[0].init.method, "PUT");
  assert.equal(calls[0].init.env?.CONTROL_CONNECT_HOST, "127.0.0.1:18080");
  assert.equal(calls[0].init.body, JSON.stringify({ value: "secret-value" }));
  assert.deepEqual(lines, ["✓ demo (ns)/KEY/ONE set — effect on next natural cold-load"]);
});

test("secret put escapes terminal controls from a raw keyArg in the status line", async () => {
  const esc = String.fromCharCode(27);
  /** @type {string[]} */
  const lines = [];
  await runSecretCommand(["put", "--ns", "demo", "--scope", "ns", `KEY${esc}[2J`, "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdin: stdinFrom("v\n"),
    stdout: (/** @type {string} */ line) => lines.push(line),
    controlFetch: async () => response({ deleted: false }),
  });
  assert.equal(lines.length, 1);
  assert.doesNotMatch(lines[0], new RegExp(esc), "raw ESC from keyArg must not reach stdout");
});

test("secret put reads one tty line without waiting for EOF", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const prompts = [];
  const stdin = ttyStdinLine("typed-value\n");
  await runSecretCommand(["put", "--ns", "demo", "--scope", "ns", "KEY", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdin,
    stdout: () => {},
    stderr: (/** @type {string} */ text) => prompts.push(text),
    controlFetch: async (
      /** @type {string} */ url,
      /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
    ) => {
      calls.push({ url, init });
      return response({ deleted: false });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.body, JSON.stringify({ value: "typed-value" }));
  // The prompt, then a newline written when raw (hidden) mode is restored.
  assert.deepEqual(prompts, ["Enter secret value for demo (ns)/KEY (input hidden): ", "\n"]);
  assert.equal(stdin.paused, true);
});

test("secret put reports worker version promotion", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  await runSecretCommand(["put", "--ns", "demo", "--worker", "api", "KEY", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdin: stdinFrom("secret-value\n"),
    stdout: (/** @type {string} */ line) => lines.push(line),
    controlFetch: async (
      /** @type {string} */ url,
      /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
    ) => {
      calls.push({ url, init });
      return response({ previousVersion: "v1", version: "v2" });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/worker/api/secrets/KEY");
  assert.equal(calls[0].init.method, "PUT");
  assert.deepEqual(lines, ["✓ demo/api/KEY set — promoted v1 → v2"]);
});

test("secret put explains env-budget failures as unwritten mutations", async () => {
  await assert.rejects(
    () =>
      runSecretCommand(["put", "--ns", "demo", "--scope", "ns", "KEY", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        stdin: stdinFrom("secret-value\n"),
        controlFetch: async () =>
          response(
            {
              error: "worker_env_too_large",
              message: "env too large",
              source_version: "v2",
              estimated_version: "v9007199254740991",
            },
            400
          ),
      }),
    (err) => {
      const message = /** @type {Error} */ (err).message;
      assert.match(message, /worker_env_too_large/);
      assert.match(message, /secret mutation was not written/);
      assert.match(message, /source_version=v2/);
      assert.match(message, /estimated_version=v9007199254740991/);
      return true;
    }
  );
});

test("secret mutation errors explain retry and operator-repair cases", async () => {
  for (const error of ["secret_mutation_contention", "namespace_secret_mutation_contention"]) {
    await assert.rejects(
      () =>
        runSecretCommand(
          ["delete", "--ns", "demo", "--worker", "api", "KEY", "--yes", "--control-url", "http://ctl.test"],
          {
            env: { ADMIN_TOKEN: "tok" },
            controlFetch: async () =>
              response(
                {
                  error,
                  message: "active version changed",
                },
                503
              ),
          }
        ),
      /Retry after concurrent worker metadata updates settle/
    );
  }
  for (const error of [
    "invalid_envelope",
    "secret_decrypt_failed",
    "secret_encryption_unconfigured",
    "secret_not_encrypted",
    "unsupported_envelope",
    "unknown_kid",
  ]) {
    await assert.rejects(
      () =>
        runSecretCommand(
          ["delete", "--ns", "demo", "--scope", "ns", "KEY", "--yes", "--control-url", "http://ctl.test"],
          {
            env: { ADMIN_TOKEN: "tok" },
            controlFetch: async () =>
              response(
                {
                  error,
                  message: "bad envelope",
                },
                503
              ),
          }
        ),
      /Secret-envelope configuration or stored secret data needs operator repair/
    );
  }
});

test("secret put and delete support raw json output", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const putLines = [];
  await runSecretCommand(
    ["put", "--json", "--ns", "demo", "--worker", "api", "KEY", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdin: stdinFrom("secret-value\n"),
      stdout: (/** @type {string} */ line) => putLines.push(line),
      controlFetch: async (
        /** @type {string} */ url,
        /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
      ) => {
        calls.push({ url, init });
        return response({ previousVersion: "v1", version: "v2" });
      },
    }
  );
  assert.deepEqual(putLines, [JSON.stringify({ previousVersion: "v1", version: "v2" }, null, 2)]);

  /** @type {string[]} */
  const deleteLines = [];
  await runSecretCommand(
    ["delete", "--json", "--ns", "demo", "--worker", "api", "KEY", "--yes", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (/** @type {string} */ line) => deleteLines.push(line),
      controlFetch: async (
        /** @type {string} */ url,
        /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
      ) => {
        calls.push({ url, init });
        return response({ deleted: true, previousVersion: "v2", version: "v3" });
      },
    }
  );
  assert.deepEqual(deleteLines, [JSON.stringify({ deleted: true, previousVersion: "v2", version: "v3" }, null, 2)]);
});

test("secret list refuses ambiguous scope before calling control", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  await assert.rejects(
    () =>
      runSecretCommand(["list", "--ns", "demo", "--control-url", "http://ctl.test"], {
        env: { ADMIN_TOKEN: "tok" },
        controlFetch: async (
          /** @type {string} */ url,
          /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
        ) => {
          calls.push({ url, init });
          return response({});
        },
      }),
    /must specify either --worker <name> \(worker-level\) or --scope ns \(ns-level\)/
  );

  assert.equal(calls.length, 0);
});

test("secret list and delete reject unexpected positional arguments without echoing them", async () => {
  const deps = {
    env: { ADMIN_TOKEN: "tok" },
    controlFetch: async () => {
      throw new Error("controlFetch should not be called");
    },
  };
  for (const args of [
    ["list", "--ns", "demo", "--scope", "ns", "extra"],
    ["delete", "--ns", "demo", "--scope", "ns", "KEY", "extra", "--yes"],
  ]) {
    await assert.rejects(
      () => runSecretCommand(args, deps),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assert.match(message, /received invalid arguments/);
        assert.match(message, /use --help for usage/);
        assert.doesNotMatch(message, /prompt|stdin/);
        assert.doesNotMatch(message, /extra/);
        return true;
      }
    );
  }
});

test("secret delete calls worker endpoint and reports promoted bump", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const lines = [];
  await runSecretCommand(
    ["delete", "--ns", "demo", "--worker", "api", "KEY", "--yes", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (/** @type {string} */ line) => lines.push(line),
      controlFetch: async (
        /** @type {string} */ url,
        /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
      ) => {
        calls.push({ url, init });
        return response({ deleted: true, previousVersion: "v1", version: "v2" });
      },
    }
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/worker/api/secrets/KEY");
  assert.equal(calls[0].init.method, "DELETE");
  assert.deepEqual(lines, ["✓ demo/api/KEY deleted — promoted v1 → v2"]);
});

test("secret delete requires confirmation unless --yes is used", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  await assert.rejects(
    () =>
      runSecretCommand(["delete", "--ns", "demo", "--worker", "api", "KEY", "--control-url", "http://ctl.test"], {
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
    /Refusing to delete secret "demo\/api\/KEY" without interactive confirmation/
  );
  assert.equal(calls.length, 0);
});

test("secret delete proceeds after interactive confirmation", async () => {
  /** @type {ControlCall[]} */
  const calls = [];
  /** @type {string[]} */
  const prompts = [];
  const stdin = ttyStdinLine("y\n");

  await runSecretCommand(["delete", "--ns", "demo", "--scope", "ns", "KEY", "--control-url", "http://ctl.test"], {
    env: { ADMIN_TOKEN: "tok" },
    stdin,
    stderr: (/** @type {string} */ text) => prompts.push(text),
    stdout: () => {},
    controlFetch: async (
      /** @type {string} */ url,
      /** @type {import("../../lib/control-fetch.js").ControlFetchInit} */ init = {}
    ) => {
      calls.push({ url, init });
      return response({ deleted: true });
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "http://ctl.test/ns/demo/secrets/KEY");
  assert.deepEqual(prompts, ['Are you sure you want to delete secret "demo (ns)/KEY"? [y/N] ']);
  assert.equal(stdin.paused, true);
});

test("secret delete ignores obsolete deferred-promote warnings", async () => {
  /** @type {string[]} */
  const lines = [];
  await runSecretCommand(
    ["delete", "--ns", "demo", "--worker", "api", "KEY", "--yes", "--control-url", "http://ctl.test"],
    {
      env: { ADMIN_TOKEN: "tok" },
      stdout: (/** @type {string} */ line) => lines.push(line),
      controlFetch: async () =>
        response({
          deleted: false,
          warnings: [{ kind: "promote_failed", reason: "active version changed", nextPickup: "next deploy" }],
        }),
    }
  );

  assert.deepEqual(lines, ["(KEY was not set)"]);
});

test("secret put rejects sensitive positional and option arguments without echoing them", async () => {
  let read = false;
  let controlCalls = 0;
  const secret = `sk-live-${ESC}[2J\nFORGED\rBAD`;
  for (const value of [secret, `--${secret}`]) {
    await assert.rejects(
      () =>
        runSecretCommand(["put", "--ns", "demo", "--scope", "ns", "KEY", value, "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          stdin: Object.assign(new EventEmitter(), {
            setEncoding() {
              read = true;
            },
          }),
          controlFetch: async () => {
            throw new Error("controlFetch should not be called");
          },
        }),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assertNoRawTerminalControls(message, "secret put argument error");
        assert.doesNotMatch(message, /sk-live|FORGED|BAD/);
        return true;
      }
    );
  }
  for (const args of [
    ["puts", "KEY", `--${secret}`],
    ["--worker", "put", "KEY", `--${secret}`],
    ["--worker", "put", "list", secret],
    ["--worker", "put", "list", `--${secret}`],
    ["--worker", "put", "delete", secret],
    ["--worker", "put", "delete", secret, "--yes"],
  ]) {
    await assert.rejects(
      () =>
        runSecretCommand([...args, "--ns", "demo", "--control-url", "http://ctl.test"], {
          env: { ADMIN_TOKEN: "tok" },
          controlFetch: async () => {
            controlCalls += 1;
            return response({ deleted: true });
          },
        }),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assertNoRawTerminalControls(message, "ambiguous secret argument error");
        assert.doesNotMatch(message, /sk-live|FORGED|BAD/);
        return true;
      }
    );
  }
  await assert.rejects(
    () =>
      runSecretCommand(
        ["delete", "put", "--bogus", "--scope", "ns", "--yes", "--ns", "demo", "--control-url", "http://ctl.test"],
        { env: { ADMIN_TOKEN: "tok" } }
      ),
    /secret received invalid arguments/
  );
  assert.equal(read, false);
  assert.equal(controlCalls, 0);
});
