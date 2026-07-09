// Terminal-safe output: control-character escaping (escapeTerminalText /
// escapeTerminalLines) and the output choke points built on it (writeResult /
// writeStatusLine / writeJsonOr / writeJson), plus warning + token-display
// formatting. Pure string/IO helpers — no imports.

/**
 * @param {unknown} value
 * @param {Iterable<string>} keys
 */
export function formatKnownWarning(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return escapeTerminalText(String(value));
  }

  /** @type {Record<string, string | number | boolean | Array<string | number | boolean | null>>} */
  const out = {};
  const record = /** @type {Record<string, unknown>} */ (value);
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) continue;
    const field = record[key];
    if (field == null) continue;
    if (typeof field === "string" || typeof field === "number" || typeof field === "boolean") {
      out[key] = field;
      continue;
    }
    if (Array.isArray(field) && field.every(isScalarWarningField)) {
      out[key] = field;
    }
  }
  return escapeTerminalText(JSON.stringify(out));
}

/**
 * @param {unknown} value
 * @returns {value is string | number | boolean | null}
 */
function isScalarWarningField(value) {
  return value == null ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean";
}

// Matching control characters is the whole point here.
// eslint-disable-next-line no-control-regex
const TERMINAL_CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/;

/** @param {unknown} value */
export function escapeTerminalText(value) {
  const text = String(value);
  // Fast path: almost all text is clean, and callers sit on hot paths
  // (per-event tail rendering) — one regex test beats a per-codepoint walk.
  if (!TERMINAL_CONTROL_RE.test(text)) return text;
  return escapeControlChars(text, false);
}

/** @param {unknown} value */
export function formatDiagnosticValue(value) {
  return escapeTerminalText(JSON.stringify(value));
}

// Mask a token for display: `****` plus the last 4 chars, but only when that
// reveals at most half the token (short tokens show no suffix). "(unset)" for
// an empty/absent token.
/** @param {unknown} token */
export function maskToken(token) {
  if (!token) return "(unset)";
  const text = String(token);
  const suffix = text.length <= 8 ? "" : text.slice(-4);
  return `****${suffix}`;
}

// Shared escape walk. keepLayout leaves tab/newline intact for human output.
/**
 * @param {string} text
 * @param {boolean} keepLayout
 */
function escapeControlChars(text, keepLayout) {
  let out = "";
  for (const ch of text) {
    if (keepLayout && (ch === "\t" || ch === "\n")) { out += ch; continue; }
    const code = ch.charCodeAt(0);
    out += isTerminalControlCode(code) ? escapeControlChar(ch, code) : ch;
  }
  return out;
}

/**
 * @param {string} ch
 * @param {number} code
 */
function escapeControlChar(ch, code) {
  switch (ch) {
    case "\n": return "\\n";
    case "\r": return "\\r";
    case "\t": return "\\t";
    case "\b": return "\\b";
    case "\f": return "\\f";
    case "\v": return "\\u000b";
    default: return `\\u${code.toString(16).padStart(4, "0")}`;
  }
}

/** @param {number} code */
function isTerminalControlCode(code) {
  return (code >= 0x00 && code <= 0x1f) || (code >= 0x7f && code <= 0x9f);
}

// Dangerous control characters, EXCLUDING the layout chars tab (\t, 0x09) and
// newline (\n, 0x0a): list formatters use \t as a column separator and \n as
// a real line break, and neither moves the cursor destructively the way ESC,
// CR, or C1 sequences can.
// eslint-disable-next-line no-control-regex
const TERMINAL_LAYOUT_SAFE_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/;

// Human-output variant of escapeTerminalText (keeps the layout chars per the
// regex above), used at the writeResult choke point and by tail's renderer.
/** @param {unknown} value */
export function escapeTerminalLines(value) {
  const text = String(value);
  // Fast path: clean text (tabs/newlines allowed) needs no work.
  if (!TERMINAL_LAYOUT_SAFE_RE.test(text)) return text;
  return escapeControlChars(text, true);
}

/** @param {unknown} value */
export function shellSingleQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

/** @param {unknown} value */
export function shellArgForDisplay(value) {
  return escapeTerminalText(shellSingleQuote(value));
}

// Canonical machine-JSON output: one place defines the format so the JSON from
// writeResult / writeJsonOr can't drift apart.
/**
 * @param {(line: string) => void} stdout
 * @param {unknown} body
 */
export function writeJson(stdout, body) {
  stdout(JSON.stringify(body, null, 2));
}

/**
 * @param {boolean} json
 * @param {unknown} body
 * @param {() => Iterable<string>} format
 * @param {(line: string) => void} stdout
 */
export function writeResult(json, body, format, stdout) {
  if (json) {
    writeJson(stdout, body);
    return;
  }
  // Choke point for tabular/list-style human output. One-off status lines use
  // writeStatusLine; JSON (`--json`) is machine output and left raw.
  for (const line of format()) stdout(escapeTerminalLines(line));
}

// Choke point for one-off human status lines — the non-JSON analogue of
// writeResult. Callers interpolate raw values and this escapes the assembled
// line once, so no interpolated field can be forgotten. escapeTerminalText (not
// -Lines): a status line is single-line, so an embedded newline is neutralized
// rather than allowed to split the line.
/**
 * @param {(line: string) => void} stdout
 * @param {unknown} line
 */
export function writeStatusLine(stdout, line) {
  stdout(escapeTerminalText(line));
}

// The `--json` half of a compound command's output: emit the body as machine
// JSON (left raw, like writeResult) and return true so the caller early-returns;
// return false otherwise to let it write human status lines. Keeps the json
// branch out of every subcommand.
/**
 * @param {boolean} json
 * @param {unknown} body
 * @param {(line: string) => void} stdout
 */
export function writeJsonOr(json, body, stdout) {
  if (!json) return false;
  writeJson(stdout, body);
  return true;
}
