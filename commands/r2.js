import { createWriteStream } from "node:fs";
import { once } from "node:events";
import { Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  LONG_CONTROL_TIMEOUT_MS,
  UNLIMITED_CONTROL_BODY_BYTES,
} from "../lib/control-fetch.js";
import { defineCommand } from "../lib/command.js";
import {
  CliError,
  confirmAction,
  defineCliOption,
  formatHelp,
  isMain,
  optionHelp,
  writeResult,
  writeStatusLine,
} from "../lib/common.js";
import { formatBucketList, formatObjectHead, formatObjectList } from "../lib/r2-format.js";

const R2_OPTIONS = [
  defineCliOption("prefix", { type: "string" }, "--prefix <prefix>", "Object key prefix for objects list."),
  defineCliOption("delimiter", { type: "string" }, "--delimiter <delim>", "Group object list results by delimiter."),
  defineCliOption("cursor", { type: "string" }, "--cursor <cursor>", "Continue a previous list response."),
  defineCliOption("limit", { type: "string" }, "--limit <n>", "Maximum list results, capped at 1000."),
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

/** @param {{ values: Record<string, any>, positionals: string[], context: import("../lib/command.js").CommandContext & { stdoutStream: NodeJS.WritableStream } }} arg */
async function runR2({ values, positionals, context }) {
  const { stdout, stdoutStream, stderr, stdin } = context;

  const [group, action, bucket, key] = positionals;
  const ns = context.resolveNamespace();
  if (!group || !action || !ns) throw new CliError(usageText());

  const { headers } = context.resolveControl();
  // Object keys can contain "/" and must reject . / .. segments, so they use
  // encodeR2KeyPath rather than nsUrl's per-segment encodePath.
  const objectUrl = (objectKey) =>
    `${context.nsUrl("r2", "buckets", bucket, "objects")}/${encodeR2KeyPath(objectKey)}`;

  if (group === "buckets" && action === "list") {
    const url = withQuery(context.nsUrl("r2", "buckets"), {
      cursor: values.cursor,
      limit: values.limit,
    });
    const body = await context.fetchJson(url, { headers }, "list R2 buckets");
    writeResult(values.json, body, () => formatBucketList(body), stdout);
    return;
  }

  if (group === "objects" && action === "list") {
    if (!bucket) throw new CliError("r2 objects list requires <bucket>");
    const url = withQuery(context.nsUrl("r2", "buckets", bucket, "objects"), {
      prefix: values.prefix,
      delimiter: values.delimiter,
      cursor: values.cursor,
      limit: values.limit,
    });
    const body = await context.fetchJson(url, { headers }, "list R2 objects");
    writeResult(values.json, body, () => formatObjectList(body), stdout);
    return;
  }

  if (group === "objects" && action === "get") {
    if (!bucket) throw new CliError("r2 objects get requires <bucket> <key>");
    const objectKey = requireR2ObjectKey(key);
    const res = await context.fetchStream(objectUrl(objectKey), {
      headers,
      timeoutMs: LONG_CONTROL_TIMEOUT_MS,
      maxBodyBytes: UNLIMITED_CONTROL_BODY_BYTES,
      streamResponse: true,
    }, "get R2 object");
    if (values.out) {
      const bytesWritten = await writeBodyToFile(res.body, values.out);
      writeStatusLine(stdout, `OK wrote ${bytesWritten} bytes to ${values.out}`);
    } else {
      await writeBodyToStdout(res.body, stdoutStream);
    }
    return;
  }

  if (group === "objects" && action === "head") {
    if (!bucket) throw new CliError("r2 objects head requires <bucket> <key>");
    const objectKey = requireR2ObjectKey(key);
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
    writeResult(values.json, body, () => formatObjectHead(body), stdout);
    return;
  }

  if (group === "objects" && action === "delete") {
    if (!bucket) throw new CliError("r2 objects delete requires <bucket> <key>");
    const objectKey = requireR2ObjectKey(key);
    await confirmAction({
      yes: values.yes === true,
      stdin,
      stderr,
      prompt: `Are you sure you want to delete R2 object "${ns}/${bucket}/${objectKey}"? [y/N] `,
      action: `delete R2 object "${ns}/${bucket}/${objectKey}"`,
    });
    const body = await context.fetchJson(objectUrl(objectKey), {
      method: "DELETE",
      headers,
    }, "delete R2 object");
    writeResult(values.json, body, () => [
      `OK ${body.namespace}/${body.bucket}/${body.key} deleted`,
    ], stdout);
    return;
  }

  throw new CliError(`unknown r2 command: ${group} ${action}\n${usageText()}`);
}

function withQuery(url, params) {
  const u = new URL(url);
  for (const [key, value] of Object.entries(params)) {
    if (value != null && value !== "") u.searchParams.set(key, String(value));
  }
  return u.toString();
}

function requireR2ObjectKey(key) {
  if (key == null || !String(key).trim()) {
    throw new CliError("R2 object key is required");
  }
  return String(key);
}

function encodeR2KeyPath(key) {
  const segments = String(key).split("/");
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new CliError("R2 object key must not contain . or .. path segments");
  }
  if (segments.some((segment) => segment === "")) {
    throw new CliError("R2 object key must not contain empty path segments (leading, trailing, or doubled slashes)");
  }
  return segments.map((segment) => encodeURIComponent(segment)).join("/");
}

function objectHeadFromHeaders({ namespace, bucket, key, headers }) {
  const customMetadata = {};
  for (const [name, value] of headerEntries(headers)) {
    const lower = String(name).toLowerCase();
    if (lower.startsWith("x-amz-meta-")) {
      customMetadata[lower.slice("x-amz-meta-".length)] = String(value);
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

function getHeader(headers, name) {
  if (!headers) return undefined;
  if (typeof headers.get === "function") return headers.get(name) || undefined;
  return headers[name.toLowerCase()] || headers[name] || undefined;
}

function headerEntries(headers) {
  if (!headers) return [];
  if (typeof headers.entries === "function") return headers.entries();
  return Object.entries(headers);
}

function stripEtag(etag) {
  const s = String(etag || "");
  return s.startsWith('"') && s.endsWith('"') ? s.slice(1, -1) : s;
}

async function writeBodyToStdout(body, stdoutStream) {
  for await (const chunk of body) {
    if (!stdoutStream.write(toBuffer(chunk))) await once(stdoutStream, "drain");
  }
}

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
