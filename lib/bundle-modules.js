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

// Inverse of `control/lib.js::normalizeModule` - keep the two in sync.
/**
 * @param {Buffer} buf
 * @param {"module" | "cjs" | "py" | "json" | "text" | "wasm" | "data"} type
 */
export function toWireModule(buf, type) {
  switch (type) {
    case "module": return buf.toString("utf8");
    case "cjs": return { cjs: buf.toString("utf8") };
    case "py": return { py: buf.toString("utf8") };
    case "text": return { text: buf.toString("utf8") };
    case "json": return { json: JSON.parse(buf.toString("utf8")) };
    case "wasm": return { wasm_b64: buf.toString("base64") };
    case "data": return { data_b64: buf.toString("base64") };
    default: throw new Error(`Unknown module type "${type}"`);
  }
}
