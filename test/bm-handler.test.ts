import { test } from "node:test";
import assert from "node:assert/strict";

const { bmHandler } = await import("../src/browser/bm-handler.ts");

/**
 * bmHandler wraps ALL the bm_* tools. Its key guarantee: if the handler throws, it does NOT
 * propagate the exception (it does not crash the MCP server) but instead returns { isError: true }
 * with the message. Here we test it without a browser.
 */

test("happy path: serializes the result to JSON without isError", async () => {
  const res = await bmHandler(async () => ({ a: 1, b: "x" }))();
  assert.equal(res.isError, undefined);
  assert.equal(res.content[0].type, "text");
  assert.deepEqual(JSON.parse(res.content[0].text), { a: 1, b: "x" });
});

test("error path: does NOT reject, returns isError with the message", async () => {
  let threw = false;
  let res;
  try {
    res = await bmHandler(async () => {
      throw new Error("boom");
    })();
  } catch {
    threw = true;
  }
  assert.equal(threw, false, "bmHandler must never propagate the exception");
  assert.equal(res!.isError, true);
  assert.match(res!.content[0].text, /browser error: boom/);
});

test("a synchronous error inside the thunk is also captured", async () => {
  const res = await bmHandler(() => {
    throw new Error("sync-fail");
  })();
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /sync-fail/);
});
