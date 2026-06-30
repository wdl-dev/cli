/**
 * A null-prototype map keyed by string. The null prototype keeps reserved keys
 * like `__proto__` from colliding with `Object.prototype`.
 * @returns {Record<string, unknown>}
 */
export function manifestMap() {
  return Object.create(null);
}

/**
 * @param {object} obj
 * @param {PropertyKey} key
 * @returns {boolean}
 */
export function hasOwn(obj, key) {
  return Object.hasOwn(obj, key);
}

/**
 * A non-null, non-array object viewed as a string-keyed record, or null.
 * @param {unknown} value
 * @returns {Record<string, unknown> | null}
 */
export function asRecord(value) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? /** @type {Record<string, unknown>} */ (value)
    : null;
}
