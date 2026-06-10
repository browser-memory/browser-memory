import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-store-"));

const { saveTool, loadTool, listIndex } = await import("../src/memory/store.ts");

const tool = {
  name: "demo-tool",
  site: "demo.com",
  intent: "demo",
  keywords: ["demo"],
  type: "primitive",
  side_effect: "read",
  requires: { params: {}, env: {} },
  recipe: { kind: "playwright", steps: [{ action: "navigate", url: "https://demo.com" }] },
  success_assertion: { type: "dom", expr: "body" },
};

test("saveTool → loadTool round-trip", () => {
  saveTool(tool);
  const loaded = loadTool("demo-tool");
  assert.equal(loaded.name, "demo-tool");
  assert.equal(loaded.version, 1); // default aplicado
  assert.equal(loaded.health.fail_count, 0);
});

test("index.json refleja el tool guardado", () => {
  const idx = listIndex();
  assert.ok(idx.some((e) => e.name === "demo-tool" && e.site === "demo.com"));
});

test("saveTool rechaza un tool sin success_assertion", () => {
  const bad = { ...tool, name: "bad" } as Record<string, unknown>;
  delete bad.success_assertion;
  assert.throws(() => saveTool(bad));
});
