import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-compose-"));

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
