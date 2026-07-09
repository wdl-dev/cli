import { existsSync, lstatSync, readFileSync, realpathSync, readdirSync } from "node:fs";
import path from "node:path";
import { escapeTerminalText, formatDiagnosticValue } from "../output.js";
import { WRANGLER_WDL_TMP_IGNORE_PATTERN } from "./config.js";
import { manifestMap } from "./utils.js";

export const MAX_ASSET_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_ASSETS_TOTAL_BYTES = 100 * 1024 * 1024;

export const ASSETS_IGNORE_FILENAME = ".assetsignore";

// Cloudflare's Workers Assets ignores only its own metafiles by default and
// reads user patterns from `.assetsignore` (gitignore syntax). WDL keeps that
// mechanism and additionally skips repo/tooling artifacts and .env credential
// files by default; a `!pattern` line in .assetsignore can deliberately
// re-include anything here (last match wins).
const DEFAULT_ASSET_IGNORE_PATTERNS = [
  `/${ASSETS_IGNORE_FILENAME}`,
  "**/.git",
  "**/node_modules",
  "**/.DS_Store",
  "/.wrangler",
  "/.deploy-dist",
  WRANGLER_WDL_TMP_IGNORE_PATTERN,
  "**/.env",
  "**/.env.*",
];

/** @param {string} configRel */
function formatConfigRel(configRel) {
  return escapeTerminalText(configRel);
}

/**
 * @param {string} action
 * @param {string} relPath
 * @param {unknown} err
 * @returns {Error}
 */
function assetFsError(action, relPath, err) {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`assets: failed to ${action} ${formatDiagnosticValue(relPath)}: ${escapeTerminalText(message)}`, {
    cause: err,
  });
}

/**
 * @param {string} configRel
 * @param {string} action
 * @param {unknown} assetsDirRel
 * @param {unknown} err
 * @returns {Error}
 */
function assetsDirFsError(configRel, action, assetsDirRel, err) {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(
    `${configRel} assets.directory ${formatDiagnosticValue(assetsDirRel)} failed to ${action}: ${escapeTerminalText(message)}`,
    { cause: err }
  );
}

/**
 * @param {string} absProject
 * @param {unknown} assetsDirRel  Raw config value; validated as a non-empty string here.
 * @param {string} [configRel]
 * @returns {string}
 */
export function resolveAssetsDir(absProject, assetsDirRel, configRel = "wrangler config") {
  configRel = formatConfigRel(configRel);
  // Fail loudly on a malformed `assets.directory` instead of letting a non-string
  // hit path.resolve as a low-level TypeError, or an empty string be ignored.
  if (typeof assetsDirRel !== "string" || assetsDirRel.trim() === "") {
    throw new Error(`${configRel} assets.directory must be a non-empty string`);
  }
  const assetsDir = path.resolve(absProject, assetsDirRel);
  if (!existsSync(assetsDir)) {
    throw new Error(`${configRel} assets.directory ${formatDiagnosticValue(assetsDirRel)} not found`);
  }
  let dirStat;
  try {
    dirStat = lstatSync(assetsDir);
  } catch (err) {
    throw assetsDirFsError(configRel, "stat", assetsDirRel, err);
  }
  if (dirStat.isSymbolicLink()) {
    throw new Error(
      `${configRel} assets.directory ${formatDiagnosticValue(assetsDirRel)} must not be a symlink`
    );
  }
  if (!dirStat.isDirectory()) {
    throw new Error(`${configRel} assets.directory ${formatDiagnosticValue(assetsDirRel)} is not a directory`);
  }
  let projectReal;
  try {
    projectReal = realpathSync(absProject);
  } catch (err) {
    throw assetsDirFsError(configRel, "resolve project root", assetsDirRel, err);
  }
  let assetsReal;
  try {
    assetsReal = realpathSync(assetsDir);
  } catch (err) {
    throw assetsDirFsError(configRel, "resolve", assetsDirRel, err);
  }
  const rel = path.relative(projectReal, assetsReal);
  if (rel === ".." || rel.startsWith(".." + path.sep) || path.isAbsolute(rel)) {
    throw new Error(
      `${configRel} assets.directory ${formatDiagnosticValue(assetsDirRel)} resolves outside the project root`
    );
  }
  return assetsDir;
}

/**
 * @param {string} dir
 * @param {{ onIgnore?: ((relPath: string, isDir: boolean) => void) | null }} [options]
 * @returns {Record<string, unknown>}
 */
export function collectAssets(dir, { onIgnore = null } = {}) {
  let rootReal;
  try {
    rootReal = realpathSync(dir);
  } catch (err) {
    throw assetFsError("resolve", ".", err);
  }
  const ignoreFile = path.join(dir, ASSETS_IGNORE_FILENAME);
  let ignoreText = "";
  if (existsSync(ignoreFile)) {
    try {
      ignoreText = readFileSync(ignoreFile, "utf8");
    } catch (err) {
      throw assetFsError("read", ASSETS_IGNORE_FILENAME, err);
    }
  }
  const userPatterns = ignoreText ? parseAssetIgnorePatterns(ignoreText) : [];
  const matcher = createAssetIgnoreMatcher([...DEFAULT_ASSET_IGNORE_PATTERNS, ...userPatterns]);
  const out = manifestMap();
  let totalBytes = 0;
  (function walk(cur, rel) {
    let entries;
    try {
      entries = readdirSync(cur);
    } catch (err) {
      throw assetFsError("read directory", rel || ".", err);
    }
    for (const entry of entries) {
      const full = path.join(cur, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      let st;
      try {
        st = lstatSync(full);
      } catch (err) {
        throw assetFsError("stat", relPath, err);
      }
      // Ignore check runs first so an ignored symlink (e.g. a node_modules
      // link) prunes silently instead of failing the symlink rule below.
      const isDir = st.isDirectory();
      if (matcher.ignores(relPath, isDir)) {
        // The .assetsignore metafile itself is never interesting to report.
        // An ignored directory prunes its whole subtree, so isDir lets the
        // caller report it honestly (one entry can be thousands of files).
        if (onIgnore && relPath !== ASSETS_IGNORE_FILENAME) onIgnore(relPath, isDir);
        continue;
      }
      if (st.isSymbolicLink()) {
        const shownRelPath = formatDiagnosticValue(relPath);
        throw new Error(
          `assets: symlink not allowed at ${shownRelPath} ` +
          `(add ${shownRelPath} to .assetsignore to skip it; patterns ending in "/" match only real directories, not symlinks)`
        );
      }
      if (st.isDirectory()) {
        walk(full, relPath);
        continue;
      }
      if (!st.isFile()) {
        throw new Error(`assets: unsupported entry type at ${formatDiagnosticValue(relPath)}`);
      }
      let realFull;
      try {
        realFull = realpathSync(full);
      } catch (err) {
        throw assetFsError("resolve", relPath, err);
      }
      const inside = path.relative(rootReal, realFull);
      if (inside === ".." || inside.startsWith(".." + path.sep) || path.isAbsolute(inside)) {
        throw new Error(`assets: ${formatDiagnosticValue(relPath)} resolves outside the assets root`);
      }
      if (st.size > MAX_ASSET_FILE_BYTES) {
        throw new Error(
          `assets: ${formatDiagnosticValue(relPath)} is ${st.size} bytes, exceeds ${MAX_ASSET_FILE_BYTES} per-file cap`
        );
      }
      totalBytes += st.size;
      if (totalBytes > MAX_ASSETS_TOTAL_BYTES) {
        throw new Error(
          `assets: cumulative size exceeds ${MAX_ASSETS_TOTAL_BYTES} bytes ` +
            `(hit at ${formatDiagnosticValue(relPath)})`
        );
      }
      let bytes;
      try {
        bytes = readFileSync(full);
      } catch (err) {
        throw assetFsError("read", relPath, err);
      }
      out[relPath] = bytes.toString("base64");
    }
  })(dir, "");
  return out;
}

/**
 * @param {string} text
 * @returns {string[]}
 */
function parseAssetIgnorePatterns(text) {
  const patterns = [];
  for (const rawLine of String(text).split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    patterns.push(line);
  }
  return patterns;
}

// gitignore-style matching (the dialect Cloudflare's .assetsignore uses):
// `!` negation, trailing `/` for dir-only, leading `/` (or any inner `/`)
// anchors to the assets root, `*` `**` `?` globs, last match wins. As with
// gitignore, an ignored directory prunes its whole subtree — a negation
// cannot re-include files inside it.
/**
 * @param {string[]} patterns
 * @returns {{ ignores: (relPath: string, isDir: boolean) => boolean }}
 */
function createAssetIgnoreMatcher(patterns) {
  const rules = patterns.map(compileAssetIgnoreRule);
  return {
    /**
     * @param {string} relPath
     * @param {boolean} isDir
     * @returns {boolean}
     */
    ignores(relPath, isDir) {
      let ignored = false;
      for (const rule of rules) {
        if (rule.dirOnly && !isDir) continue;
        if (rule.regex.test(relPath)) ignored = !rule.negated;
      }
      return ignored;
    },
  };
}

/**
 * @param {string} pattern
 * @returns {{ regex: RegExp, dirOnly: boolean, negated: boolean }}
 */
function compileAssetIgnoreRule(pattern) {
  const originalPattern = pattern;
  let negated = false;
  if (pattern.startsWith("!")) {
    negated = true;
    pattern = pattern.slice(1);
  }
  let dirOnly = false;
  if (pattern.endsWith("/")) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  let anchored = false;
  if (pattern.startsWith("/")) {
    anchored = true;
    pattern = pattern.slice(1);
  } else if (pattern.includes("/")) {
    anchored = true;
  }
  const prefix = anchored ? "" : "(?:[^/]+/)*";
  let regex;
  try {
    regex = new RegExp(`^${prefix}${assetGlobToRegex(pattern)}$`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `assets: invalid .assetsignore pattern ${formatDiagnosticValue(originalPattern)}: ${escapeTerminalText(message)}`,
      { cause: err }
    );
  }
  return {
    regex,
    dirOnly,
    negated,
  };
}

/**
 * @param {string} pattern
 * @returns {string}
 */
function assetGlobToRegex(pattern) {
  let out = "";
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        // `**` crosses directories only as a full path segment; gitignore
        // treats other consecutive asterisks (e.g. `a**b`) as a regular `*`.
        const atSegmentStart = i === 0 || pattern[i - 1] === "/";
        const next = pattern[i + 2];
        if (atSegmentStart && next === "/") {
          out += "(?:[^/]+/)*"; // `**/` also matches zero directories
          i += 2;
          continue;
        }
        if (atSegmentStart && next === undefined) {
          out += ".*";
          i += 1;
          continue;
        }
        while (pattern[i + 1] === "*") i += 1;
      }
      out += "[^/]*";
      continue;
    }
    if (c === "?") {
      out += "[^/]";
      continue;
    }
    if (c === "[") {
      const cls = parseGlobClass(pattern, i);
      if (cls) {
        out += cls.regex;
        i = cls.end;
        continue;
      }
      out += "\\[";
      continue;
    }
    out += c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return out;
}

// fnmatch-style class: `[abc]`, ranges `[a-z]`, negation `[!abc]`/`[^abc]`,
// `]` literal when it is the first member. Returns null for an unterminated
// class so the caller falls back to a literal `[`. (The body is never empty
// at the terminator: a leading `]` is consumed as a literal member.)
/**
 * @param {string} pattern
 * @param {number} start
 * @returns {{ regex: string, end: number } | null}
 */
function parseGlobClass(pattern, start) {
  let i = start + 1;
  let negated = false;
  if (pattern[i] === "!" || pattern[i] === "^") {
    negated = true;
    i += 1;
  }
  let body = "";
  if (pattern[i] === "]") {
    body += "\\]";
    i += 1;
  }
  for (; i < pattern.length; i += 1) {
    const c = pattern[i];
    if (c === "]") {
      // Like gitignore's fnmatch, a class never matches the "/" separator —
      // guard with a lookahead instead of editing the class body, which
      // would create accidental ranges (`[^/-x]` parses `/-x` as a range).
      return { regex: `(?!/)${negated ? `[^${body}]` : `[${body}]`}`, end: i };
    }
    body += c === "\\" ? "\\\\" : c;
  }
  return null;
}
