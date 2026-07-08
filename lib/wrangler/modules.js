import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { inferType, toWireModule } from "../bundle-modules.js";
import { isWdlReservedModuleName } from "./module-limits.js";
import { manifestMap } from "./utils.js";

// Skip only the known incidentals (.map, README.md). Dropping any other
// artifact silently would crash the worker at runtime.
/**
 * @param {string} dir
 * @returns {Record<string, unknown>}
 */
export function collectModules(dir) {
  if (!existsSync(dir)) throw new Error(`wrangler produced no output at ${dir}`);
  const out = manifestMap();
  const skip = new Set(["README.md"]);
  (function walk(cur, rel) {
    for (const entry of readdirSync(cur)) {
      const full = path.join(cur, entry);
      const relPath = rel ? `${rel}/${entry}` : entry;
      const st = lstatSync(full);
      if (st.isSymbolicLink()) {
        throw new Error(`wrangler output contains a symlink (${relPath}); refusing to follow`);
      }
      if (st.isDirectory()) {
        walk(full, relPath);
        continue;
      }
      if (!st.isFile()) continue;
      if (entry.endsWith(".map") || skip.has(relPath)) continue;
      if (isWdlReservedModuleName(relPath)) {
        throw new Error(`wrangler output uses WDL reserved module name ${relPath}`);
      }
      if (path.extname(entry).toLowerCase() === ".py") {
        throw new Error(`Python Workers modules are not supported by WDL; remove ${relPath} from the bundle`);
      }
      out[relPath] = toWireModule(readFileSync(full), inferType(entry));
    }
  })(dir, "");
  return out;
}
