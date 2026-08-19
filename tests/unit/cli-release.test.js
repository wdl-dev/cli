import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import assert from "node:assert/strict";

const CLI_ROOT = path.resolve(import.meta.dirname, "../..");

test("changelog section extraction gates stable release notes", () => {
  const changelog = readFileSync(path.join(CLI_ROOT, "CHANGELOG.md"), "utf8");
  const stableVersion = /^## (\d+\.\d+\.\d+)\r?$/m.exec(changelog)?.[1];
  assert.ok(stableVersion, "CHANGELOG.md must contain a stable release section");
  const script = path.join(CLI_ROOT, "scripts", "changelog-section.js");
  const current = spawnSync(process.execPath, [script, stableVersion], { cwd: CLI_ROOT, encoding: "utf8" });
  assert.equal(current.status, 0, current.stderr);
  assert.match(current.stdout, /\S/);

  const missing = spawnSync(process.execPath, [script, "0.0.0-missing"], { cwd: CLI_ROOT, encoding: "utf8" });
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /requires a non-empty CHANGELOG\.md section/);

  const emptyDir = mkdtempSync(path.join(tmpdir(), "wdl-release-script-"));
  try {
    const unreadable = spawnSync(process.execPath, [script, stableVersion], { cwd: emptyDir, encoding: "utf8" });
    assert.equal(unreadable.status, 1);
    assert.doesNotMatch(unreadable.stderr, /requires a non-empty CHANGELOG\.md section/);
  } finally {
    rmSync(emptyDir, { recursive: true, force: true });
  }
});
