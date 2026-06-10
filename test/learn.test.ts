import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-learn-"));

const { learn } = await import("../src/learn/signal.ts");

const narration = {
  goal: "buscar gatos en wikipedia",
  site: "es.wikipedia.org",
  outcome: "ok",
  success_signal: "aparecen resultados",
  steps: [
    { intent: "buscar", action: "navigate", url: "https://es.wikipedia.org?q=gatos" },
  ],
  reader_fn: "() => []",
};

test("learn persiste la trace y emite pending_distill", () => {
  const sig = learn({ goal: narration.goal, narration, network: [{ url: "x" }] });
  assert.equal(sig.status, "pending_distill");
  assert.match(sig.trace_id, /^trace-\d+$/);
  assert.ok(existsSync(join(sig.trace_path, "narration.json")));
  assert.ok(existsSync(join(sig.trace_path, "meta.json")));
  assert.ok(existsSync(join(sig.trace_path, "network.json")));
});

test("el suggested_prompt incluye el contrato y el trace_path", () => {
  const sig = learn({ goal: narration.goal, narration });
  assert.match(sig.suggested_prompt, /Contrato del distiller/);
  assert.ok(sig.suggested_prompt.includes(sig.trace_path));
});

test("meta.json refleja el outcome de la narración", () => {
  const sig = learn({ goal: narration.goal, narration });
  const meta = JSON.parse(readFileSync(join(sig.trace_path, "meta.json"), "utf8"));
  assert.equal(meta.outcome, "ok");
  assert.equal(meta.site, "es.wikipedia.org");
});

test("learn rechaza una narración sin pasos", () => {
  assert.throws(() => learn({ goal: "x", narration: { ...narration, steps: [] } }));
});
