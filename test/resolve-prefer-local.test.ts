import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// prefer-local ON, registry pointing at a dead endpoint: if resolution correctly goes
// disk-first it returns instantly without any network attempt; the registry stays a
// fallback for names that are not on disk.
process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-resolve-"));
process.env.TOOL_MEMORY_PREFER_LOCAL = "1";
process.env.TOOL_MEMORY_REGISTRY_ENABLED = "1";
process.env.TOOL_MEMORY_REGISTRY_URL = "http://127.0.0.1:9";
process.env.TOOL_MEMORY_REGISTRY_TIMEOUT_MS = "300";

const { saveItem } = await import("../src/memory/store.ts");
const { resolveItem } = await import("../src/registry/resolve.ts");

const tool = {
  name: "prefer-local-demo",
  site: "demo.com",
  intent: "demo",
  keywords: ["demo"],
  type: "primitive",
  side_effect: "read",
  requires: { params: {}, env: {} },
  recipe: { kind: "playwright", steps: [{ action: "navigate", url: "https://demo.com" }] },
  success_assertion: { type: "dom", expr: "body" },
};

test("prefer-local resolves a local item without needing the registry", async () => {
  saveItem(tool);
  const r = await resolveItem("prefer-local-demo");
  assert.equal(r.source, "local");
  assert.equal(r.item.name, "prefer-local-demo");
});

test("prefer-local still falls back to the registry path for non-local names", async () => {
  // Not on disk and the registry is unreachable → the standard not-found error.
  await assert.rejects(
    () => resolveItem("only-remote-tool"),
    /Item not found in memory/,
  );
});
