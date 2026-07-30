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

test("a well-wired tool has no problems", () => {
  const tool = parseTool({
    ...base,
    recipe: { kind: "playwright", steps: [{ action: "navigate", url: "https://s.com/{{q|kebab}}" }] },
    result_extractor: { type: "dom", fn: "(root, params) => params.q" },
  });
  assert.deepEqual(lintTool(tool), []);
});

test("catches the single brace {q_kebab}", () => {
  const tool = parseTool({
    ...base,
    requires: { params: { q_kebab: "string" }, env: {} },
    recipe: { kind: "playwright", steps: [{ action: "navigate", url: "https://s.com/{q_kebab}_x" }] },
  });
  const problems = lintTool(tool);
  assert.ok(problems.some((p) => p.includes("single-brace")), problems.join("; "));
});

test("catches a declared but unused param", () => {
  const tool = parseTool({
    ...base,
    recipe: { kind: "playwright", steps: [{ action: "navigate", url: "https://s.com/fijo" }] },
  });
  const problems = lintTool(tool);
  assert.ok(problems.some((p) => p.includes("'q'") && p.includes("isn't used")), problems.join("; "));
});

test("catches the extractor that uses bare 'q' instead of params.q", () => {
  const tool = parseTool({
    ...base,
    recipe: { kind: "playwright", steps: [{ action: "navigate", url: "https://s.com/{{q|kebab}}" }] },
    result_extractor: { type: "dom", fn: "(root) => { const x = q.toLowerCase(); return x; }" },
  });
  const problems = lintTool(tool);
  assert.ok(problems.some((p) => p.includes("bare")), problems.join("; "));
});

test("catches an unknown filter", () => {
  const tool = parseTool({
    ...base,
    recipe: { kind: "playwright", steps: [{ action: "navigate", url: "https://s.com/{{q|wat}}" }] },
  });
  const problems = lintTool(tool);
  assert.ok(problems.some((p) => p.includes("unknown filter")), problems.join("; "));
});

// --- fetch-replay recipes --------------------------------------------------------

test("fetch-replay: a param used only inside the fn counts as used", () => {
  const tool = parseTool({
    ...base,
    recipe: {
      kind: "fetch-replay",
      origin: "https://s.com",
      fn: "async (params) => (await fetch(`/api?q=${encodeURIComponent(params.q)}`)).json()",
    },
  });
  assert.deepEqual(lintTool(tool), []);
});

test("fetch-replay: catches a bare param in the fn instead of params.q", () => {
  const tool = parseTool({
    ...base,
    recipe: {
      kind: "fetch-replay",
      origin: "https://s.com",
      fn: "async (params) => (await fetch(`/api?q=${q}`)).json()",
    },
  });
  const problems = lintTool(tool);
  assert.ok(
    problems.some((p) => p.includes("'q' bare")),
    problems.join("; "),
  );
});

test("fetch-replay: catches a declared param nobody uses", () => {
  const tool = parseTool({
    ...base,
    recipe: {
      kind: "fetch-replay",
      origin: "https://s.com",
      fn: "async () => (await fetch('/api')).json()",
    },
  });
  const problems = lintTool(tool);
  assert.ok(
    problems.some((p) => p.includes("'q'") && p.includes("isn't used")),
    problems.join("; "),
  );
});

test("fetch-replay: catches a single-brace placeholder in origin/url", () => {
  const tool = parseTool({
    ...base,
    recipe: {
      kind: "fetch-replay",
      origin: "https://s.com",
      url: "https://s.com/search?q={q}",
      fn: "async (params) => params.q",
    },
  });
  const problems = lintTool(tool);
  assert.ok(problems.some((p) => p.includes("single-brace")), problems.join("; "));
});
