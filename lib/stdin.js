// Reading from stdin/TTY: confirmAction (interactive [y/N] gate),
// readTtyLine (raw-mode hidden input, fail-closed), and readSecretStdin
// (the secret reader shared by `wdl token set` and `wdl secret put`).

import { CliError } from "./common.js";
import { escapeTerminalText } from "./output.js";

/**
 * A duck-typed stdin (process.stdin or a test stub). setRawMode is optional —
 * only the hidden-input path (readTtyLine) needs it.
 * @typedef {{ isTTY?: boolean, setEncoding: (encoding: string) => void, setRawMode?: (mode: boolean) => void, on: Function, off: Function, pause?: Function }} StdinLike
 */

/**
 * @param {{
 *   yes?: boolean,
 *   stdin?: StdinLike,
 *   stderr?: (text: string) => void,
 *   prompt?: string,
 *   action?: string,
 * }} [options]
 */
export async function confirmAction({
  yes = false,
  stdin = process.stdin,
  stderr = (text) => process.stderr.write(text),
  prompt,
  action = "continue",
} = {}) {
  if (yes) return;
  if (!stdin.isTTY) {
    throw new CliError(`Refusing to ${escapeTerminalText(action)} without interactive confirmation. Pass --yes to confirm.`);
  }

  const answer = await readTtyLine(stdin, { prompt, stderr });
  if (/^(y|yes)$/i.test(answer.trim())) return;
  throw new CliError("Aborted.");
}

/**
 * @param {StdinLike} stdin
 * @param {{ prompt?: string, stderr?: (text: string) => void, hidden?: boolean }} [options]
 */
export function readTtyLine(stdin, { prompt, stderr, hidden = false } = {}) {
  return new Promise((resolve, reject) => {
    let data = "";
    // Hidden input needs raw mode: a cooked TTY echoes keystrokes, so a token
    // typed at the prompt would land in the terminal and scrollback. Raw mode
    // disables echo and line editing, so we accumulate characters and handle
    // newline / backspace / Ctrl-C ourselves, echoing nothing. Hidden input
    // fails closed — if raw mode can't be enabled we reject rather than
    // silently echo a secret, leaving the caller to fall back to a pipe.
    const wantHidden = hidden && stdin.isTTY === true;
    let raw = false;

    const cleanup = () => {
      stdin.off("data", onData);
      stdin.off("end", onEnd);
      stdin.off("error", onError);
      if (raw) {
        try { stdin.setRawMode(false); } catch { /* terminal already restored */ }
        if (stderr) stderr("\n"); // the un-echoed Enter still needs a line break
      }
      if (typeof stdin.pause === "function") stdin.pause();
    };

    const finish = (value) => {
      cleanup();
      resolve(value);
    };
    const fail = (err) => {
      cleanup();
      reject(err);
    };

    const onData = (chunk) => {
      if (!raw) {
        data += chunk;
        const newline = data.search(/\r?\n/);
        if (newline !== -1) finish(data.slice(0, newline));
        return;
      }
      for (const ch of chunk) {
        if (ch === "\r" || ch === "\n") return finish(data);
        if (ch === "\u0003") return fail(new CliError("input aborted")); // Ctrl-C
        if (ch === "\u0004") return finish(data); // Ctrl-D: submit what we have
        if (ch === "\u007f" || ch === "\b") { data = data.slice(0, -1); continue; } // backspace
        data += ch;
      }
    };
    const onEnd = () => finish(raw ? data : data.replace(/\r?\n$/, ""));
    const onError = (err) => fail(err);

    stdin.setEncoding("utf8");
    if (wantHidden) {
      const failClosed = () =>
        reject(new CliError("cannot hide input on this terminal; pipe the value in instead"));
      if (typeof stdin.setRawMode !== "function") return failClosed();
      try {
        stdin.setRawMode(true);
        raw = true;
      } catch {
        return failClosed();
      }
    }
    // Single write point for every prompt: escape it here so callers can
    // interpolate raw values (ns, keys, URLs) without per-field escaping, and a
    // control byte in a user-supplied arg can't reach the terminal via a prompt.
    if (prompt && stderr) stderr(escapeTerminalText(prompt));
    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
  });
}

// Read a single secret value from stdin: a TTY prompts with hidden (raw-mode,
// non-echoing) input; a pipe/redirect is read to EOF with one trailing newline
// trimmed, so `printf '%s' "$SECRET" | …` works. Shared by `wdl token set` and
// `wdl secret put`.
/**
 * @param {StdinLike} stdin
 * @param {{ prompt?: string, stderr?: (text: string) => void }} [options]
 */
export function readSecretStdin(stdin, { prompt, stderr } = {}) {
  if (stdin.isTTY) return readTtyLine(stdin, { prompt, stderr, hidden: true });
  return new Promise((resolve, reject) => {
    let data = "";
    stdin.setEncoding("utf8");
    stdin.on("data", (chunk) => (data += chunk));
    stdin.on("end", () => resolve(data.replace(/\r?\n$/, "")));
    stdin.on("error", reject);
  });
}
