import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { confirmAction, readSecretStdin, readTtyLine } from "../../lib/stdin.js";

const ESC = String.fromCharCode(27);

test("readTtyLine hides input by switching the TTY to raw mode", async () => {
  const rawCalls = [];
  const stderr = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setEncoding() {},
    setRawMode(v) { rawCalls.push(v); },
    pause() {},
  });
  const pending = readTtyLine(stdin, { prompt: "tok: ", stderr: (s) => stderr.push(s), hidden: true });
  queueMicrotask(() => {
    stdin.emit("data", "sec");
    stdin.emit("data", "X" + String.fromCharCode(127)); // typo, then backspace removes it
    stdin.emit("data", "ret" + String.fromCharCode(13)); // Enter
  });
  assert.equal(await pending, "secret");
  assert.deepEqual(rawCalls, [true, false], "raw mode (echo off) enabled, then restored");
});

test("readTtyLine fails closed when a TTY cannot hide input", async () => {
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setEncoding() {},
    pause() {},
    // no setRawMode: cannot disable echo, so hidden input must reject, not leak
  });
  await assert.rejects(
    () => readTtyLine(stdin, { prompt: "tok: ", stderr: () => {}, hidden: true }),
    /cannot hide input/
  );
});

test("readSecretStdin reads a piped value to EOF, trimming one trailing newline", async () => {
  const stdin = Object.assign(new EventEmitter(), { setEncoding() {} });
  queueMicrotask(() => {
    stdin.emit("data", "sec");
    stdin.emit("data", "ret\n");
    stdin.emit("end");
  });
  assert.equal(await readSecretStdin(stdin), "secret");
});

test("readSecretStdin preserves a piped value with no trailing newline", async () => {
  const stdin = Object.assign(new EventEmitter(), { setEncoding() {} });
  queueMicrotask(() => {
    stdin.emit("data", "sec");
    stdin.emit("data", "ret");
    stdin.emit("end");
  });
  assert.equal(await readSecretStdin(stdin), "secret");
});

test("readSecretStdin trims only one trailing newline (multi-line value)", async () => {
  const stdin = Object.assign(new EventEmitter(), { setEncoding() {} });
  queueMicrotask(() => {
    stdin.emit("data", "a\nb\n\n");
    stdin.emit("end");
  });
  assert.equal(await readSecretStdin(stdin), "a\nb\n");
});

test("readSecretStdin hides input on a TTY via raw mode", async () => {
  const rawCalls = [];
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setEncoding() {},
    setRawMode(v) { rawCalls.push(v); },
    pause() {},
  });
  queueMicrotask(() => {
    stdin.emit("data", "tok");
    stdin.emit("data", "en\r");
  });
  assert.equal(await readSecretStdin(stdin, { stderr: () => {} }), "token");
  assert.deepEqual(rawCalls, [true, false], "raw mode (echo off) enabled, then restored");
});

test("readTtyLine escapes terminal controls in the prompt at the write point", async () => {
  const errs = [];
  const stdin = Object.assign(new EventEmitter(), { setEncoding() {}, pause() {} });
  queueMicrotask(() => stdin.emit("data", "y\n"));
  await readTtyLine(stdin, { prompt: `confirm ${ESC}[2J?`, stderr: (s) => errs.push(s) });
  assert.doesNotMatch(errs.join(""), new RegExp(ESC), "raw ESC from the prompt must not reach stderr");
});

test("confirmAction escapes terminal controls in its refusal message", async () => {
  const esc = String.fromCharCode(27);
  await assert.rejects(
    () => confirmAction({ stdin: /** @type {any} */ ({ isTTY: false }), action: `delete ${esc}[2J thing` }),
    (err) => {
      assert.doesNotMatch(/** @type {Error} */ (err).message, new RegExp(esc), "raw ESC must not be in the refusal error");
      assert.match(/** @type {Error} */ (err).message, /Refusing to delete/);
      return true;
    }
  );
});
