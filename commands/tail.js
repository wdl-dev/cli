// `wdl tail <worker...>` — live SSE log stream against control's
// /ns/<ns>/logs/tail endpoint. The transport shares controlRequestOptions
// with lib/control-fetch.js but consumes the body as a stream so events
// render as they arrive rather than at end-of-response.

import http from "node:http";
import https from "node:https";
import { defineCommand } from "../lib/command.js";
import {
  controlRequestError,
  controlRequestOptions,
  validateControlHeaders,
} from "../lib/control-fetch.js";
import { CliError, defineCliOption, formatHelp, isMain, isNonEmptyString, optionHelp } from "../lib/common.js";
import { escapeTerminalLines, escapeTerminalText, formatDiagnosticValue } from "../lib/output.js";

const RECONNECT_INITIAL_MS = 1_000;
const RECONNECT_MAX_MS = 5_000;
const RECONNECT_STABLE_MS = 30_000;
// Default for --max-reconnects: bail after this many consecutive
// cap-stuck attempts. `--max-reconnects 0` disables the cap.
const DEFAULT_MAX_RECONNECTS_AT_CAP = 10;
const TAIL_CONNECT_TIMEOUT_MS = 30_000;
const TAIL_ERROR_BODY_MAX_BYTES = 64 * 1024;
export const SSE_MAX_LINE_CHARS = 1024 * 1024;
// Socket-shutdown error shapes we tolerate as "our own abort".
// Anything else (e.g. a 5xx racing the abort) bubbles to the user.
const ABORT_TOLERATED_ERRORS = new Set([
  "ECONNRESET", "ECONNABORTED", "EPIPE", "ABORT_ERR",
]);

const TAIL_OPTIONS = [
  defineCliOption("raw", { type: "boolean" }, "--raw", "Emit one JSON object per line (no pretty-print)."),
  defineCliOption("since", { type: "string" }, "--since <id>", "Resume from the given Redis stream id (single-worker only)."),
  defineCliOption("max-reconnects", { type: "string" }, "--max-reconnects <N>", `Bail after N consecutive reconnect attempts that all stayed at the ${RECONNECT_MAX_MS}ms backoff cap (default ${DEFAULT_MAX_RECONNECTS_AT_CAP}, 0 = unlimited).`),
  "ns",
  "control",
  "help",
];

/** @param {unknown} err */
function isExpectedAbortError(err) {
  if (!err || typeof err !== "object") return false;
  const e = /** @type {{ name?: unknown, code?: unknown }} */ (err);
  if (e.name === "AbortError") return true;
  if (typeof e.code === "string" && ABORT_TOLERATED_ERRORS.has(e.code)) return true;
  return false;
}

/** @param {unknown} err */
function toError(err) {
  return err instanceof Error ? err : new Error(String(err));
}

/** @returns {Error & { code: string }} */
function tailAbortError() {
  const err = /** @type {Error & { code: string }} */ (new Error("tail request aborted"));
  err.name = "AbortError";
  err.code = "ABORT_ERR";
  return err;
}

const command = defineCommand({
  name: "tail",
  summary: "Live-tail worker console output and uncaught exceptions.",
  options: TAIL_OPTIONS,
  // tail writes line-at-a-time to both streams with an explicit newline.
  defaults: {
    stdout: (/** @type {string} */ line) => process.stdout.write(line + "\n"),
    stderr: (/** @type {string} */ line) => process.stderr.write(line + "\n"),
    transport: null,
    sleepFn: sleep,
    now: () => Date.now(),
  },
  usage: usageText,
  run: runTail,
});

export const main = command.main;
export const runTailCommand = command.run;
export const meta = command.meta;

/**
 * A parsed SSE event handed to the renderer.
 * @typedef {object} SseEvent
 * @property {string} event   The SSE `event:` field (defaults to "message").
 * @property {string | null} id   The last seen SSE `id:` field, if any.
 * @property {string} data    The concatenated `data:` payload.
 */

/**
 * The shape this command reads off a decoded tail event payload. Tail events
 * carry arbitrary worker-controlled fields; only the ones consumed here are
 * declared, all optional and loosely typed since they cross the wire.
 * @typedef {object} TailPayload
 * @property {string} [event]
 * @property {unknown} [raw]
 * @property {string} [code]
 * @property {string} [message]
 * @property {number} [ts]
 * @property {string} [worker]
 * @property {string} [console_level]
 * @property {string} [name]
 * @property {string} [stack]
 * @property {string} [phase]
 * @property {unknown} [cron]
 * @property {unknown} [scheduled_time]
 * @property {string} [outcome]
 * @property {unknown} [duration_ms]
 * @property {unknown} [error]
 * @property {string} [queue]
 * @property {unknown} [batch_size]
 * @property {string} [method]
 * @property {string} [path]
 * @property {boolean} [path_truncated]
 * @property {unknown} [status]
 */

/**
 * The result of one SSE connection lifecycle: empty on a clean end, or
 * `{ fatal }` carrying an error detail to surface and stop reconnecting.
 * @typedef {{ fatal?: string, serverRecycle?: boolean }} StreamResult
 */

/**
 * The tail run context: the framework base plus the injectable transport and
 * timing hooks declared in this command's `defaults`.
 * @typedef {import("../lib/command.js").CommandContext & {
 *   transport: import("../lib/control-fetch.js").ControlTransport | null,
 *   sleepFn: (ms: number, signal?: AbortSignal) => Promise<void>,
 *   now: () => number,
 * }} TailContext
 */

/** @param {{ values: import("../lib/command.js").PresetFlags<"ns" | "control"> & { raw?: boolean, since?: string, "max-reconnects"?: string }, positionals: string[], context: import("../lib/command.js").CommandContext }} arg */
async function runTail({ values, positionals, context: baseContext }) {
  const context = /** @type {TailContext} */ (baseContext);
  const { stdout, stderr, transport, sleepFn, now } = context;

  // Non-negative integer; 0 = unlimited. Reject other shapes loudly
  // rather than silently falling back to the default.
  let maxReconnectsAtCap = DEFAULT_MAX_RECONNECTS_AT_CAP;
  if (values["max-reconnects"] !== undefined) {
    const raw = values["max-reconnects"];
    if (!/^\d+$/.test(raw)) {
      throw new CliError(
        `--max-reconnects must be a non-negative integer (got ${formatDiagnosticValue(raw)}); ` +
        `use 0 to disable the cap`,
      );
    }
    maxReconnectsAtCap = Number(raw);
  }

  const ns = context.resolveNamespace();
  if (!ns) throw new CliError(usageText());

  if (positionals.length === 0) {
    throw new CliError("Specify one or more worker names.");
  }

  const isMultiWorker = positionals.length > 1;
  if (values.since && isMultiWorker) {
    throw new CliError("--since is only valid for single-worker subscriptions.");
  }

  const { headers: baseHeaders } = context.resolveControl();
  const tailBase = context.nsUrl("logs", "tail");
  // `--since` only applies until the server has handed us an SSE id we can
  // resume from. Keep it on the URL across reconnects until that point;
  // once lastEventId is set, switch to the no-since URL and let
  // Last-Event-ID carry the cursor so we never replay events already seen.
  const initialUrl = buildTailUrl({
    baseUrl: tailBase,
    workers: positionals,
    since: values.since,
  });
  const reconnectUrl = buildTailUrl({
    baseUrl: tailBase,
    workers: positionals,
    since: undefined,
  });
  const raw = Boolean(values.raw);

  // Single-worker sessions persist Last-Event-ID across in-process
  // reconnect attempts so a network blip resumes from where we left off.
  // Multi-worker sessions always fresh-start because one SSE cursor cannot
  // represent several independent Redis Stream cursors.
  let lastEventId = null;

  const ctrl = new AbortController();
  const onSig = () => ctrl.abort();
  process.once("SIGINT", onSig);
  process.once("SIGTERM", onSig);

  let backoff = RECONNECT_INITIAL_MS;
  let attempts = 0;
  let consecutiveAtCap = 0;
  try {
    while (!ctrl.signal.aborted) {
      const requestHeaders = { ...baseHeaders };
      if (lastEventId && !isMultiWorker) {
        requestHeaders["last-event-id"] = lastEventId;
      }
      // Transport-level errors (ECONNRESET / EPIPE / DNS / control
      // restart) flow through the catch into the next reconnect
      // attempt with the latest Last-Event-ID. CliError still
      // propagates fatally, and a transport error AFTER user abort
      // also propagates (something unexpected happened during the
      // shutdown — the caller should see it).
      let result;
      let transportErr = null;
      let connectedAt = null;
      try {
        const hasResumeCursor = lastEventId !== null;
        result = await streamSse({
          url: attempts === 0 || (values.since && !hasResumeCursor)
            ? initialUrl
            : reconnectUrl,
          headers: requestHeaders, signal: ctrl.signal, env: context.env, transport,
          // renderEvent writes stdout synchronously — fine for TTY
          // backpressure; tail isn't a guaranteed-delivery surface.
          onEvent: (event) => {
            if (event.id) lastEventId = event.id;
            return renderEvent({ event, raw, stdout, stderr, isMultiWorker });
          },
          onConnected: () => {
            connectedAt = now();
            stderr(attempts === 0
              ? "tail connected; waiting for events…"
              : "tail reconnected; waiting for events…");
          },
        });
      } catch (err) {
        if (err instanceof CliError) throw err;
        if (ctrl.signal.aborted) throw err;
        transportErr = err;
      }
      attempts += 1;

      if (ctrl.signal.aborted) break;
      // Ended without a fatal error — server closed cleanly. For a 4xx /
      // 5xx response with a JSON error body, surface it and exit instead
      // of looping (the request would just keep failing).
      if (result?.fatal) {
        throw new CliError(result.fatal);
      }
      if (result?.serverRecycle) {
        backoff = RECONNECT_INITIAL_MS;
        consecutiveAtCap = 0;
      }
      const connectedAtMs = connectedAt;
      const connectionAgeMs = typeof connectedAtMs === "number" ? now() - connectedAtMs : 0;
      const stableConnection = connectionAgeMs >= RECONNECT_STABLE_MS;
      if (stableConnection) {
        backoff = RECONNECT_INITIAL_MS;
        consecutiveAtCap = 0;
      }
      if (transportErr) {
        const detail = transportErr instanceof Error
          ? `${transportErr.name}: ${transportErr.message}`
          : String(transportErr);
        stderr(`tail transport error (${escapeTerminalText(detail)}); will reconnect`);
      }
      // Only stable sessions reset consecutiveAtCap. A flapping network can
      // establish TCP/TLS and still die quickly; keep backing off there.
      if (backoff >= RECONNECT_MAX_MS) {
        consecutiveAtCap += 1;
        if (maxReconnectsAtCap > 0 && consecutiveAtCap >= maxReconnectsAtCap) {
          throw new CliError(
            `tail: gave up after ${consecutiveAtCap} consecutive reconnects ` +
            `failed at the ${RECONNECT_MAX_MS}ms backoff cap ` +
            `(override with --max-reconnects N, or 0 to disable)`,
          );
        }
      }
      stderr(`tail disconnected; reconnecting in ${backoff}ms…`);
      await sleepFn(backoff, ctrl.signal);
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS);
    }
  } finally {
    process.off("SIGINT", onSig);
    process.off("SIGTERM", onSig);
  }
}

/** @param {{ baseUrl: string, workers: string[], since?: string }} arg */
function buildTailUrl({ baseUrl, workers, since }) {
  const u = new URL(baseUrl);
  for (const w of workers) u.searchParams.append("worker", w);
  if (since) u.searchParams.set("since", since);
  return u.toString();
}

/**
 * @param {number} ms
 * @param {AbortSignal} [signal]
 * @returns {Promise<void>}
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const onAbort = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// One SSE connection lifecycle. Returns when the body ends (clean) or on
// a non-2xx status (returns {fatal} for caller to surface). Throws on
// transport-level errors so the reconnect loop sees them.
/**
 * @param {{
 *   url: string,
 *   headers: Record<string, string>,
 *   signal: AbortSignal | undefined,
 *   env: NodeJS.ProcessEnv,
 *   transport: import("../lib/control-fetch.js").ControlTransport | null,
 *   onEvent: (event: SseEvent) => "server-recycle" | void,
 *   onConnected?: () => void,
 * }} arg
 * @returns {Promise<StreamResult>}
 */
function streamSse({ url, headers, signal, env, transport, onEvent, onConnected }) {
  /** @type {(() => void) | null} */
  let onAbort = null;
  /** @type {Promise<StreamResult>} */
  const promise = new Promise((resolve, reject) => {
    const u = new URL(url);
    const lib = transport || (u.protocol === "https:" ? https : http);
    const reqOpts = controlRequestOptions(u, env);
    reqOpts.method = "GET";
    reqOpts.headers = { ...reqOpts.headers, Accept: "text/event-stream", ...headers };
    validateControlHeaders(/** @type {import("node:http").OutgoingHttpHeaders} */ (reqOpts.headers));
    /** @type {ReturnType<typeof setTimeout> | null} */
    let connectTimer = null;
    const clearConnectTimer = () => {
      if (connectTimer) clearTimeout(connectTimer);
      connectTimer = null;
    };

    let serverRecycle = false;
    /** @type {import("../lib/control-fetch.js").ControlClientRequest} */
    let req;
    try {
      req = lib.request(reqOpts, (/** @type {import("node:http").IncomingMessage} */ res) => {
        clearConnectTimer();
        const status = res.statusCode || 0;
        /** @param {unknown} err */
        const onResponseError = (err) => {
          if (signal?.aborted && isExpectedAbortError(err)) return resolve({});
          reject(err);
        };
        res.on("error", onResponseError);
        if (status < 200 || status >= 300) {
          /** @type {Buffer[]} */
          const chunks = [];
          let total = 0;
          res.on("data", (/** @type {Buffer} */ c) => {
            total += c.length;
            if (total <= TAIL_ERROR_BODY_MAX_BYTES) chunks.push(c);
          });
          res.on("end", () => {
            let detail;
            try {
              const body = /** @type {{ message?: string, error?: string }} */ (JSON.parse(Buffer.concat(chunks).toString("utf8")));
              detail = escapeTerminalText(body.message || body.error || `HTTP ${status}`);
            } catch {
              detail = `HTTP ${status}`;
            }
            resolve({ fatal: detail });
          });
          return;
        }
        onConnected?.();
        const parser = new SseParser((event) => {
          if (onEvent(event) === "server-recycle") serverRecycle = true;
        });
        res.setEncoding("utf8");
        res.on("data", (/** @type {string} */ chunk) => {
          try {
            parser.push(chunk);
          } catch (err) {
            req.destroy();
            reject(err);
          }
        });
        res.on("end", () => {
          try {
            parser.flush();
            resolve({ serverRecycle });
          } catch (err) {
            reject(err);
          }
        });
      });
    } catch (err) {
      reject(controlRequestError(toError(err)));
      return;
    }
    req.on("error", (/** @type {unknown} */ err) => {
      clearConnectTimer();
      if (signal?.aborted && isExpectedAbortError(err)) return resolve({});
      reject(err);
    });
    onAbort = () => {
      clearConnectTimer();
      req.destroy(tailAbortError());
    };
    if (signal) {
      signal.addEventListener("abort", onAbort, { once: true });
    }
    connectTimer = setTimeout(() => {
      req.destroy();
      reject(new Error(`tail connection timed out after ${TAIL_CONNECT_TIMEOUT_MS}ms before response headers`));
    }, TAIL_CONNECT_TIMEOUT_MS);
    if (typeof connectTimer === "object" && typeof connectTimer.unref === "function") {
      connectTimer.unref();
    }
    req.end();
  });
  // Drop the session-long signal listener once this connection settles so a
  // flapping reconnect loop doesn't accumulate one closure per attempt.
  return signal
    ? promise.finally(() => { if (onAbort) signal.removeEventListener("abort", onAbort); })
    : promise;
}

// Spec-style SSE line parser. Handles `event:`, `id:`, `data:` (multi-line
// concatenated with `\n`), comments (`:`) and dispatches on blank line.
// Field-value parse rule: optional single space after the colon is
// trimmed (per W3C SSE spec).
export class SseParser {
  /** @param {(event: SseEvent) => void} onEvent */
  constructor(onEvent) {
    this.onEvent = onEvent;
    this.buffer = "";
    this.maxLineChars = SSE_MAX_LINE_CHARS;
    this.event = "message";
    /** @type {string | null} */
    this.id = null;
    /** @type {string[]} */
    this.data = [];
  }
  /** @param {string} chunk */
  push(chunk) {
    this.buffer += chunk;
    let idx;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      let line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      this.assertLineLength(line);
      this.consumeLine(line);
    }
    this.assertLineLength(this.buffer);
  }
  flush() {
    if (this.buffer.length > 0) {
      this.assertLineLength(this.buffer);
      this.consumeLine(this.buffer);
      this.buffer = "";
    }
    this.dispatch();
  }
  /** @param {string} line */
  consumeLine(line) {
    if (line === "") {
      this.dispatch();
      return;
    }
    if (line.startsWith(":")) return; // comment
    const colon = line.indexOf(":");
    let field, value;
    if (colon < 0) { field = line; value = ""; }
    else {
      field = line.slice(0, colon);
      value = line.slice(colon + 1);
      if (value.startsWith(" ")) value = value.slice(1);
    }
    if (field === "event") this.event = value;
    else if (field === "id") this.id = value;
    else if (field === "data") this.data.push(value);
    // unknown fields ignored per spec
  }
  dispatch() {
    if (this.data.length === 0) {
      // Reset event name even when there's no data so a subsequent
      // event without an explicit `event:` line falls back to "message".
      this.event = "message";
      return;
    }
    this.onEvent({ event: this.event, id: this.id, data: this.data.join("\n") });
    this.event = "message";
    // SSE spec: `id` persists until a new id (or `id:` with empty value)
    // overwrites it. We don't reset it.
    this.data = [];
  }
  /** @param {string} line */
  assertLineLength(line) {
    if (line.length > this.maxLineChars) {
      throw new CliError(`tail SSE line exceeded ${this.maxLineChars} characters`);
    }
  }
}

/**
 * @param {{
 *   event: SseEvent,
 *   raw: boolean,
 *   stdout: (line: string) => void,
 *   stderr: (line: string) => void,
 *   isMultiWorker: boolean,
 * }} arg
 */
function renderEvent({ event, raw, stdout, stderr, isMultiWorker }) {
  /** @type {TailPayload} */
  let payload;
  try {
    const decoded = JSON.parse(event.data);
    payload = decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? /** @type {TailPayload} */ (decoded)
      : { event: event.event, raw: decoded };
  } catch {
    payload = { event: event.event, raw: event.data };
  }

  const eventType = payload.event || event.event;
  const isServerRecycle = eventType === "tail_warning" &&
    (payload.code === "session_idle" || payload.code === "session_expired");

  if (raw) {
    stdout(JSON.stringify(payload));
    return isServerRecycle ? "server-recycle" : undefined;
  }

  // Everything below interpolates worker-controlled text (console args,
  // exception messages, request-derived fields) into the operator's
  // terminal. Escape control sequences so a logged "\x1b]0;…" can't drive
  // the terminal; multi-line payloads (console output, stacks) keep their
  // newlines but every line is escaped.
  if (eventType === "tail_warning") {
    if (isServerRecycle) {
      stderr(`tail ${escapeTerminalText(payload.code)}: ${escapeTerminalText(payload.message || "session closed by control")}`);
      return "server-recycle";
    }
    stderr(`! tail_warning ${escapeTerminalText(payload.code || "")}: ${escapeTerminalText(payload.message || "")}`);
    return;
  }

  const ts = typeof payload.ts === "number"
    ? new Date(payload.ts).toISOString()
    : new Date().toISOString();
  const prefix = isMultiWorker && payload.worker ? `[${escapeTerminalText(payload.worker)}] ` : "";

  if (eventType === "worker_console") {
    const level = payload.console_level || "log";
    stdout(`${prefix}${ts} ${escapeTerminalText(level)} ${escapeTerminalLines(formatConsoleArgs(payload.message))}`);
    return;
  }

  if (eventType === "worker_exception") {
    // workerd tail surfaces stack as the trimmed `at …` body without
    // the "<name>: <message>\n" header. Always emit name+message, then
    // append stack on its own line if present. If a future workerd
    // version DOES prefix the header, strip it so we don't double-print.
    const name = payload.name ? `${payload.name}: ` : "";
    const headLine = `${name}${stringifyMessage(payload.message)}`;
    stdout(`${prefix}${ts} exception ${escapeTerminalLines(headLine)}`);
    if (isNonEmptyString(payload.stack)) {
      const stack = payload.stack.startsWith(headLine + "\n")
        ? payload.stack.slice(headLine.length + 1)
        : payload.stack;
      stdout(escapeTerminalLines(stack));
    }
    return;
  }

  if (eventType === "worker_scheduled") {
    const bits = [`scheduled`, payload.phase || "event"];
    if (payload.cron) bits.push(`cron=${JSON.stringify(payload.cron)}`);
    if (payload.scheduled_time != null) bits.push(`scheduled_time=${payload.scheduled_time}`);
    if (payload.outcome) bits.push(`outcome=${payload.outcome}`);
    if (payload.duration_ms != null) bits.push(`duration_ms=${payload.duration_ms}`);
    if (payload.error) bits.push(`error=${JSON.stringify(payload.error)}`);
    stdout(`${prefix}${ts} ${escapeTerminalText(bits.join(" "))}`);
    return;
  }

  if (eventType === "worker_queue") {
    const bits = [`queue`, payload.phase || "event"];
    if (payload.queue) bits.push(`name=${payload.queue}`);
    if (payload.batch_size != null) bits.push(`batch_size=${payload.batch_size}`);
    if (payload.outcome) bits.push(`outcome=${payload.outcome}`);
    if (payload.duration_ms != null) bits.push(`duration_ms=${payload.duration_ms}`);
    if (payload.error) bits.push(`error=${JSON.stringify(payload.error)}`);
    stdout(`${prefix}${ts} ${escapeTerminalText(bits.join(" "))}`);
    return;
  }

  if (eventType === "worker_fetch") {
    const bits = [`fetch`, payload.phase || "event"];
    if (payload.method) bits.push(`method=${payload.method}`);
    const displayPath = formatFetchDisplayPath(payload);
    if (displayPath) {
      const truncated = payload.path_truncated ? " (truncated)" : "";
      bits.push(`path=${JSON.stringify(displayPath)}${truncated}`);
    }
    if (payload.status != null) bits.push(`status=${payload.status}`);
    if (payload.outcome) bits.push(`outcome=${payload.outcome}`);
    if (payload.duration_ms != null) bits.push(`duration_ms=${payload.duration_ms}`);
    if (payload.error) bits.push(`error=${JSON.stringify(payload.error)}`);
    stdout(`${prefix}${ts} ${escapeTerminalText(bits.join(" "))}`);
    return;
  }

  // Unknown event type — fall back to JSON so the user sees something.
  stdout(`${prefix}${ts} ${escapeTerminalText(eventType)} ${escapeTerminalText(JSON.stringify(payload))}`);
}

/**
 * @param {TailPayload} payload
 * @returns {string | null}
 */
function formatFetchDisplayPath(payload) {
  if (typeof payload.path !== "string") return null;
  if (typeof payload.worker !== "string" || payload.worker.length === 0) {
    return payload.path;
  }
  const suffix = payload.path.startsWith("/") ? payload.path : `/${payload.path}`;
  return suffix === "/" ? `/${payload.worker}/` : `/${payload.worker}${suffix}`;
}

// Workerd's tail event surfaces console.log("a", "b") as message=["a","b"]
// (varargs preserved). Render "console.log-style": one arg unwrapped,
// many args space-separated, each non-string lossless via JSON.
/** @param {unknown} message */
function formatConsoleArgs(message) {
  if (Array.isArray(message)) {
    return message.map(stringifyMessage).join(" ");
  }
  return stringifyMessage(message);
}

/** @param {unknown} value */
function stringifyMessage(value) {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

function usageText() {
  return formatHelp({
    usage: [
      "wdl tail <worker> [<worker>...] [options]",
    ],
    description: "Live-tail worker console, exception, fetch, scheduled, and queue events in a namespace.",
    options: optionHelp(TAIL_OPTIONS),
  });
}

if (isMain(import.meta.url)) {
  await main();
}
