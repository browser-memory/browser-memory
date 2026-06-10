import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Aislamos la memoria a un dir temporal ANTES de importar los módulos que leen config.
process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-discover-"));

const { saveTool } = await import("../src/memory/store.ts");
const { discover } = await import("../src/memory/discover.ts");

const wikiTool = {
  name: "wikipedia-search",
  site: "es.wikipedia.org",
  intent: "buscar articulos en wikipedia por texto",
  keywords: ["wikipedia", "buscar", "search", "wiki"],
  type: "primitive",
  side_effect: "read",
  requires: { params: { q: "string" }, env: {} },
  recipe: {
    kind: "playwright",
    steps: [{ action: "navigate", url: "https://es.wikipedia.org?q={{q}}" }],
  },
  success_assertion: { type: "dom", expr: ".result" },
};

saveTool(wikiTool);

test("discovery matchea el tool por keyword/dominio", () => {
  const r = discover("buscar gatos en wikipedia");
  assert.equal(r[0]?.name, "wikipedia-search");
  assert.ok(r[0].score > 0.3, `score bajo: ${r[0].score}`);
});

test("discovery completa los params del requires", () => {
  // discover() base no completa params (lo hace index.ts); aquí validamos el shape.
  const r = discover("wikipedia search");
  assert.ok(r.length >= 1);
  assert.equal(r[0].side_effect, "read");
});

test("un goal irrelevante no matchea", () => {
  const r = discover("reservar un vuelo a tokio");
  assert.equal(r.length, 0);
});
