// Shared control-plane HTTP transport. undici fetch() silently strips
// the Host header, and gateway's admin-host short-circuit classifies by
// URL hostname — so we bypass fetch() and write Host explicitly.
//
// CONTROL_CONNECT_HOST overrides the TCP target for local dev while preserving
// the URL host as the HTTP Host header.

import http from "node:http";
import https from "node:https";
import { Transform } from "node:stream";
import { CliError } from "./common.js";

export const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
export const LONG_CONTROL_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_CONTROL_MAX_BODY_BYTES = 10 * 1024 * 1024;
export const UNLIMITED_CONTROL_BODY_BYTES = 0;

export function controlFetch(urlStr, init = {}) {
  const u = new URL(urlStr);
  const transport = init.transport || (u.protocol === "https:" ? https : http);
  const timeoutMs = init.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  const maxBodyBytes = init.maxBodyBytes ?? DEFAULT_CONTROL_MAX_BODY_BYTES;
  const signal = init.signal;

  const requestOpts = controlRequestOptions(u);
  requestOpts.method = init.method || "GET";
  requestOpts.headers = { ...requestOpts.headers, ...(init.headers || {}) };

  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    let streamRes = null;
    let streamBody = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      req.destroy();
      reject(err);
    };

    const failStream = (err) => {
      cleanup();
      req.destroy(err);
      if (streamRes) streamRes.destroy(err);
      if (streamBody) streamBody.destroy(err);
    };

    const failRequestOrStream = (err) => {
      if (streamRes) {
        failStream(err);
        return;
      }
      fail(err);
    };

    const onAbort = () => failRequestOrStream(new CliError("control request aborted"));
    if (signal?.aborted) {
      reject(new CliError("control request aborted"));
      return;
    }

    const resetTimer = () => {
      if (timer) clearTimeout(timer);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          failRequestOrStream(new CliError(`control request timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }
    };

    const req = transport.request(requestOpts, (res) => {
      if (init.streamResponse) {
        if (settled) return;
        settled = true;
        streamRes = res;
        streamBody = createTimeoutResetStream(resetTimer);
        res.pipe(streamBody);
        res.once("end", cleanup);
        res.once("error", (err) => {
          cleanup();
          streamBody.destroy(err);
        });
        res.once("close", cleanup);
        resolve(streamControlResponse(res, streamBody));
        return;
      }
      readControlResponse(res, { maxBodyBytes }).then((response) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(response);
      }, fail);
    });
    req.on("error", fail);
    resetTimer();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    if (init.body !== undefined && init.body !== null) req.write(init.body);
    req.end();
  });
}

// Shared socket/header options for control-plane requests (also used by
// `wdl tail`'s SSE connection, so transport fixes land in one place).
// CONTROL_CONNECT_HOST overrides the TCP target while the Host header and
// SNI keep tracking the URL authority — the ALB's cert is issued for the
// admin host.
export function controlRequestOptions(u) {
  const isHttps = u.protocol === "https:";
  const opts = {
    host: process.env.CONTROL_CONNECT_HOST || bareHostname(u),
    port: Number(u.port) || (isHttps ? 443 : 80),
    path: u.pathname + u.search,
    // u.host carries the port when it isn't the scheme default (RFC 9112).
    headers: { Host: u.host },
    agent: false,
  };
  if (isHttps) opts.servername = bareHostname(u);
  return opts;
}

// URL.hostname keeps IPv6 literals bracketed ("[::1]"), but the socket layer
// (DNS lookup, SNI) needs the bare address.
function bareHostname(u) {
  const match = /^\[(.*)\]$/.exec(u.hostname);
  return match ? match[1] : u.hostname;
}

function createTimeoutResetStream(resetTimer) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      resetTimer();
      callback(null, chunk);
    },
  });
}

function streamControlResponse(res, body) {
  return {
    status: res.statusCode,
    ok: res.statusCode >= 200 && res.statusCode < 300,
    headers: res.headers,
    body,
    text: async () => (await readControlResponse(body)).text(),
    json: async () => (await readControlResponse(body)).json(),
    arrayBuffer: async () => (await readControlResponse(body, {
      maxBodyBytes: UNLIMITED_CONTROL_BODY_BYTES,
    })).arrayBuffer(),
  };
}

export function readControlResponse(res, { maxBodyBytes = DEFAULT_CONTROL_MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    res.on("data", (c) => {
      if (settled) return;
      totalBytes += c.length;
      if (maxBodyBytes > 0 && totalBytes > maxBodyBytes) {
        // The cap must BOUND resource use, so abort the stream rather than keep
        // draining a body we've already rejected. `settled` drops any in-flight
        // chunk; `destroy?.()` also tolerates the non-stream test fakes.
        settled = true;
        res.destroy?.();
        reject(new CliError(`control response exceeded ${maxBodyBytes} bytes`));
        return;
      }
      chunks.push(c);
    });
    res.on("end", () => {
      if (settled) return;
      const buf = Buffer.concat(chunks);
      const text = () => buf.toString("utf8");
      resolve({
        status: res.statusCode,
        ok: res.statusCode >= 200 && res.statusCode < 300,
        headers: res.headers,
        text: async () => text(),
        json: async () => JSON.parse(text()),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      });
    });
    res.on("error", reject);
  });
}
