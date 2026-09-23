// Human-readable rendering for `wdl r2`. (Response-header parsing lives in r2.js.)
import { escapeTerminalText } from "./output.js";

/** @param {unknown} value */
const cell = (value) => escapeTerminalText(String(value));

/**
 * @typedef {object} R2Bucket
 * @property {string} name
 */

/**
 * @typedef {object} R2Object
 * @property {string} key
 * @property {number} [size]
 * @property {string} [etag]
 * @property {string} [uploaded]
 */

/**
 * @param {{ namespace?: string, buckets?: R2Bucket[], truncated?: boolean, cursor?: string }} body
 * @returns {string[]}
 */
export function formatBucketList(body) {
  const lines = [`R2 buckets in ${cell(body.namespace)}:`];
  for (const bucket of body.buckets || []) lines.push(`  ${cell(bucket.name)}`);
  if (body.truncated && body.cursor) lines.push(`Next cursor: ${cell(body.cursor)}`);
  return lines;
}

/**
 * @param {{
 *   namespace?: string,
 *   bucket?: string,
 *   delimitedPrefixes?: string[],
 *   objects?: R2Object[],
 *   truncated?: boolean,
 *   cursor?: string,
 * }} body
 * @returns {string[]}
 */
export function formatObjectList(body) {
  const lines = [`R2 objects in ${cell(body.namespace)}/${cell(body.bucket)}:`];
  for (const prefix of body.delimitedPrefixes || []) lines.push(`  <prefix> ${cell(prefix)}`);
  for (const obj of body.objects || []) {
    lines.push(`  ${cell(obj.key)}\t${cell(obj.size)}\t${cell(obj.etag || "-")}\t${cell(obj.uploaded || "-")}`);
  }
  if (body.truncated && body.cursor) lines.push(`Next cursor: ${cell(body.cursor)}`);
  return lines;
}

/**
 * @param {{
 *   namespace?: string,
 *   bucket?: string,
 *   key?: string,
 *   size?: number,
 *   etag?: string,
 *   uploaded?: string,
 *   httpMetadata?: Record<string, unknown>,
 *   customMetadata?: Record<string, unknown>,
 * }} body
 * @returns {string[]}
 */
export function formatObjectHead(body) {
  const lines = [`R2 object ${cell(body.namespace)}/${cell(body.bucket)}/${cell(body.key)}:`];
  lines.push(`  size: ${cell(body.size)}`);
  lines.push(`  etag: ${cell(body.etag || "-")}`);
  lines.push(`  uploaded: ${cell(body.uploaded || "-")}`);
  const hm = body.httpMetadata || {};
  for (const [key, value] of Object.entries(hm)) {
    lines.push(`  httpMetadata.${cell(key)}: ${cell(value)}`);
  }
  const cm = body.customMetadata || {};
  for (const [key, value] of Object.entries(cm)) {
    lines.push(`  customMetadata.${cell(key)}: ${cell(value)}`);
  }
  return lines;
}
