import { test } from "node:test";
import assert from "node:assert/strict";

const { parseTool } = await import("../src/schema/tool.ts");

const valid = {
  name: "t",
  site: "x.com",
  intent: "do something",
  keywords: ["x"],
  type: "primitive",
  side_effect: "read",
  requires: { params: {}, env: {} },
  recipe: { kind: "playwright", steps: [{ action: "navigate", url: "https://x.com" }] },
  success_assertion: { type: "dom", expr: "body" },
};

test("a valid tool passes and applies defaults", () => {
  const t = parseTool(valid);
  assert.equal(t.version, 1);
  assert.equal(t.health.fail_count, 0);
});

test("missing success_assertion → invalid", () => {
  const bad = { ...valid } as Record<string, unknown>;
  delete bad.success_assertion;
  assert.throws(() => parseTool(bad));
});

test("recipe with an unknown kind → invalid", () => {
  const bad = { ...valid, recipe: { kind: "carrier-pigeon" } };
  assert.throws(() => parseTool(bad));
});

test("invalid side_effect → rejected", () => {
  const bad = { ...valid, side_effect: "explode" };
  assert.throws(() => parseTool(bad));
});

test("success_assertion text accepts a list of alternatives + within_ms", () => {
  const t = parseTool({
    ...valid,
    success_assertion: {
      type: "text",
      contains: ["Message sent", "The message was sent"],
      within_ms: 4000,
    },
  });
  assert.deepEqual(t.success_assertion, {
    type: "text",
    contains: ["Message sent", "The message was sent"],
    within_ms: 4000,
  });
});

test("success_assertion text with an empty list → invalid", () => {
  const bad = { ...valid, success_assertion: { type: "text", contains: [] } };
  assert.throws(() => parseTool(bad));
});
