// CLI-local copy of the tenant namespace grammar. Keep this in sync with
// shared/ns-pattern.js, but do not import from ../shared: the cli/
// directory is intentionally usable by itself.
export const NS_PATTERN = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
// Keep in sync with shared/ns-pattern.js and runtime/r2-utils.js. cli/ is
// intentionally self-contained and does not import shared modules.
export const R2_BUCKET_NAME_RE = /^[a-z0-9][a-z0-9-]{0,62}$/;

// Keep in sync with shared/ns-pattern.js#WORKFLOW_NAME_RE.
export const WORKFLOW_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

// Keep in sync with shared/ns-pattern.js#WORKFLOW_INSTANCE_ID_RE.
export const WORKFLOW_INSTANCE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

// Keep in sync with shared/ns-pattern.js#BINDING_NAME_RE.
export const BINDING_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;

// Keep in sync with shared/ns-pattern.js#JS_IDENTIFIER_RE.
export const JS_IDENTIFIER_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * @param {unknown} value
 * @returns {value is string}
 */
export function isValidJsIdentifier(value) {
  return typeof value === "string" && JS_IDENTIFIER_RE.test(value);
}

// Keep in sync with shared/ns-pattern.js#JS_CLASS_DECLARATION_RESERVED_WORDS.
export const JS_CLASS_DECLARATION_RESERVED_WORDS = new Set([
  "arguments",
  "await",
  "break",
  "case",
  "catch",
  "class",
  "const",
  "continue",
  "debugger",
  "default",
  "delete",
  "do",
  "else",
  "enum",
  "eval",
  "export",
  "extends",
  "false",
  "finally",
  "for",
  "function",
  "if",
  "implements",
  "import",
  "in",
  "instanceof",
  "interface",
  "let",
  "new",
  "null",
  "package",
  "private",
  "protected",
  "public",
  "return",
  "static",
  "super",
  "switch",
  "this",
  "throw",
  "true",
  "try",
  "typeof",
  "var",
  "void",
  "while",
  "with",
  "yield",
]);

/** @param {unknown} value */
export function isValidJsClassDeclarationName(value) {
  return isValidJsIdentifier(value) && !JS_CLASS_DECLARATION_RESERVED_WORDS.has(value);
}

// Keep in sync with shared/ns-pattern.js#WDL_RESERVED_BINDING_RE.
export const WDL_RESERVED_BINDING_RE = /^__WDL_[A-Za-z0-9_]*__$/;

// Keep in sync with shared/ns-pattern.js#RESERVED_OBJECT_KEYS.
export const RESERVED_OBJECT_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toString",
  "toLocaleString",
  "valueOf",
]);

// Keep in sync with shared/ns-pattern.js: reserved tenant names are a
// product/infra naming policy, not an admin-host routing guard.
export const RESERVED_TENANT_NS = new Set(["admin"]);

// CLI is tenant-visible and deliberately does not copy the server's concrete
// reserved namespace set. It only recognizes a delimiter-safe reserved-looking
// shape for operator .env sections; tenant-facing deploy config still uses
// NS_PATTERN and rejects this shape.
const RESERVED_NS_SECTION_RE = /^__[A-Za-z0-9_-]+__$/;

// Keep in sync with shared/ns-pattern.js#WDL_RESERVED_ENTRYPOINT_RE
// (drift-alarm in tests/unit/cli-ns-pattern.test.js).
export const WDL_RESERVED_ENTRYPOINT_RE = /^__Wdl[A-Za-z0-9_]*__$/;

const NS_RE = new RegExp(`^${NS_PATTERN}$`);

/** @param {unknown} ns */
export function isReservedNs(ns) {
  return typeof ns === "string" && RESERVED_NS_SECTION_RE.test(ns);
}

/** @param {unknown} ns */
export function isAdminAcceptableNs(ns) {
  if (typeof ns !== "string") return false;
  if (RESERVED_TENANT_NS.has(ns)) return false;
  return isReservedNs(ns) || NS_RE.test(ns);
}
