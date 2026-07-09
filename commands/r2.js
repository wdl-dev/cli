import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  LONG_CONTROL_TIMEOUT_MS,
  UNLIMITED_CONTROL_BODY_BYTES,
} from "../lib/control-fetch.js";
import { defineCommand } from "../lib/command.js";
import { CliError, defineCliOption, formatHelp, isMain, optionHelp, unexpectedArgument } from "../lib/common.js";
import { confirmAction } from "../lib/stdin.js";
import { escapeTerminalText, writeResult, writeStatusLine } from "../lib/output.js";
import { formatBucketList, formatObjectHead, formatObjectList } from "../lib/r2-format.js";

const R2_OPTIONS = [
  defineCliOption("prefix", { type: "string" }, "--prefix <prefix>", "Object key prefix for objects list."),
  defineCliOption("delimiter", { type: "string" }, "--delimiter <delim>", "Group object list results by delimiter."),
  defineCliOption("cursor", { type: "string" }, "--cursor <cursor>", "Continue a previous list response."),
  defineCliOption("limit", { type: "string" }, "--limit <n>", "Maximum list results (1..1000)."),
  defineCliOption("out", { type: "string" }, "--out <path>", "Write object bytes to a file instead of stdout."),
  defineCliOption("yes", { type: "boolean" }, "--yes", "Confirm destructive actions."),
  "ns",
  "control",
  "json",
  "help",
];

const command = defineCommand({
  name: "r2",
  summary: "Inspect and delete R2 virtual bucket data.",
  options: R2_OPTIONS,
  defaults: { stdoutStream: process.stdout },
  usage: usageText,
  run: runR2,
});

export const main = command.main;
export const runR2Command = command.run;
export const meta = command.meta;

/**
 * `stdoutStream` is injected via this command's `defaults`.
 * @typedef {import("../lib/command.js").CommandContext & { stdoutStream: NodeJS.WritableStream }} R2Context
 */

/**
 * @param {{
 *   values: import("../lib/command.js").PresetFlags<"ns" | "control" | "json"> & { prefix?: string, delimiter?: string, cursor?: string, limit?: string, out?: string, yes?: boolean },
 *   positionals: string[],
 *   context: import("../lib/command.js").CommandContext,
 * }} arg
 */
async function runR2({ values, positionals, context: baseContext }) {
  const context = /** @type {R2Context} */ (baseContext);
  const { stdout, stderr, stdin, stdoutStream } = context;

  const [group, action, bucket, key] = positionals;
  const extraArg = positionals[4];
  const ns = context.resolveNamespace();
  if (!group || !action || !ns) throw new CliError(usageText());

  // Object keys can contain "/" and must reject . / .. segments, so they use
  // encodeR2KeyPath rather than nsUrl's per-segment encodePath.
  const objectUrl = (/** @type {string} */ objectKey) =>
    `${context.nsUrl("r2", "buckets", bucket, "objects")}/${encodeR2KeyPath(objectKey)}`;

  if (group === "buckets" && action === "list") {
    if (bucket) throw unexpectedArgument("r2 buckets list", bucket);
    const { headers } = context.resolveControl();
    const url = withQuery(context.nsUrl("r2", "buckets"), {
      cursor: values.cursor,
      limit: normalizeListLimit(values.limit),
    });
    const body = /** @type {Parameters<typeof formatBucketList>[0]} */ (
      await context.fetchJson(url, { headers }, "list R2 buckets")
    );
    writeResult(values.json === true, body, () => formatBucketList(body), stdout);
    return;
  }

  if (group === "objects" && action === "list") {
    if (!bucket) throw new CliError("r2 objects list requires <bucket>");
    if (key) throw unexpectedArgument("r2 objects list", key);
    const { headers } = context.resolveControl();
    const url = withQuery(context.nsUrl("r2", "buckets", bucket, "objects"), {
      prefix: values.prefix,
      delimiter: values.delimiter,
      cursor: values.cursor,
      limit: normalizeListLimit(values.limit),
    });
    const body = /** @type {Parameters<typeof formatObjectList>[0]} */ (
      await context.fetchJson(url, { headers }, "list R2 objects")
    );
    writeResult(values.json === true, body, () => formatObjectList(body), stdout);
    return;
  }

  if (group === "objects" && action === "get") {
    if (!bucket) throw new CliError("r2 objects get requires <bucket> <key>");
    if (extraArg) throw unexpectedArgument("r2 objects get", extraArg);
    const objectKey = requireR2ObjectKey(key);
    if (!values.out && isInteractiveStdout(stdoutStream)) {
      throw new CliError("r2 objects get refuses to write raw object bytes to an interactive terminal; pass --out <path>");
    }
    const { headers } = context.resolveControl();
    const res = await context.fetchStream(objectUrl(objectKey), {
      headers,
      timeoutMs: LONG_CONTROL_TIMEOUT_MS,
      maxBodyBytes: UNLIMITED_CONTROL_BODY_BYTES,
      streamResponse: true,
    }, "get R2 object");
    // streamResponse: true always yields a body.
    const responseBody = /** @type {import("node:stream").Readable} */ (res.body);
    if (values.out) {
      const bytesWritten = await writeBodyToFile(responseBody, values.out);
      writeStatusLine(stdout, `OK wrote ${bytesWritten} bytes to ${values.out}`);
    } else {
      await writeBodyToStdout(responseBody, stdoutStream);
    }
    return;
  }

  if (group === "objects" && action === "head") {
    if (!bucket) throw new CliError("r2 objects head requires <bucket> <key>");
    if (extraArg) throw unexpectedArgument("r2 objects head", extraArg);
    const objectKey = requireR2ObjectKey(key);
    const { headers } = context.resolveControl();
    const res = await context.fetchStream(objectUrl(objectKey), {
      method: "HEAD",
      headers,
    }, "head R2 object");
    const body = objectHeadFromHeaders({
      namespace: ns,
      bucket,
      key: objectKey,
      headers: res.headers,
    });
    writeResult(values.json === true, body, () => formatObjectHead(body), stdout);
    return;
  }

  if (group === "objects" && action === "delete") {
    if (!bucket) throw new CliError("r2 objects delete requires <bucket> <key>");
    if (extraArg) throw unexpectedArgument("r2 objects delete", extraArg);
    const objectKey = requireR2ObjectKey(key);
    const { headers } = context.resolveControl();
    await confirmAction({
      yes: values.yes === true,
      stdin,
      stderr,
      prompt: `Are you sure you want to delete R2 object "${ns}/${bucket}/${objectKey}"? [y/N] `,
      action: `delete R2 object "${ns}/${bucket}/${objectKey}"`,
    });
    const body = /** @type {{ namespace?: string, bucket?: string, key?: string }} */ (
      await context.fetchJson(objectUrl(objectKey), {
        method: "DELETE",
        headers,
      }, "delete R2 object")
    );
    writeResult(values.json === true, body, () => [
      `OK ${body.namespace}/${body.bucket}/${body.key} deleted`,
    ], stdout);
    return;
  }

  throw new CliError(`unknown r2 command: ${escapeTerminalText(group)} ${escapeTerminalText(action)}\n${usageText()}`);
}

/**
 * @param {string} url
 * @param {Record<string, string | undefined>} params
 * @returns {string}
 */
function withQuery(url, params) {
  const u = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") u.searchParams.set(key, String(value));
  }
  return u.toString();
}

/**
 * @param {string | undefined} key
 * @returns {string}
 */
function requireR2ObjectKey(key) {
  if (key == null || !String(key).trim()) {
    throw new CliError("R2 object key is required");
  }
  return String(key);
}

/**
 * @param {string | undefined} limit
 * @returns {string | undefined}
 */
function normalizeListLimit(limit) {
  if (limit == null || limit === "") return undefined;
  const n = Number(limit);
  if (!Number.isInteger(n) || n < 1 || n > 1000) {
    throw new CliError("r2 --limit must be an integer in [1, 1000]");
  }
  return String(n);
}

/** @param {string} key */
function encodeR2KeyPath(key) {
  const segments = String(key).split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new CliError("R2 object key must not contain . or .. path segments");
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

/**
 * Either a `fetch`-style Headers object or a Node `IncomingHttpHeaders` bag.
 * @typedef {Headers | import("node:http").IncomingHttpHeaders} HeaderSource
 */

/**
 * @param {{ namespace: string, bucket: string, key: string, headers: HeaderSource }} arg
 */
function objectHeadFromHeaders({ namespace, bucket, key, headers }) {
  // null-prototype: a control-supplied `x-amz-meta-__proto__` header becomes a real
  // own key instead of being swallowed by Object.prototype's __proto__ setter.
  const customMetadata = Object.create(null);
  for (const [name, value] of headerEntries(headers)) {
    const lower = String(name).toLowerCase();
    if (lower.startsWith("x-amz-meta-")) {
      const metaKey = lower.slice("x-amz-meta-".length);
      if (metaKey) customMetadata[metaKey] = String(value);
    }
  }
  return {
    namespace,
    bucket,
    key,
    size: Number(getHeader(headers, "content-length") || "0"),
    etag: stripEtag(getHeader(headers, "etag") || ""),
    uploaded: getHeader(headers, "last-modified") || "",
    httpMetadata: {
      ...(getHeader(headers, "content-type") ? { contentType: getHeader(headers, "content-type") } : {}),
      ...(getHeader(headers, "content-language") ? { contentLanguage: getHeader(headers, "content-language") } : {}),
      ...(getHeader(headers, "content-disposition") ? { contentDisposition: getHeader(headers, "content-disposition") } : {}),
      ...(getHeader(headers, "content-encoding") ? { contentEncoding: getHeader(headers, "content-encoding") } : {}),
      ...(getHeader(headers, "cache-control") ? { cacheControl: getHeader(headers, "cache-control") } : {}),
      ...(getHeader(headers, "expires") ? { cacheExpiry: getHeader(headers, "expires") } : {}),
    },
    customMetadata,
  };
}

/**
 * @param {HeaderSource} headers
 * @param {string} name
 * @returns {string | undefined}
 */
function getHeader(headers, name) {
  if (!headers) return undefined;
  if (headers instanceof Headers) return headers.get(name) || undefined;
  // IncomingHttpHeaders values are string | string[]; the headers read here are
  // single-valued response headers, so coerce to a single string for callers.
  const value = headers[name.toLowerCase()] || headers[name];
  if (!value) return undefined;
  return Array.isArray(value) ? value[0] : value;
}

/**
 * @param {HeaderSource} headers
 * @returns {Iterable<[string, unknown]>}
 */
function headerEntries(headers) {
  if (!headers) return [];
  if (headers instanceof Headers) return headers.entries();
  return Object.entries(headers);
}

/** @param {string} etag */
function stripEtag(etag) {
  const s = String(etag || "");
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

/**
 * @param {import("node:stream").Readable} body
 * @param {NodeJS.WritableStream} stdoutStream
 */
async function writeBodyToStdout(body, stdoutStream) {
  for await (const chunk of body) {
    if (!stdoutStream.write(toBuffer(chunk))) await once(stdoutStream, "drain");
  }
}

/** @param {NodeJS.WritableStream} stdoutStream */
function isInteractiveStdout(stdoutStream) {
  return /** @type {{ isTTY?: boolean }} */ (stdoutStream).isTTY === true;
}

/**
 * @param {import("node:stream").Readable} body
 * @param {string} outPath
 * @returns {Promise<number>}
 */
async function writeBodyToFile(body, outPath) {
  let bytesWritten = 0;
  const counter = new Transform({
    transform(chunk, _encoding, callback) {
      const buf = toBuffer(chunk);
      bytesWritten += buf.length;
      callback(null, buf);
    },
  });
  await pipeline(body, counter, createWriteStream(outPath));
  return bytesWritten;
}

/**
 * @param {Buffer | string | Uint8Array} chunk
 * @returns {Buffer}
 */
function toBuffer(chunk) {
  return Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
}

function usageText() {
  return formatHelp({
    usage: [
      "wdl r2 buckets list [options]",
      "wdl r2 objects list <bucket> [--prefix <prefix>] [--delimiter <delim>] [options]",
      "wdl r2 objects head <bucket> <key> [options]",
      "wdl r2 objects get <bucket> <key> [--out <path>] [options]",
      "wdl r2 objects delete <bucket> <key> --yes [options]",
    ],
    description: "Inspect and delete namespace-scoped R2 virtual bucket data.",
    options: optionHelp(R2_OPTIONS),
  });
}

if (isMain(import.meta.url)) {
  await main();
}
