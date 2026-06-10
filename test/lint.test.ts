import { test } from "node:test";
import assert from "node:assert/strict";

const { lintTool } = await import("../src/memory/lint.ts");
const { parseTool } = await import("../src/schema/tool.ts");

const base = {
  name: "t",
  site: "s.com",
  intent: "x",
  type: "primitive",
  side_effect: "read",
  requires: { params: { q: "string" }, env: {} },
  success_assertion: { type: "dom", expr: ".result" },
};

test("tool bien cableado no tiene problemas", () => {
  const tool = parseTool({
    ...base,
    recipe: { kind: "playwright", steps: [{ action: "navigate", url: "https://s.com/{{q|kebab}}" }] },
    result_extractor: { type: "dom", fn: "(root, params) => params.q" },
  });
  assert.deepEqual(lintTool(tool), []);
});

test("caza la llave simple {q_kebab}", () => {
  const tool = parseTool({
    ...base,
    requires: { params: { q_kebab: "string" }, env: {} },
    recipe: { kind: "playwright", steps: [{ action: "navigate", url: "https://s.com/{q_kebab}_x" }] },
  });
  const problems = lintTool(tool);
  assert.ok(problems.some((p) => p.includes("una sola llave")), problems.join("; "));
});

test("caza un param declarado pero no usado", () => {
  const tool = parseTool({
    ...base,
    recipe: { kind: "playwright", steps: [{ action: "navigate", url: "https://s.com/fijo" }] },
  });
  const problems = lintTool(tool);
  assert.ok(problems.some((p) => p.includes("'q'") && p.includes("no se usa")), problems.join("; "));
});

test("caza el extractor que usa 'q' suelto en vez de params.q", () => {
  const tool = parseTool({
    ...base,
    recipe: { kind: "playwright", steps: [{ action: "navigate", url: "https://s.com/{{q|kebab}}" }] },
    result_extractor: { type: "dom", fn: "(root) => { const x = q.toLowerCase(); return x; }" },
  });
  const problems = lintTool(tool);
  assert.ok(problems.some((p) => p.includes("suelto")), problems.join("; "));
});

test("caza un filtro desconocido", () => {
  const tool = parseTool({
    ...base,
    recipe: { kind: "playwright", steps: [{ action: "navigate", url: "https://s.com/{{q|wat}}" }] },
  });
  const problems = lintTool(tool);
  assert.ok(problems.some((p) => p.includes("filtro desconocido")), problems.join("; "));
});
