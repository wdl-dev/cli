// Human-readable rendering for `wdl r2`. (Response-header parsing lives in r2.js.)

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
  const lines = [`R2 buckets in ${body.namespace}:`];
  for (const bucket of body.buckets || []) lines.push(`  ${bucket.name}`);
  if (body.truncated && body.cursor) lines.push(`Next cursor: ${body.cursor}`);
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
  const lines = [`R2 objects in ${body.namespace}/${body.bucket}:`];
  for (const prefix of body.delimitedPrefixes || []) lines.push(`  <prefix> ${prefix}`);
  for (const obj of body.objects || []) {
    lines.push(`  ${obj.key}\t${obj.size}\t${obj.etag || "-"}\t${obj.uploaded || "-"}`);
  }
  if (body.truncated && body.cursor) lines.push(`Next cursor: ${body.cursor}`);
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
  const lines = [`R2 object ${body.namespace}/${body.bucket}/${body.key}:`];
  lines.push(`  size: ${body.size}`);
  lines.push(`  etag: ${body.etag || "-"}`);
  lines.push(`  uploaded: ${body.uploaded || "-"}`);
  const hm = body.httpMetadata || {};
  for (const [key, value] of Object.entries(hm)) {
    lines.push(`  httpMetadata.${key}: ${value}`);
  }
  const cm = body.customMetadata || {};
  for (const [key, value] of Object.entries(cm)) {
    lines.push(`  customMetadata.${key}: ${value}`);
  }
  return lines;
}
