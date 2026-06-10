import { test } from "node:test";
import assert from "node:assert/strict";

const { parseTool } = await import("../src/schema/tool.ts");

const valid = {
  name: "t",
  site: "x.com",
  intent: "hacer algo",
  keywords: ["x"],
  type: "primitive",
  side_effect: "read",
  requires: { params: {}, env: {} },
  recipe: { kind: "playwright", steps: [{ action: "navigate", url: "https://x.com" }] },
  success_assertion: { type: "dom", expr: "body" },
};

test("un tool válido pasa y aplica defaults", () => {
  const t = parseTool(valid);
  assert.equal(t.version, 1);
  assert.equal(t.health.fail_count, 0);
});

test("falta success_assertion → inválido", () => {
  const bad = { ...valid } as Record<string, unknown>;
  delete bad.success_assertion;
  assert.throws(() => parseTool(bad));
});

test("recipe con kind desconocido → inválido", () => {
  const bad = { ...valid, recipe: { kind: "carrier-pigeon" } };
  assert.throws(() => parseTool(bad));
});

test("side_effect inválido → rechazado", () => {
  const bad = { ...valid, side_effect: "explode" };
  assert.throws(() => parseTool(bad));
});
