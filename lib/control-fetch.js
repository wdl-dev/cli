// Shared control-plane HTTP transport. undici fetch() silently strips
// the Host header, and gateway's admin-host short-circuit classifies by
// URL hostname — so we bypass fetch() and write Host explicitly.
//
// CONTROL_CONNECT_HOST overrides the TCP target for local dev while preserving
// the URL host as the HTTP Host header.

import http from "node:http";
import https from "node:https";
import { isIP } from "node:net";
import { Transform } from "node:stream";
import { CliError } from "./common.js";
import { bareUrlHostname, parseControlConnectHost } from "./control-connect-host.js";
import { escapeTerminalText, formatDiagnosticValue } from "./output.js";
import { currentCliVersion } from "./package-info.js";

export const DEFAULT_CONTROL_TIMEOUT_MS = 30_000;
export const LONG_CONTROL_TIMEOUT_MS = 5 * 60_000;
export const DEFAULT_CONTROL_MAX_BODY_BYTES = 16 * 1024 * 1024;
export const UNLIMITED_CONTROL_BODY_BYTES = 0;

/**
 * The buffered-or-streamed control-plane response shape returned by
 * {@link controlFetch}, {@link readControlResponse}, and
 * {@link streamControlResponse}. `body` is present only on a streamed response.
 * @typedef {object} ControlResponse
 * @property {number | undefined} status        HTTP status code (undefined for non-stream test fakes).
 * @property {boolean} ok                        True for a 2xx status.
 * @property {import("node:http").IncomingHttpHeaders} headers
 * @property {import("node:stream").Readable} [body]  Streamed body (streamResponse only).
 * @property {() => Promise<string>} text
 * @property {() => Promise<unknown>} json
 * @property {() => Promise<ArrayBuffer>} arrayBuffer
 */

/**
 * The minimal control-response surface the status/error helpers read: enough to
 * decide ok/error and read the textual body. Broader than {@link ControlResponse}
 * on purpose so the unit-test response fakes (which omit `headers`) still fit.
 * @typedef {object} ControlResponseStatus
 * @property {boolean} ok
 * @property {number} [status]
 * @property {import("node:http").IncomingHttpHeaders} [headers]
 * @property {() => Promise<string>} text
 */

/**
 * A control response whose JSON body can be read after the status check. `json`
 * is optional because error-path callers only reach `text()` — a 2xx response
 * always carries it.
 * @typedef {ControlResponseStatus & { json?: () => Promise<unknown> }} ControlJsonResponse
 */

/**
 * The minimal client-request surface `controlFetch` drives. Real
 * `http.ClientRequest` satisfies it; so does the unit-test fake.
 * @typedef {object} ControlClientRequest
 * @property {<A extends unknown[]>(event: string, listener: (...args: A) => void) => unknown} on
 * @property {(chunk: string | Buffer | Uint8Array) => unknown} write
 * @property {() => unknown} end
 * @property {(error?: Error) => unknown} destroy
 */

/**
 * The transport surface `controlFetch` uses: just `request()`. Real `node:http`
 * / `node:https` satisfy it, and so does the unit-test fake (which provides only
 * `request`).
 * @typedef {{ request: (options: import("node:https").RequestOptions, onResponse: (res: import("node:http").IncomingMessage) => void) => ControlClientRequest }} ControlTransport
 */

/**
 * @typedef {object} ControlFetchInit
 * @property {ControlTransport} [transport]
 * @property {number} [timeoutMs]
 * @property {number} [maxBodyBytes]
 * @property {AbortSignal} [signal]
 * @property {NodeJS.ProcessEnv} [env]
 * @property {string} [method]
 * @property {import("node:http").OutgoingHttpHeaders} [headers]
 * @property {boolean} [streamResponse]
 * @property {string | Buffer | Uint8Array | null} [body]
 */

/**
 * @param {string} urlStr
 * @param {ControlFetchInit} [init]
 * @returns {Promise<ControlResponse>}
 */
export function controlFetch(urlStr, init = {}) {
  const u = new URL(urlStr);
  const transport = init.transport || (u.protocol === "https:" ? https : http);
  const timeoutMs = init.timeoutMs ?? DEFAULT_CONTROL_TIMEOUT_MS;
  const maxBodyBytes = init.maxBodyBytes ?? DEFAULT_CONTROL_MAX_BODY_BYTES;
  const signal = init.signal;

  const requestOpts = controlRequestOptions(u, init.env);
  requestOpts.method = init.method || "GET";
  requestOpts.headers = { ...requestOpts.headers, ...(init.headers || {}) };
  validateControlHeaders(/** @type {import("node:http").OutgoingHttpHeaders} */ (requestOpts.headers));

  return new Promise((resolve, reject) => {
    let settled = false;
    /** @type {ReturnType<typeof setTimeout> | null} */
    let timer = null;
    /** @type {import("node:http").IncomingMessage | null} */
    let streamRes = null;
    /** @type {import("node:stream").Transform | null} */
    let streamBody = null;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (signal) signal.removeEventListener("abort", onAbort);
    };

    /** @param {Error} err */
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      req?.destroy();
      reject(controlRequestError(err));
    };

    /** @param {Error} err */
    const failStream = (err) => {
      cleanup();
      req?.destroy(err);
      if (streamRes) streamRes.destroy(err);
      if (streamBody) streamBody.destroy(err);
    };

    /** @param {Error} err */
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

    /** @type {ControlClientRequest | null} */
    let req = null;
    try {
      req = transport.request(requestOpts, (res) => {
        if (init.streamResponse) {
          if (settled) return;
          settled = true;
          streamRes = res;
          const body = createTimeoutResetStream(resetTimer);
          streamBody = body;
          res.pipe(body);
          res.once("end", cleanup);
          res.once("error", (err) => {
            cleanup();
            body.destroy(err);
          });
          res.once("close", cleanup);
          resolve(streamControlResponse(res, body));
          return;
        }
        readControlResponse(res, { maxBodyBytes }).then((response) => {
          if (settled) return;
          settled = true;
          cleanup();
          resolve(response);
        }, fail);
      });
    } catch (err) {
      reject(controlRequestError(toError(err)));
      return;
    }
    req.on("error", fail);
    resetTimer();
    if (signal) signal.addEventListener("abort", onAbort, { once: true });
    if (init.body !== undefined && init.body !== null) req.write(init.body);
    req.end();
  });
}

/**
 * @param {import("node:http").OutgoingHttpHeaders | undefined} headers
 */
export function validateControlHeaders(headers) {
  if (!headers) return;
  for (const [name, value] of Object.entries(headers)) {
    try {
      http.validateHeaderName(name);
      if (Array.isArray(value)) {
        for (const item of value) http.validateHeaderValue(name, item);
      } else if (value !== undefined) {
        http.validateHeaderValue(name, typeof value === "number" ? String(value) : value);
      }
    } catch (err) {
      const message = err instanceof Error && err.message ? err.message : String(err);
      throw new CliError(`control request failed: invalid HTTP header ${formatDiagnosticValue(name)}: ${escapeTerminalText(message)}`);
    }
  }
}

/** @param {unknown} err */
function toError(err) {
  return err instanceof Error ? err : new Error(String(err));
}

/** @param {Error} err */
export function controlRequestError(err) {
  if (err instanceof CliError) return err;
  const codeValue = (/** @type {{ code?: unknown }} */ (/** @type {unknown} */ (err))).code;
  const code = typeof codeValue === "string"
    ? `${escapeTerminalText(codeValue)} `
    : "";
  const message = escapeTerminalText(err.message || String(err));
  return new CliError(`control request failed: ${code}${message}`);
}

// Shared socket/header options for control-plane requests (also used by
// `wdl tail`'s SSE connection, so transport fixes land in one place).
// CONTROL_CONNECT_HOST overrides the TCP target while the Host header and
// SNI keep tracking the URL authority — the ALB's cert is issued for the
// admin host.
/**
 * @param {URL} u
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {import("node:https").RequestOptions}
 */
export function controlRequestOptions(u, env = process.env) {
  const isHttps = u.protocol === "https:";
  const target = controlConnectTarget(u, isHttps, env);
  const tlsServerName = bareHostname(u);
  /** @type {import("node:https").RequestOptions} */
  const opts = {
    host: target.host,
    port: target.port,
    path: u.pathname + u.search,
    // u.host carries the port when it isn't the scheme default (RFC 9112).
    headers: {
      Host: u.host,
      "User-Agent": `wdl-cli/${currentCliVersion()}`,
    },
    agent: false,
  };
  if (isHttps && isIP(tlsServerName) === 0) opts.servername = tlsServerName;
  return opts;
}

/**
 * @param {URL} u
 * @param {boolean} isHttps
 * @param {NodeJS.ProcessEnv} env
 * @returns {{ host: string, port: number }}
 */
function controlConnectTarget(u, isHttps, env) {
  const defaultPort = Number(u.port) || (isHttps ? 443 : 80);
  const override = env.CONTROL_CONNECT_HOST;
  if (!override) return { host: bareHostname(u), port: defaultPort };
  return parseControlConnectHost(override, defaultPort);
}

// URL.hostname keeps IPv6 literals bracketed ("[::1]"), but the socket layer
// (DNS lookup, SNI) needs the bare address.
/** @param {URL} u */
function bareHostname(u) {
  return bareUrlHostname(u);
}

/** @param {() => void} resetTimer */
function createTimeoutResetStream(resetTimer) {
  return new Transform({
    transform(chunk, _encoding, callback) {
      resetTimer();
      callback(null, chunk);
    },
  });
}

/**
 * @param {import("node:http").IncomingMessage} res
 * @param {import("node:stream").Readable} body
 * @returns {ControlResponse}
 */
function streamControlResponse(res, body) {
  const status = res.statusCode;
  return {
    status,
    ok: status !== undefined && status >= 200 && status < 300,
    headers: res.headers,
    body,
    text: async () => (await readControlResponse(body)).text(),
    json: async () => (await readControlResponse(body)).json(),
    arrayBuffer: async () => (await readControlResponse(body, {
      maxBodyBytes: UNLIMITED_CONTROL_BODY_BYTES,
    })).arrayBuffer(),
  };
}

/**
 * The readable source `readControlResponse` drains: either a real
 * `IncomingMessage` (status/headers populated) or the internal pipe stream used
 * for a streamed body (status/headers absent, re-read off the already-captured
 * `ControlResponse`). `destroy` is optional to tolerate the non-stream test fakes.
 * @typedef {object} ControlBodySource
 * @property {<A extends unknown[]>(event: string, listener: (...args: A) => void) => unknown} on
 * @property {number} [statusCode]
 * @property {import("node:http").IncomingHttpHeaders} [headers]
 * @property {() => void} [destroy]
 */

/**
 * @param {ControlBodySource} res
 * @param {{ maxBodyBytes?: number }} [options]
 * @returns {Promise<ControlResponse>}
 */
export function readControlResponse(res, { maxBodyBytes = DEFAULT_CONTROL_MAX_BODY_BYTES } = {}) {
  return new Promise((resolve, reject) => {
    /** @type {Buffer[]} */
    const chunks = [];
    let totalBytes = 0;
    let settled = false;
    res.on("data", (/** @type {Buffer} */ c) => {
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
      const status = res.statusCode;
      resolve({
        status,
        ok: status !== undefined && status >= 200 && status < 300,
        headers: res.headers ?? {},
        text: async () => text(),
        json: async () => JSON.parse(text()),
        arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
      });
    });
    res.on("error", reject);
  });
}
