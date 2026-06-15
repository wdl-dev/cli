import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main, __test__ } from "../../commands/init.js";

const { parseArgs, validateNs, validateWorker, resolveWdlCliDep } = __test__;
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function withTempCwd(fn) {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-init-test-"));
  const previous = process.cwd();
  process.chdir(dir);
  try {
    return await fn(dir);
  } finally {
    process.chdir(previous);
    rmSync(dir, { recursive: true, force: true });
  }
}

async function captureExit(fn) {
  let exitCode = null;
  let errOutput = "";
  const originalExit = process.exit;
  const originalErr = process.stderr.write.bind(process.stderr);
  process.exit = (code) => { exitCode = code; throw new Error("__test_exit__"); };
  process.stderr.write = (chunk) => { errOutput += chunk; return true; };
  try {
    await fn();
  } catch (err) {
    if (err.message !== "__test_exit__") throw err;
  } finally {
    process.exit = originalExit;
    process.stderr.write = originalErr;
  }
  return { exitCode, errOutput };
}

test("parseArgs accepts --ns and --worker in both forms", () => {
  assert.deepEqual(
    parseArgs(["demo", "--ns", "acme", "--worker", "feature"]),
    { target: "demo", ns: "acme", worker: "feature", help: false },
  );
  assert.deepEqual(
    parseArgs(["demo", "--ns=acme", "--worker=feature"]),
    { target: "demo", ns: "acme", worker: "feature", help: false },
  );
});

test("parseArgs accepts positional help alias", () => {
  assert.deepEqual(
    parseArgs(["help"]),
    { target: null, ns: null, worker: null, help: true },
  );
});

test("parseArgs rejects unknown flags", () => {
  assert.throws(() => parseArgs(["demo", "--unknown"]), /unknown flag/);
});

test("validateNs rejects names that fail the tenant grammar", () => {
  assert.throws(() => validateNs("ACME", "--ns"), /not a valid tenant namespace/);
  assert.throws(() => validateNs("admin", "--ns"), /not a valid tenant namespace/);
  assert.throws(() => validateNs("ns with space", "--ns"), /not a valid tenant namespace/);
  assert.throws(() => validateNs("-bad", "--ns"), /start and end with a letter or digit/);
  assert.throws(() => validateNs("bad-", "--ns"), /start and end with a letter or digit/);
  assert.throws(() => validateNs("a".repeat(64), "--ns"), /1-63 lowercase/);
});

test("validateNs accepts lowercase + digits + hyphens", () => {
  assert.doesNotThrow(() => validateNs("acme", "--ns"));
  assert.doesNotThrow(() => validateNs("acme-1", "--ns"));
  assert.doesNotThrow(() => validateNs("a".repeat(63), "--ns"));
});

test("validateWorker rejects names that fail the worker grammar", () => {
  assert.throws(() => validateWorker("-starts-with-hyphen", "--worker"), /must match/);
  assert.throws(() => validateWorker("contains.dot", "--worker"), /must match/);
  assert.throws(() => validateWorker("contains/slash", "--worker"), /must match/);
});

test("validateWorker accepts letters digits underscores and hyphens", () => {
  assert.doesNotThrow(() => validateWorker("1starts-with-digit", "--worker"));
  assert.doesNotThrow(() => validateWorker("UpperCase", "--worker"));
  assert.doesNotThrow(() => validateWorker("my_worker", "--worker"));
  assert.doesNotThrow(() => validateWorker("My_Worker-2", "--worker"));
});

test("resolveWdlCliDep returns file: protocol when WDL_CLI_LOCAL_PATH is set", async () => {
  const dep = await resolveWdlCliDep({ WDL_CLI_LOCAL_PATH: "/opt/wdl-cli" });
  assert.equal(dep, "file:/opt/wdl-cli");
});

test("resolveWdlCliDep falls back to published version when env is empty", async () => {
  for (const env of [{}, { WDL_CLI_LOCAL_PATH: "" }, { WDL_CLI_LOCAL_PATH: undefined }]) {
    const dep = await resolveWdlCliDep(env);
    assert.match(dep, /^\^\d+\.\d+\.\d+/);
  }
});

test("init writes file: dep when WDL_CLI_LOCAL_PATH is set", async () => {
  const previous = process.env.WDL_CLI_LOCAL_PATH;
  process.env.WDL_CLI_LOCAL_PATH = "/opt/wdl-cli";
  try {
    await withTempCwd(async (cwd) => {
      await main(["demo", "--ns", "acme"]);
      const pkg = JSON.parse(readFileSync(path.join(cwd, "demo", "package.json"), "utf8"));
      assert.equal(pkg.devDependencies["@wdl-dev/cli"], "file:/opt/wdl-cli");
    });
  } finally {
    if (previous === undefined) delete process.env.WDL_CLI_LOCAL_PATH;
    else process.env.WDL_CLI_LOCAL_PATH = previous;
  }
});

test("init scaffolds files with --ns and --worker", async () => {
  await withTempCwd(async (cwd) => {
    await main(["demo", "--ns", "acme", "--worker", "site"]);

    const projectDir = path.join(cwd, "demo");
    const pkg = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8"));
    const cliPkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    assert.equal(pkg.name, "demo");
    assert.equal(pkg.scripts.deploy, "wdl deploy . --ns acme");
    assert.equal(pkg.scripts["deploy:prod"], undefined);
    assert.equal(pkg.devDependencies.wrangler, cliPkg.dependencies.wrangler);
    assert.ok(pkg.devDependencies["@wdl-dev/cli"]);

    const wranglerJsonc = readFileSync(path.join(projectDir, "wrangler.jsonc"), "utf8");
    assert.match(wranglerJsonc, /"name":\s*"site"/);
    assert.match(wranglerJsonc, /"compatibility_date":\s*"2026-05-31"/);
    assert.doesNotMatch(wranglerJsonc, /"env"/);

    const indexJs = readFileSync(path.join(projectDir, "src", "index.js"), "utf8");
    assert.match(indexJs, /Hello from site/);

    const agents = readFileSync(path.join(projectDir, "AGENTS.md"), "utf8");
    assert.match(agents, /node_modules\/@wdl-dev\/cli\/docs/);

    const claudeMd = readFileSync(path.join(projectDir, "CLAUDE.md"), "utf8");
    assert.equal(claudeMd, "See AGENTS.md.\n");

    const gitignore = readFileSync(path.join(projectDir, ".gitignore"), "utf8");
    assert.match(gitignore, /^\.wrangler\.wdl-tmp\*\.json$/m);
  });
});

test("init defaults --worker to the target dir name when not provided", async () => {
  await withTempCwd(async (cwd) => {
    await main(["demo", "--ns", "acme"]);
    const wranglerJsonc = readFileSync(path.join(cwd, "demo", "wrangler.jsonc"), "utf8");
    assert.match(wranglerJsonc, /"name":\s*"demo"/);
  });
});

test("init accepts a mixed-case project name end to end", async () => {
  await withTempCwd(async (cwd) => {
    await main(["MyApp", "--ns", "acme"]);

    const projectDir = path.join(cwd, "MyApp");
    const pkg = JSON.parse(readFileSync(path.join(projectDir, "package.json"), "utf8"));
    assert.equal(pkg.name, "MyApp");
    assert.equal(pkg.scripts.deploy, "wdl deploy . --ns acme");

    const wranglerJsonc = readFileSync(path.join(projectDir, "wrangler.jsonc"), "utf8");
    assert.match(wranglerJsonc, /"name":\s*"MyApp"/);

    const indexJs = readFileSync(path.join(projectDir, "src", "index.js"), "utf8");
    assert.match(indexJs, /Hello from MyApp/);
  });
});

test("init scaffolds without --ns; the deploy script omits the namespace", async () => {
  await withTempCwd(async (cwd) => {
    await main(["demo"]);
    const pkg = JSON.parse(readFileSync(path.join(cwd, "demo", "package.json"), "utf8"));
    assert.equal(pkg.scripts.deploy, "wdl deploy .");
  });
});

test("init positional help prints usage to stdout and exits successfully", async () => {
  await withTempCwd(async () => {
    const logs = [];
    const oldLog = console.log;
    console.log = (msg) => logs.push(String(msg));
    let exitCode;
    try {
      ({ exitCode } = await captureExit(() => main(["help"])));
    } finally {
      console.log = oldLog;
    }
    assert.equal(exitCode, 0);
    assert.match(logs.join("\n"), /wdl init <target>/);
  });
});

test("init exits with an error when --ns is invalid", async () => {
  await withTempCwd(async () => {
    const { exitCode, errOutput } = await captureExit(() => main(["demo", "--ns", "ACME"]));
    assert.equal(exitCode, 1);
    assert.match(errOutput, /not a valid tenant namespace/);
  });
});

test("init rejects operator-reserved namespace shapes", async () => {
  await withTempCwd(async () => {
    const { exitCode, errOutput } = await captureExit(() => main(["demo", "--ns", "__SYS__"]));
    assert.equal(exitCode, 1);
    assert.match(errOutput, /reserved names are not allowed/);
  });
});

test("init refuses to overwrite a non-empty target", async () => {
  await withTempCwd(async (cwd) => {
    const dir = path.join(cwd, "demo");
    mkdirSync(dir);
    writeFileSync(path.join(dir, "existing.txt"), "");

    const { exitCode, errOutput } = await captureExit(() =>
      main(["demo", "--ns", "acme", "--worker", "site"])
    );
    assert.equal(exitCode, 1);
    assert.match(errOutput, /is not empty/);
  });
});
