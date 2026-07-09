import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { inferType, toWireModule } from "../bundle-modules.js";
import { escapeTerminalText, formatDiagnosticValue } from "../output.js";
import { manifestMap } from "./utils.js";

/**
 * @param {string} action
 * @param {string} relPath
 * @param {unknown} err
 * @returns {Error}
 */
function moduleFsError(action, relPath, err) {
  const message = err instanceof Error ? err.message : String(err);
  return new Error(`wrangler output: failed to ${action} ${formatDiagnosticValue(relPath)}: ${escapeTerminalText(message)}`, {
    cause: err,
  });
}

// Skip only the known incidentals (.map, README.md). Dropping any other
// artifact silently would crash the worker at runtime.
/**
 * @param {string} dir
 * @returns {Record<string, unknown>}
 */
export function collectModules(dir) {
  if (!existsSync(dir)) throw new Error(`wrangler produced no output at ${formatDiagnosticValue(dir)}`);
  const out = manifestMap();
  const skip = new Set(["README.md"]);
  (function walk(cur, rel) {
    let entries;
    try {
      entries = readdirSync(cur);
    } catch (err) {
      throw moduleFsError("read directory", rel || ".", err);
    }
    for (const entry of entries) {
      const full = path.join(cur, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      let st;
      try {
        st = lstatSync(full);
      } catch (err) {
        throw moduleFsError("stat", relPath, err);
      }
      if (st.isSymbolicLink()) {
        throw new Error(`wrangler output contains a symlink (${formatDiagnosticValue(relPath)}); refusing to follow`);
      }
      if (st.isDirectory()) {
        walk(full, relPath);
        continue;
      }
      if (!st.isFile()) continue;
      if (entry.endsWith(".map") || skip.has(relPath)) continue;
      const type = inferType(entry);
      if (type === "py") {
        throw new Error(`Python Workers modules are not supported by WDL (${escapeTerminalText(relPath)})`);
      }
      let bytes;
      try {
        bytes = readFileSync(full);
      } catch (err) {
        throw moduleFsError("read", relPath, err);
      }
      out[relPath] = toWireModule(bytes, type);
    }
  })(dir, "");
  return out;
}
