import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("cli package exposes only the wdl binary", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
  assert.deepEqual(pkg.bin, {
    wdl: "bin/wdl.js",
  });
});

test("cli source imports stay inside the package and its declared dependencies", () => {
  const root = fileURLToPath(new URL("../../", import.meta.url));
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  const allowedBare = new Set(Object.keys(pkg.dependencies || {}));
  const offenders = [];
  for (const file of listCliJsFiles(root)) {
    const source = readFileSync(file, "utf8");
    for (const specifier of importSpecifiers(source)) {
      if (specifier.startsWith(".")) {
        const target = path.resolve(path.dirname(file), specifier);
        const rel = path.relative(root, target);
        if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
          offenders.push(`${path.relative(root, file)} -> ${specifier}`);
        }
        continue;
      }
      if (!specifier.startsWith("node:") && !allowedBare.has(specifier)) {
        offenders.push(`${path.relative(root, file)} -> ${specifier}`);
      }
    }
  }
  assert.deepEqual(offenders, []);
});

/** @param {string} source */
function importSpecifiers(source) {
  /** @type {string[]} */
  const specs = [];
  const patterns = [
    /^\s*(?:import|export)\s+(?:[^"'()]*?\s+from\s+)?["']([^"']+)["']/gm,
    /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) specs.push(/** @type {string} */ (match[1]));
  }
  return specs;
}

/** @param {string} root */
function listCliJsFiles(root) {
  /** @type {string[]} */
  const out = [];
  for (const dir of ["bin", "commands", "lib"]) {
    out.push(...listJsFiles(path.join(root, dir)));
  }
  return out;
}

/**
 * @param {string} dir
 * @returns {string[]}
 */
function listJsFiles(dir) {
  /** @type {string[]} */
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listJsFiles(full));
    else if (entry.isFile() && entry.name.endsWith(".js")) out.push(full);
  }
  return out;
}
