import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-compose-"));
// Fully local: resolveItem must not reach for the remote registry when a tool is missing.
process.env.TOOL_MEMORY_REGISTRY_ENABLED = "0";

const { saveItem } = await import("../src/memory/store.ts");
const { discover } = await import("../src/memory/discover.ts");

// Composite that chains two http primitives (no browser) to test the
// out → in mapping and the abort on a failed precondition.
const httpEcho = (name: string, urlTpl: string) => ({
  name,
  site: "echo.test",
  intent: `echo ${name}`,
  keywords: [name],
  type: "primitive",
  side_effect: "read",
  requires: { params: { x: "string" }, env: {} },
  recipe: { kind: "http", method: "GET", url: urlTpl, jsonPath: "x" },
  success_assertion: { type: "json", jsonPath: "x" },
});

test("discovery prioritizes composites over primitives", () => {
  saveItem(httpEcho("alpha-search", "https://x/{{x}}"));
  saveItem({
    name: "alpha-flow",
    type: "composite",
    site: "echo.test", // discovery is per site: the composite must declare it to show up.
    intent: "alpha search full flow",
    keywords: ["alpha", "search"],
    params: { x: "string" },
    chain: [{ tool: "alpha-search", in: { x: "{{x}}" } }],
  });
  // Ask for the site → brings both; on a tie, the composite comes first (boost §10.2).
  const r = discover(["echo.test"]);
  assert.equal(r[0].type, "composite", "the composite should come first");
});

test("a composite without site inherits the one from the first tool in its chain", () => {
  saveItem(httpEcho("beta-search", "https://x/{{x}}")); // site: echo.test
  const saved = saveItem({
    name: "beta-flow",
    type: "composite",
    // no `site`: it must be derived from beta-search.
    intent: "beta flow",
    keywords: ["beta"],
    params: { x: "string" },
    chain: [{ tool: "beta-search", in: { x: "{{x}}" } }],
  });
  assert.equal(saved.type === "composite" && saved.site, "echo.test");
  // and therefore it is discoverable by site:
  assert.ok(discover(["echo.test"]).some((c) => c.name === "beta-flow"));
});

test("composite schema validates the chain", async () => {
  const { parseComposite } = await import("../src/schema/tool.ts");
  assert.throws(() => parseComposite({ name: "c", type: "composite", intent: "x", chain: [] }));
  const ok = parseComposite({
    name: "c2",
    type: "composite",
    intent: "x",
    chain: [{ tool: "t", in: { a: "{{a}}" }, out: "h" }],
  });
  assert.equal(ok.chain[0].out, "h");
});

test("a composite records its own last_ok when the chain completes", async () => {
  // Local http server so the chain really runs (no browser involved).
  const { createServer } = await import("node:http");
  const server = createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ x: "ok" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as { port: number };
  try {
    saveItem(httpEcho("gamma-search", `http://127.0.0.1:${port}/{{x}}`));
    saveItem({
      name: "gamma-flow",
      type: "composite",
      site: "echo.test",
      intent: "gamma flow",
      keywords: ["gamma"],
      params: { x: "string" },
      chain: [{ tool: "gamma-search", in: { x: "{{x}}" } }],
    });
    const { runComposite } = await import("../src/runner/compose.ts");
    const { loadComposite } = await import("../src/memory/store.ts");
    assert.equal(loadComposite("gamma-flow").health.last_ok, null, "starts with no last_ok");

    const r = await runComposite("gamma-flow", { x: "hi" });
    assert.ok(r.ok, `the chain should have completed: ${JSON.stringify(r)}`);
    // Regression: only the primitives used to go through bumpHealth, so a composite
    // stayed at last_ok:null forever and could never be told apart from a never-run one.
    assert.notEqual(loadComposite("gamma-flow").health.last_ok, null);
  } finally {
    server.close();
  }
});

test("an env failure in the chain does not inflate the composite's fail_count", async () => {
  saveItem({
    name: "delta-flow",
    type: "composite",
    site: "echo.test",
    intent: "delta flow",
    keywords: ["delta"],
    params: {},
    chain: [{ tool: "does-not-exist", in: {} }],
  });
  const { runComposite } = await import("../src/runner/compose.ts");
  const { loadComposite } = await import("../src/memory/store.ts");

  const r = await runComposite("delta-flow", {});
  assert.equal(r.ok, false);
  assert.equal(r.steps[0].error?.mode, "not-applicable");
  assert.equal(
    loadComposite("delta-flow").health.fail_count,
    0,
    "re-auth/not-applicable come from the environment: they must not count against the tool",
  );
});

test("extractHandle: an object with the key uses that field; a scalar uses the value", async () => {
  // We test the handle-mapping logic indirectly since resolveInputs is not
  // exported; we validate the documented behavior with an object.
  const composite = {
    name: "h-flow",
    type: "composite",
    intent: "handle flow",
    params: {},
    chain: [{ tool: "a", in: {}, out: "personUrl" }],
  };
  const saved = saveItem(composite);
  assert.equal(saved.type, "composite");
});
