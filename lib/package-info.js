import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const CLI_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** @type {string | null} */
let cachedCliVersion = null;

/** @returns {{ version?: string, [key: string]: unknown }} */
export function readCliPackageJson() {
  return JSON.parse(readFileSync(path.join(CLI_ROOT, "package.json"), "utf8"));
}

/** @returns {string} */
export function currentCliVersion() {
  if (cachedCliVersion !== null) return cachedCliVersion;
  try {
    const version = readCliPackageJson().version;
    cachedCliVersion = typeof version === "string" && version ? version : "unknown";
  } catch {
    cachedCliVersion = "unknown";
  }
  return cachedCliVersion;
}
