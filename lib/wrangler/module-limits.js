// CLI-local copy of the WDL runtime/do-runtime injected module names that a
// tenant bundle must not use. Keep in sync with runtime/load/module-rewrite.js
// and do-runtime/load-code-budget.js in wdl.

export const WDL_RESERVED_MODULE_NAMES = Object.freeze([
  "_wdl-cloudflare-workflows.js",
  "_wdl-d1-data-field.js",
  "_wdl-d1-client.js",
  "_wdl-d1-params.js",
  "_wdl-sql-splitter.js",
  "_wdl-d1-transport.js",
  "_wdl-r2-client.js",
  "_wdl-r2-utils.js",
  "_wdl-do-client.js",
  "_wdl-do-transport.js",
  "_wdl-owner-endpoint.js",
  "_wdl-owner-hint-cache.js",
  "_wdl-request-id.js",
  "_wdl-workflows-client.js",
  "_wdl-wrapper.js",
  "_wdl-do-runtime-wrapper.js",
  "_wdl-do-alarm-shim.js",
]);

const WDL_RESERVED_MODULE_SET = new Set(WDL_RESERVED_MODULE_NAMES);

/** @param {string} name */
export function isWdlReservedModuleName(name) {
  return WDL_RESERVED_MODULE_SET.has(name);
}
