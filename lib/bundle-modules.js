import path from "node:path";

const TEXT_EXTS = new Set([".txt", ".css", ".html", ".htm", ".svg"]);

/** @param {string} filePath */
export function inferType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === ".js" || ext === ".mjs") return "module";
  if (ext === ".cjs") return "cjs";
  if (ext === ".py") return "py";
  if (ext === ".json") return "json";
  if (TEXT_EXTS.has(ext)) return "text";
  if (ext === ".wasm") return "wasm";
  return "data";
}

// Inverse of `control/bundle.js::normalizeModule` for WDL-supported module
// types. Python Workers are rejected by collectModules before wire encoding.
/**
 * `type` is normally an {@link inferType} result, but the default case rejects
 * anything else, so the honest input type is `string`.
 * @param {Buffer} buf
 * @param {string} type
 */
export function toWireModule(buf, type) {
  switch (type) {
    case "module": return buf.toString("utf8");
    case "cjs": return { cjs: buf.toString("utf8") };
    case "text": return { text: buf.toString("utf8") };
    case "json": return { json: JSON.parse(buf.toString("utf8")) };
    case "wasm": return { wasm_b64: buf.toString("base64") };
    case "data": return { data_b64: buf.toString("base64") };
    default: throw new Error(`Unknown module type "${type}"`);
  }
}
