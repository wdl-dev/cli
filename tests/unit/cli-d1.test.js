import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runD1Command } from "../../commands/d1.js";
import { LONG_CONTROL_TIMEOUT_MS } from "../../lib/control-fetch.js";
import { mockDeps as sharedMockDeps, response } from "./helpers.js";

// d1 commands resolve the namespace from WDL_NS, so the shared factory gets a
// richer env than its bare-token default.
const mockDeps = (body) => sharedMockDeps(body, { ADMIN_TOKEN: "tok", WDL_NS: "demo" });

test("d1 list calls the namespace database endpoint", async () => {
  const { calls, lines, deps } = mockDeps({
    databases: [{ databaseId: "d1_main", databaseName: "main", createdAt: "today" }],
  });

  await runD1Command(["list", "--control-url", "http://ctl.test"], deps);

  assert.equal(calls[0].url, "http://ctl.test/ns/demo/d1/databases");
  assert.deepEqual(calls[0].init.headers, { "x-admin-token": "tok" });
  assert.deepEqual(lines, ["d1_main\tname=main\tcreated=today"]);
});

test("d1 positional help prints help without resolving control", async () => {
  const lines = [];
  await runD1Command(["help"], {
    env: {},
    stdout: (line) => lines.push(line),
    controlFetch: async () => {
      throw new Error("controlFetch should not be called");
    },
  });

  assert.equal(lines.length, 1);
  assert.match(lines[0], /wdl d1 create/);
  assert.match(lines[0], /Manage platform D1 databases/);
});

test("d1 list accepts flags before the subcommand", async () => {
  const { calls, lines, deps } = mockDeps({
    databases: [{ databaseId: "d1_main", databaseName: "main", createdAt: "today" }],
  });

  await runD1Command(["--control-url", "http://ctl.test", "list"], deps);

  assert.equal(calls[0].url, "http://ctl.test/ns/demo/d1/databases");
  assert.deepEqual(lines, ["d1_main\tname=main\tcreated=today"]);
});

test("d1 create posts a database name", async () => {
  const { calls, lines, deps } = mockDeps({
    namespace: "demo",
    databaseId: "d1_main",
    databaseName: "main",
  });

  await runD1Command(["create", "main", "--control-url", "http://ctl.test"], deps);

  assert.equal(calls[0].init.method, "POST");
  assert.deepEqual(JSON.parse(calls[0].init.body), { databaseName: "main" });
  assert.deepEqual(lines, ["OK demo/d1_main created name=main"]);
});

test("d1 execute sends SQL mode and JSON params", async () => {
  const { calls, lines, deps } = mockDeps({ result: { results: [{ n: 1 }] } });

  await runD1Command([
    "execute",
    "main",
    "--sql",
    "select ? as n",
    "--params",
    "[1]",
    "--mode",
    "all",
    "--control-url",
    "http://ctl.test",
  ], deps);

  assert.equal(calls[0].url, "http://ctl.test/ns/demo/d1/databases/main/query");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.timeoutMs, LONG_CONTROL_TIMEOUT_MS);
  assert.deepEqual(JSON.parse(calls[0].init.body), {
    sql: "select ? as n",
    mode: "all",
    params: [1],
  });
  assert.deepEqual(lines, ['{\n  "results": [\n    {\n      "n": 1\n    }\n  ]\n}']);
});

test("d1 migrations apply reads sorted SQL files from --dir", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-d1-migrations-"));
  try {
    const migrations = path.join(dir, "migrations");
    mkdirSync(migrations);
    writeFileSync(path.join(migrations, "002_add.sql"), "alter table users add column name text;");
    writeFileSync(path.join(migrations, "001_init.sql"), "create table users (id integer);");

    const calls = [];
    const lines = [];
    await runD1Command([
      "migrations",
      "apply",
      "main",
      "--dir",
      "migrations",
      "--control-url",
      "http://ctl.test",
    ], {
      cwd: dir,
      env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
      stdout: (line) => lines.push(line),
      controlFetch: async (url, init = {}) => {
        calls.push({ url, init });
        return response({ applied: [{ id: "001_init.sql", statementCount: 1 }], skipped: [] });
      },
    });

    assert.equal(calls[0].url, "http://ctl.test/ns/demo/d1/databases/main/migrations/apply");
    assert.equal(calls[0].init.timeoutMs, LONG_CONTROL_TIMEOUT_MS);
    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.migrations.map((migration) => migration.id), [
      "001_init.sql",
      "002_add.sql",
    ]);
    assert.equal(body.migrations[0].sql, "create table users (id integer);");
    assert.match(body.migrations[0].checksum, /^[a-f0-9]{64}$/);
    assert.deepEqual(lines, ["Applied 001_init.sql\tstatements=1"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("d1 migrations_dir from wrangler config cannot escape the project", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-d1-contained-"));
  const outside = mkdtempSync(path.join(tmpdir(), "wdl-d1-outside-"));
  try {
    writeFileSync(path.join(outside, "001_leak.sql"), "select 'leak';");
    writeFileSync(path.join(dir, "wrangler.toml"), [
      'name = "api"',
      'main = "src/index.js"',
      "",
      "[[d1_databases]]",
      'binding = "DB"',
      'database_name = "main"',
      `migrations_dir = ${JSON.stringify(path.relative(dir, outside))}`,
      "",
    ].join("\n"));

    const calls = [];
    await assert.rejects(
      () => runD1Command([
        "migrations",
        "apply",
        "main",
        "--control-url",
        "http://ctl.test",
      ], {
        cwd: dir,
        env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
        controlFetch: async (url, init = {}) => {
          calls.push({ url, init });
          return response({});
        },
      }),
      /migrations_dir must stay inside the project/
    );
    assert.equal(calls.length, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("d1 migrations --dir cannot escape the project", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-d1-dir-contained-"));
  const outside = mkdtempSync(path.join(tmpdir(), "wdl-d1-dir-outside-"));
  try {
    writeFileSync(path.join(outside, "001_leak.sql"), "select 'leak';");
    await assert.rejects(
      () => runD1Command([
        "migrations",
        "apply",
        "main",
        "--dir",
        path.relative(dir, outside),
        "--control-url",
        "http://ctl.test",
      ], {
        cwd: dir,
        env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
        stdin: { isTTY: false },
        stdout: () => {},
        controlFetch: async () => {
          throw new Error("controlFetch should not be called");
        },
      }),
      /--dir must stay inside the project/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("d1 migrations apply orders unpadded numeric prefixes numerically", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-d1-numeric-sort-"));
  try {
    const migrations = path.join(dir, "migrations");
    mkdirSync(migrations);
    for (const name of ["10_ten.sql", "1_init.sql", "2_two.sql"]) {
      writeFileSync(path.join(migrations, name), `-- ${name}`);
    }

    const calls = [];
    await runD1Command([
      "migrations", "apply", "main", "--dir", "migrations", "--control-url", "http://ctl.test",
    ], {
      cwd: dir,
      env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
      stdout: () => {},
      controlFetch: async (url, init = {}) => {
        calls.push({ url, init });
        return response({ applied: [], skipped: [] });
      },
    });

    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.migrations.map((m) => m.id), [
      "1_init.sql",
      "2_two.sql",
      "10_ten.sql",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("d1 migrations --dir accepts a project subdirectory whose name starts with dots", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-d1-dotdot-name-"));
  try {
    const migrations = path.join(dir, "..hidden");
    mkdirSync(migrations);
    writeFileSync(path.join(migrations, "0001_init.sql"), "create table t (id integer);");

    const calls = [];
    await runD1Command([
      "migrations", "apply", "main", "--dir", "..hidden", "--control-url", "http://ctl.test",
    ], {
      cwd: dir,
      env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
      stdout: () => {},
      controlFetch: async (url, init = {}) => {
        calls.push({ url, init });
        return response({ applied: [], skipped: [] });
      },
    });

    const body = JSON.parse(calls[0].init.body);
    assert.deepEqual(body.migrations.map((m) => m.id), ["0001_init.sql"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("d1 execute --file rejects a path outside the project", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-d1-file-escape-"));
  try {
    await assert.rejects(
      () => runD1Command(["execute", "main", "--file", "../outside.sql", "--control-url", "http://ctl.test"], {
        cwd: dir,
        env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
        stdout: () => {},
        controlFetch: async () => response({}),
      }),
      /--file must stay inside the project/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("d1 execute rejects an unknown --mode before calling control", async () => {
  let fetched = false;
  await assert.rejects(
    () => runD1Command(["execute", "main", "--sql", "SELECT 1", "--mode", "bogus", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
      stdout: () => {},
      controlFetch: async () => { fetched = true; return response({}); },
    }),
    /--mode must be one of/
  );
  assert.equal(fetched, false);
});

test("d1 execute rejects --mode exec with --params before calling control", async () => {
  let fetched = false;
  await assert.rejects(
    () => runD1Command(["execute", "main", "--sql", "SELECT 1", "--mode", "exec", "--params", "[1]", "--control-url", "http://ctl.test"], {
      env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
      stdout: () => {},
      controlFetch: async () => { fetched = true; return response({}); },
    }),
    /--mode exec does not accept --params/
  );
  assert.equal(fetched, false);
});

test("d1 migrations status reports an empty migrations dir like apply", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-d1-status-empty-"));
  try {
    mkdirSync(path.join(dir, "migrations"));
    await assert.rejects(
      () => runD1Command(["migrations", "status", "main", "--dir", "migrations", "--control-url", "http://ctl.test"], {
        cwd: dir,
        env: { ADMIN_TOKEN: "tok", WDL_NS: "demo" },
        stdout: () => {},
        controlFetch: async () => response({}),
      }),
      /no \.sql migration files found/
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
