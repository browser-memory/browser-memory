import { test } from "node:test";
import assert from "node:assert/strict";

const { attachConsoleToPage, getConsoleLog, clearConsoleLog, pickConsole } = await import(
  "../src/browser/console-log.ts"
);

/**
 * Console buffer (bm_console). No real browser: we use a fake "page" that exposes
 * `on("console", cb)` and an `emit` to fire messages. This tests capture, idempotency
 * of the per-page wiring and the CAP, just like with a Playwright Page.
 */
function fakePage() {
  const cbs: Array<(m: unknown) => void> = [];
  return {
    on(ev: string, fn: (m: unknown) => void) {
      if (ev === "console") cbs.push(fn);
    },
    emit(type: string, text: string, loc?: { url: string; lineNumber: number; columnNumber: number }) {
      const msg = { type: () => type, text: () => text, location: () => loc };
      for (const f of cbs) f(msg);
    },
  };
}

test("captures type/text/location of the messages", () => {
  clearConsoleLog();
  const p = fakePage();
  attachConsoleToPage(p as never);
  p.emit("error", "boom", { url: "https://x.com/a.js", lineNumber: 4, columnNumber: 2 });
  p.emit("log", "hi");
  const log = getConsoleLog();
  assert.equal(log.length, 2);
  assert.deepEqual(log[0], { type: "error", text: "boom", location: "https://x.com/a.js:4:2" });
  assert.equal(log[1].type, "log");
  assert.equal(log[1].location, undefined);
});

test("attachConsoleToPage is idempotent: it does not duplicate the listener", () => {
  clearConsoleLog();
  const p = fakePage();
  attachConsoleToPage(p as never);
  attachConsoleToPage(p as never); // second time: must not add another listener
  p.emit("log", "once");
  assert.equal(getConsoleLog().length, 1, "a single entry per message");
});

test("respects the CAP (does not grow without bound)", () => {
  clearConsoleLog();
  const p = fakePage();
  attachConsoleToPage(p as never);
  for (let i = 0; i < 1500; i += 1) p.emit("log", `m${i}`);
  const log = getConsoleLog();
  assert.ok(log.length <= 1000, `length ${log.length} should be <= CAP(1000)`);
  assert.equal(log.length, 1000);
});

test("clearConsoleLog empties the buffer", () => {
  clearConsoleLog();
  const p = fakePage();
  attachConsoleToPage(p as never);
  p.emit("log", "x");
  assert.equal(getConsoleLog().length, 1);
  clearConsoleLog();
  assert.equal(getConsoleLog().length, 0);
});

test("getConsoleLog returns a copy (not the internal buffer)", () => {
  clearConsoleLog();
  const p = fakePage();
  attachConsoleToPage(p as never);
  p.emit("log", "x");
  const a = getConsoleLog();
  a.push({ type: "fake", text: "external mutation" });
  assert.equal(getConsoleLog().length, 1, "mutating the result must not affect the buffer");
});

/**
 * pickConsole: what `request` persists. It must prefer the agent's ONLY if it carries
 * something, so it does not silently discard the server's capture when the agent sends `console: []`.
 */
test("pickConsole: uses the server's capture if the agent passes nothing", () => {
  const captured = [{ type: "log", text: "server" }];
  assert.deepEqual(pickConsole(undefined, captured), captured);
  assert.deepEqual(pickConsole(null, captured), captured);
});

test("pickConsole: the agent's console:[] does NOT discard the server's capture", () => {
  const captured = [{ type: "log", text: "server" }];
  assert.deepEqual(pickConsole([], captured), captured);
});

test("pickConsole: if the agent carries data, that one wins", () => {
  const captured = [{ type: "log", text: "server" }];
  const agent = [{ type: "warn", text: "agent" }];
  assert.deepEqual(pickConsole(agent, captured), agent);
});
