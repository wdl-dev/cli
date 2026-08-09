import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { collectAssets, MAX_ASSET_FILE_BYTES, resolveAssetsDir } from "../../lib/wrangler/assets.js";
import { collectModules } from "../../lib/wrangler/modules.js";
import { ESC, MODE_BITS_ENFORCED_ONLY, assertNoRawTerminalControls, assertUnreadable } from "./helpers.js";

test("collectModules: drops only top-level README, keeps nested ones", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-collect-"));
  try {
    writeFileSync(path.join(dir, "index.js"), "export default {}");
    writeFileSync(path.join(dir, "README.md"), "wrangler explainer");
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "sub", "README.md"), "# real module");
    writeFileSync(path.join(dir, "sub", "index.js"), "export default 1");
    const out = collectModules(dir);
    assert.ok(out["index.js"], "top-level entry module kept");
    assert.ok(out["sub/index.js"], "nested module kept");
    assert.ok(out["sub/README.md"], "nested README kept");
    assert.strictEqual(out["README.md"], undefined, "top-level README dropped");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectModules: preserves prototype-shaped module names as own manifest keys", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-collect-proto-"));
  try {
    writeFileSync(path.join(dir, "__proto__"), "opaque bytes");
    const out = collectModules(dir);
    assert.equal(Object.hasOwn(out, "__proto__"), true);
    assert.deepEqual(out["__proto__"], {
      data_b64: Buffer.from("opaque bytes").toString("base64"),
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectModules: refuses to follow a symlink in wrangler's outdir", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "wdl-mod-sym-"));
  const outdir = path.join(parent, "out");
  const outside = path.join(parent, "secret");
  const bad = `evil${ESC}[2J\nFORGED\rBAD.js`;
  try {
    mkdirSync(outdir, { recursive: true });
    writeFileSync(outside, "leak");
    symlinkSync(outside, path.join(outdir, bad));
    assert.throws(
      () => collectModules(outdir),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assertNoRawTerminalControls(message, "module symlink diagnostics");
        assert.match(message, /evil\\u001b\[2J\\nFORGED\\rBAD\.js/);
        return true;
      }
    );
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("collectModules: rejects Python Workers modules before upload", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-collect-py-"));
  try {
    writeFileSync(path.join(dir, "index.py"), "export default {}");
    assert.throws(() => collectModules(dir), /Python Workers modules are not supported by WDL \(index\.py\)/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets: recurses and preserves dotfiles as base64", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-"));
  try {
    mkdirSync(path.join(dir, ".well-known"), { recursive: true });
    writeFileSync(path.join(dir, ".well-known", "security.txt"), "contact: ops@example.com");
    mkdirSync(path.join(dir, "img"));
    writeFileSync(path.join(dir, "img", "logo.bin"), Buffer.from([0, 1, 255]));

    const out = collectAssets(dir);
    assert.equal(out[".well-known/security.txt"], Buffer.from("contact: ops@example.com").toString("base64"));
    assert.equal(out["img/logo.bin"], Buffer.from([0, 1, 255]).toString("base64"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets: preserves prototype-shaped asset names as own manifest keys", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-proto-"));
  try {
    writeFileSync(path.join(dir, "__proto__"), "asset bytes");
    const out = collectAssets(dir);
    assert.equal(Object.hasOwn(out, "__proto__"), true);
    assert.equal(out["__proto__"], Buffer.from("asset bytes").toString("base64"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets: rejects a symlinked file inside the assets tree", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "wdl-assets-sym-"));
  const dir = path.join(parent, "public");
  const secret = path.join(parent, "secret.txt");
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(secret, "PRIVATE_KEY_MATERIAL");
    symlinkSync(secret, path.join(dir, "safe.html"));
    assert.throws(() => collectAssets(dir), /symlink not allowed/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("collectAssets: rejects a symlinked subdirectory", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "wdl-assets-symdir-"));
  const dir = path.join(parent, "public");
  const outside = path.join(parent, "sshkeys");
  try {
    mkdirSync(dir, { recursive: true });
    mkdirSync(outside);
    writeFileSync(path.join(outside, "id_rsa"), "PRIVATE_KEY_MATERIAL");
    symlinkSync(outside, path.join(dir, "subdir"));
    assert.throws(() => collectAssets(dir), /symlink not allowed/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("collectAssets: rejects a file that exceeds the per-file cap", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-big-"));
  try {
    writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(MAX_ASSET_FILE_BYTES + 1));
    assert.throws(() => collectAssets(dir), /exceeds .* per-file cap/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets skips repo/tooling artifacts and .env files by default", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-ignore-"));
  try {
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    writeFileSync(path.join(dir, ".env"), "ADMIN_TOKEN=leak");
    writeFileSync(path.join(dir, ".env.production"), "ADMIN_TOKEN=leak");
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main");
    mkdirSync(path.join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "pkg", "x.js"), "x");
    mkdirSync(path.join(dir, ".deploy-dist"), { recursive: true });
    writeFileSync(path.join(dir, ".deploy-dist", "index.js"), "bundled");
    mkdirSync(path.join(dir, ".wrangler"), { recursive: true });
    writeFileSync(path.join(dir, ".wrangler", "state.json"), "{}");
    mkdirSync(path.join(dir, "sub", "node_modules"), { recursive: true });
    writeFileSync(path.join(dir, "sub", "node_modules", "y.js"), "y");
    writeFileSync(path.join(dir, "sub", ".env"), "NESTED=leak");
    writeFileSync(path.join(dir, ".DS_Store"), "junk");

    const out = collectAssets(dir);
    assert.deepEqual(Object.keys(out).toSorted(), ["index.html"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets prunes an ignored symlink instead of rejecting it", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-ignore-link-"));
  const target = mkdtempSync(path.join(tmpdir(), "wdl-assets-ignore-target-"));
  try {
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    symlinkSync(target, path.join(dir, "node_modules"));
    assert.deepEqual(Object.keys(collectAssets(dir)), ["index.html"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(target, { recursive: true, force: true });
  }
});

test("collectAssets honors .assetsignore patterns, negation, and never ships the file itself", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assetsignore-"));
  try {
    writeFileSync(
      path.join(dir, ".assetsignore"),
      [
        "*.map",
        "drafts/",
        "!keep.map",
        "# comment",
        "",
        "!.env", // deliberate re-include of a default ignore
      ].join("\n")
    );
    writeFileSync(path.join(dir, "app.js"), "x");
    writeFileSync(path.join(dir, "app.js.map"), "m");
    writeFileSync(path.join(dir, "keep.map"), "m");
    writeFileSync(path.join(dir, ".env"), "OPT_IN=1");
    mkdirSync(path.join(dir, "drafts"), { recursive: true });
    writeFileSync(path.join(dir, "drafts", "wip.html"), "w");
    mkdirSync(path.join(dir, "nested"), { recursive: true });
    writeFileSync(path.join(dir, "nested", "deep.map"), "m");

    const out = collectAssets(dir);
    assert.deepEqual(Object.keys(out).toSorted(), [".env", "app.js", "keep.map"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets supports fnmatch character classes in .assetsignore", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-class-"));
  try {
    writeFileSync(path.join(dir, ".assetsignore"), "*.py[co]\nlog[0-9].txt\n");
    for (const name of ["a.py", "a.pyc", "a.pyo", "log1.txt", "logx.txt"]) {
      writeFileSync(path.join(dir, name), "x");
    }
    assert.deepEqual(Object.keys(collectAssets(dir)).toSorted(), ["a.py", "logx.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets treats mid-segment `**` as a single-segment `*` per gitignore", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-doublestar-"));
  try {
    writeFileSync(path.join(dir, ".assetsignore"), "a**b\n");
    writeFileSync(path.join(dir, "axxb"), "x");
    mkdirSync(path.join(dir, "art"), { recursive: true });
    writeFileSync(path.join(dir, "art", "web"), "x");
    // `a**b` must not cross the directory boundary: art/web ships, axxb doesn't.
    assert.deepEqual(Object.keys(collectAssets(dir)).toSorted(), ["art/web"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets character classes never match the path separator", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-class-sep-"));
  try {
    writeFileSync(path.join(dir, ".assetsignore"), "a[.-9]b\n[!-x]bc\n");
    mkdirSync(path.join(dir, "a"), { recursive: true });
    writeFileSync(path.join(dir, "a", "b"), "x"); // range .-9 spans "/" — must NOT match across segments
    writeFileSync(path.join(dir, "a.b"), "x"); // in-range, single segment — ignored
    writeFileSync(path.join(dir, "Abc"), "x"); // [!-x]: A is neither "-" nor "x" — ignored
    writeFileSync(path.join(dir, "-bc"), "x"); // literal "-" is in the negated set — kept
    writeFileSync(path.join(dir, "xbc"), "x"); // "x" is in the negated set — kept
    assert.deepEqual(Object.keys(collectAssets(dir)).toSorted(), ["-bc", "a/b", "xbc"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets reports invalid .assetsignore patterns with context", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assetsignore-invalid-"));
  try {
    writeFileSync(path.join(dir, ".assetsignore"), "bad[z-a]\n");
    assert.throws(() => collectAssets(dir), /invalid \.assetsignore pattern "bad\[z-a\]"/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets escapes terminal controls in asset diagnostics", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-diagnostic-escape-"));
  const bad = `bad${ESC}[2J\nFORGED\rBAD`;
  const badPattern = `bad${ESC}[2J\u009b\rBAD`;
  try {
    writeFileSync(path.join(dir, ".assetsignore"), `${badPattern}[z-a]\n`);
    assert.throws(
      () => collectAssets(dir),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assertNoRawTerminalControls(message, "asset ignore diagnostics");
        assert.match(message, /bad\\u001b\[2J\\u009b\\rBAD/);
        return true;
      }
    );

    writeFileSync(path.join(dir, ".assetsignore"), "");
    writeFileSync(path.join(dir, "real.txt"), "x");
    symlinkSync(path.join(dir, "real.txt"), path.join(dir, bad));
    assert.throws(
      () => collectAssets(dir),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assertNoRawTerminalControls(message, "asset path diagnostics");
        assert.match(message, /bad\\u001b\[2J\\nFORGED\\rBAD/);
        return true;
      }
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets wraps native filesystem errors with escaped asset paths", MODE_BITS_ENFORCED_ONLY, () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-fs-escape-"));
  const bad = `blocked${ESC}[2J\nFORGED\rBAD.txt`;
  const file = path.join(dir, bad);
  try {
    writeFileSync(file, "secret");
    chmodSync(file, 0);
    assertUnreadable(file);
    assert.throws(
      () => collectAssets(dir),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assertNoRawTerminalControls(message, "asset filesystem diagnostics");
        assert.match(message, /failed to read/);
        assert.match(message, /blocked\\u001b\[2J\\nFORGED\\rBAD\.txt/);
        return true;
      }
    );
  } finally {
    if (existsSync(file)) chmodSync(file, 0o600);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets skips crash-leftover wdl temp configs by default", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-tmpcfg-"));
  try {
    writeFileSync(path.join(dir, ".wrangler.wdl-tmp-1234.json"), '{"vars":{}}');
    writeFileSync(path.join(dir, "index.html"), "<html></html>");
    assert.deepEqual(Object.keys(collectAssets(dir)), ["index.html"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectAssets reports ignored entries via onIgnore, excluding .assetsignore itself", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "wdl-assets-onignore-"));
  try {
    writeFileSync(path.join(dir, ".assetsignore"), "*.map\n");
    writeFileSync(path.join(dir, "app.js"), "x");
    writeFileSync(path.join(dir, "app.js.map"), "m");
    mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "x.js"), "x");
    /** @type {string[]} */
    const skipped = [];
    collectAssets(dir, {
      onIgnore: (/** @type {string} */ relPath, /** @type {boolean} */ isDir) =>
        skipped.push(isDir ? `${relPath}/` : relPath),
    });
    assert.deepEqual(skipped.toSorted(), ["app.js.map", "node_modules/"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("resolveAssetsDir: rejects a missing, empty, or non-string assets.directory", () => {
  const project = mkdtempSync(path.join(tmpdir(), "wdl-assets-dir-type-"));
  try {
    for (const bad of ["", "   ", 123, true, ["public"], { directory: "public" }, null, undefined]) {
      assert.throws(() => resolveAssetsDir(project, bad), /assets\.directory must be a non-empty string/);
    }
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("resolveAssetsDir: escapes terminal controls in diagnostics", () => {
  const project = mkdtempSync(path.join(tmpdir(), "wdl-assets-dir-escape-"));
  const bad = `missing${ESC}[2J\nFORGED\rBAD`;
  const badConfigRel = `wrangler${ESC}[2J\nFORGED\rBAD.json`;
  try {
    assert.throws(
      () => resolveAssetsDir(project, bad, badConfigRel),
      (err) => {
        const message = /** @type {Error} */ (err).message;
        assertNoRawTerminalControls(message, "assets.directory diagnostics");
        assert.match(message, /wrangler\\u001b\[2J\\nFORGED\\rBAD\.json/);
        assert.match(message, /missing\\u001b\[2J\\nFORGED\\rBAD/);
        return true;
      }
    );
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});

test("resolveAssetsDir: rejects assets.directory that escapes project root", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "wdl-assets-escape-"));
  const project = path.join(parent, "proj");
  try {
    mkdirSync(project, { recursive: true });
    mkdirSync(path.join(parent, "outside"));
    assert.throws(() => resolveAssetsDir(project, "../outside"), /outside the project root/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("resolveAssetsDir: rejects an assets.directory that is itself a symlink", () => {
  const parent = mkdtempSync(path.join(tmpdir(), "wdl-assets-dir-sym-"));
  const project = path.join(parent, "proj");
  try {
    mkdirSync(project, { recursive: true });
    mkdirSync(path.join(parent, "real"));
    symlinkSync(path.join(parent, "real"), path.join(project, "public"));
    assert.throws(() => resolveAssetsDir(project, "public"), /must not be a symlink/);
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test("resolveAssetsDir: accepts a directory that is inside project root", () => {
  const project = mkdtempSync(path.join(tmpdir(), "wdl-assets-ok-"));
  try {
    mkdirSync(path.join(project, "public"));
    const resolved = resolveAssetsDir(project, "public");
    assert.equal(resolved, path.join(project, "public"));
  } finally {
    rmSync(project, { recursive: true, force: true });
  }
});
