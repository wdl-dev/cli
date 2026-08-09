import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main as wdlMain } from "../../bin/wdl.js";
import { ESC, assertNoRawTerminalControls } from "./helpers.js";

/**
 * The options bag the dispatcher passes to an injected `loadEnv`. Matches the
 * third parameter of `loadCliDotEnv`.
 * @typedef {NonNullable<Parameters<typeof import("../../lib/credentials.js").loadCliDotEnv>[2]>} LoadEnvOptions
 */

/**
 * The `loadEnv` override shape accepted by `wdlMain`. The test fakes record the
 * options and otherwise ignore the contract return value.
 * @typedef {typeof import("../../lib/credentials.js").loadCliDotEnv} LoadEnvFn
 */

test("wdl dispatcher routes documented commands and rejects unknown commands", async () => {
  const oldExit = process.exit;
  const oldError = console.error;
  const oldLog = console.log;
  /** @type {string[]} */
  const seen = [];

  process.exit = (code) => {
    throw new Error(`exit:${code}`);
  };
  console.error = (msg) => seen.push(String(msg));
  console.log = (msg) => seen.push(String(msg));

  try {
    await assert.rejects(() => wdlMain(["help"], { loadEnv: null }), /exit:0/);
    assert.ok(/** @type {string} */ (seen.at(-1)).includes("wdl <command> [args] [options]"));
    // Top-level help must list the common control flags too, matching command
    // help — --no-token-store was missing here once.
    assert.ok(
      /** @type {string} */ (seen.at(-1)).includes("--no-token-store"),
      "top-level help lists --no-token-store"
    );
    // The command table is derived from each command's { name, summary }; assert
    // the metadata content renders (and the alias note) without pinning column spacing.
    assert.ok(/** @type {string} */ (seen.at(-1)).includes("Manage D1 databases, SQL execution, and migrations."));
    assert.ok(
      /** @type {string} */ (seen.at(-1)).includes("Manage namespace-level or worker-level secrets. (alias: secrets)")
    );
    assert.ok(/** @type {string} */ (seen.at(-1)).includes("Inspect and delete R2 virtual bucket data."));
    assert.ok(/** @type {string} */ (seen.at(-1)).includes("Live-tail worker console output and uncaught exceptions."));
    // workflows is the widest name, so its summary sits one space after it.
    assert.ok(/** @type {string} */ (seen.at(-1)).includes("workflows Inspect and control Workflow instances."));

    await assert.rejects(() => wdlMain(["del"], { loadEnv: null }), /exit:1/);
    assert.ok(seen.some((line) => line.includes("unknown command: del")));

    await assert.rejects(() => wdlMain(["worker-list"], { loadEnv: null }), /exit:1/);
    assert.ok(seen.some((line) => line.includes("unknown command: worker-list")));

    await assert.rejects(() => wdlMain(["toString"], { loadEnv: null }), /exit:1/);
    assert.ok(seen.some((line) => line.includes("unknown command: toString")));
    await assert.rejects(() => wdlMain(["help", "toString"], { loadEnv: null }), /exit:1/);
    assert.ok(seen.some((line) => line.includes("unknown help topic: toString")));
    assert.doesNotMatch(seen.join("\n"), /TypeError|COMMANDS\[|\.main/);
  } finally {
    process.exit = oldExit;
    console.error = oldError;
    console.log = oldLog;
  }
});

test("wdl help <command> prints that command help", async () => {
  const oldLog = console.log;
  /** @type {string[]} */
  const lines = [];
  console.log = (msg) => lines.push(String(msg));
  try {
    await wdlMain(["help", "r2"], { loadEnv: null });
  } finally {
    console.log = oldLog;
  }
  assert.match(lines.join("\n"), /wdl r2 objects get <bucket> <key>/);
  assert.doesNotMatch(lines.join("\n"), /wdl <command> \[args\]/);
});

test("wdl dispatcher prints the CLI version for --version, -v, and version", async () => {
  const oldLog = console.log;
  /** @type {string[]} */
  const lines = [];
  console.log = (msg) => lines.push(String(msg));
  try {
    await wdlMain(["--version"], { loadEnv: null });
    await wdlMain(["-v"], { loadEnv: null });
    await wdlMain(["version"], { loadEnv: null });
  } finally {
    console.log = oldLog;
  }
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.deepEqual(lines, [pkg.version, pkg.version, pkg.version]);
});

// Stub process.exit (throws `exit:<code>`) and capture console.error lines
// for dispatcher-level tests that drive bin/wdl.js end to end.
/** @param {(errors: string[]) => Promise<void>} fn */
async function withMockedExit(fn) {
  const oldExit = process.exit;
  const oldError = console.error;
  /** @type {string[]} */
  const errors = [];
  process.exit = (code) => {
    throw new Error(`exit:${code}`);
  };
  console.error = (msg) => errors.push(String(msg));
  try {
    await fn(errors);
  } finally {
    process.exit = oldExit;
    console.error = oldError;
  }
  return errors;
}

test("wdl dispatcher loads base dotenv before namespace section overlay", async () => {
  /** @type {LoadEnvOptions[]} */
  const calls = [];
  // secret's missing-subcommand CliError fires after autoload, keeping the
  // dispatch harmless without needing a control-plane mock.
  await withMockedExit(async () => {
    await assert.rejects(
      () =>
        wdlMain(["secret", "--ns", "demo"], {
          env: {},
          loadEnv: /** @type {LoadEnvFn} */ (
            /** @type {unknown} */ (
              (
                /** @type {NodeJS.ProcessEnv | undefined} */ _env,
                /** @type {string | undefined} */ _path,
                /** @type {LoadEnvOptions} */ options
              ) => calls.push(options)
            )
          ),
        }),
      /exit:1/
    );
  });

  assert.equal(calls.length, 2);
  assert.deepEqual(
    calls.map(({ loadBase, resolvedNs }) => ({ loadBase, resolvedNs })),
    [
      { loadBase: undefined, resolvedNs: undefined },
      { loadBase: false, resolvedNs: "demo" },
    ]
  );
  assert.equal(calls[0].protectedKeys, calls[1].protectedKeys);
});

test("wdl dispatcher overlays the LAST --ns occurrence, matching parseArgs", async () => {
  /** @type {LoadEnvOptions[]} */
  const calls = [];
  await withMockedExit(async () => {
    await assert.rejects(
      () =>
        wdlMain(["secret", "--ns", "first", "--ns=last"], {
          env: {},
          loadEnv: /** @type {LoadEnvFn} */ (
            /** @type {unknown} */ (
              (
                /** @type {NodeJS.ProcessEnv | undefined} */ _env,
                /** @type {string | undefined} */ _path,
                /** @type {LoadEnvOptions} */ options
              ) => calls.push(options)
            )
          ),
        }),
      /exit:1/
    );
  });

  assert.equal(calls.length, 2);
  assert.equal(calls[1].resolvedNs, "last");
});

test("wdl dispatcher skips dotenv when help is requested", async () => {
  /** @type {LoadEnvOptions[]} */
  const calls = [];
  const oldLog = console.log;
  console.log = () => {};
  try {
    await wdlMain(["workers", "--ns", "demo", "--help"], {
      env: {},
      loadEnv: /** @type {LoadEnvFn} */ (
        /** @type {unknown} */ (
          (
            /** @type {NodeJS.ProcessEnv | undefined} */ _env,
            /** @type {string | undefined} */ _path,
            /** @type {LoadEnvOptions} */ options
          ) => calls.push(options)
        )
      ),
    });
    // The positional alias form must skip autoload too — including with
    // flags present — so a broken .env cannot block `wdl <command> help`.
    await wdlMain(["workers", "help"], {
      env: {},
      loadEnv: /** @type {LoadEnvFn} */ (
        /** @type {unknown} */ (
          (
            /** @type {NodeJS.ProcessEnv | undefined} */ _env,
            /** @type {string | undefined} */ _path,
            /** @type {LoadEnvOptions} */ options
          ) => calls.push(options)
        )
      ),
    });
    await wdlMain(["workers", "--ns", "demo", "help"], {
      env: {},
      loadEnv: /** @type {LoadEnvFn} */ (
        /** @type {unknown} */ (
          (
            /** @type {NodeJS.ProcessEnv | undefined} */ _env,
            /** @type {string | undefined} */ _path,
            /** @type {LoadEnvOptions} */ options
          ) => calls.push(options)
        )
      ),
    });
  } finally {
    console.log = oldLog;
  }
  assert.deepEqual(calls, []);
});

test("wdl dispatcher reports a malformed .env without a Node stack", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-dispatch-env-"));
  const oldCwd = process.cwd();
  let errors;
  try {
    process.chdir(dir);
    writeFileSync(path.join(dir, ".env"), "CONTROL_URL\n");
    errors = await withMockedExit(async () => {
      await assert.rejects(() => wdlMain(["workers", "--ns", "demo"], {}), /exit:1/);
    });
  } finally {
    process.chdir(oldCwd);
    rmSync(dir, { recursive: true, force: true });
  }

  assert.equal(errors.length, 1);
  assert.match(errors[0], /error: Invalid \.env line 1: expected KEY=value/);
  assert.doesNotMatch(errors[0], /at |Node\.js/);
});

test("wdl dispatcher skips dotenv for top-level help and unknown commands", async () => {
  const oldExit = process.exit;
  const oldError = console.error;
  const oldLog = console.log;
  /** @type {string[]} */
  const errors = [];
  /** @type {string[]} */
  const calls = [];

  process.exit = (code) => {
    throw new Error(`exit:${code}`);
  };
  console.error = (msg) => errors.push(String(msg));
  console.log = () => {};

  try {
    await assert.rejects(
      () =>
        wdlMain(["help"], {
          loadEnv: /** @type {LoadEnvFn} */ (/** @type {unknown} */ (() => calls.push("help"))),
        }),
      /exit:0/
    );
    await assert.rejects(
      () =>
        wdlMain(["bogus"], {
          loadEnv: /** @type {LoadEnvFn} */ (/** @type {unknown} */ (() => calls.push("bogus"))),
        }),
      /exit:1/
    );
    await assert.rejects(
      () =>
        wdlMain([`bad${ESC}[2J\nFORGED\rBAD`], {
          loadEnv: /** @type {LoadEnvFn} */ (/** @type {unknown} */ (() => calls.push("bad"))),
        }),
      /exit:1/
    );
    assert.deepEqual(calls, []);
    assert.ok(errors.some((line) => line.includes("unknown command: bogus")));
    const escaped = errors.find((line) => line.includes("unknown command: bad"));
    assert.ok(escaped);
    assertNoRawTerminalControls(escaped, "unknown-command errors");
    assert.match(escaped, /bad\\u001b\[2J\\nFORGED\\rBAD/);
  } finally {
    process.exit = oldExit;
    console.error = oldError;
    console.log = oldLog;
  }
});

test("wdl dispatcher prints parseArgs errors without a Node stack", async () => {
  const oldExit = process.exit;
  const oldError = console.error;
  /** @type {string[]} */
  const errors = [];

  process.exit = (code) => {
    throw new Error(`exit:${code}`);
  };
  console.error = (msg) => errors.push(String(msg));

  try {
    await assert.rejects(() => wdlMain(["tail", `--dsf${ESC}[2J\nFORGED\rBAD`], { loadEnv: null }), /exit:1/);
  } finally {
    process.exit = oldExit;
    console.error = oldError;
  }

  assert.equal(errors.length, 1);
  assert.match(errors[0], /error: Unknown option '--dsf\\u001b\[2J\\nFORGED\\rBAD'/);
  assertNoRawTerminalControls(errors[0], "parseArgs errors");
  assert.doesNotMatch(errors[0], /TypeError|parse_args|Node\.js/);
});
