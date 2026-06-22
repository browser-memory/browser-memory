import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-learn-"));

const { learn } = await import("../src/learn/signal.ts");

const narration = {
  goal: "search for cats on wikipedia",
  site: "es.wikipedia.org",
  outcome: "ok",
  success_signal: "results appear",
  steps: [
    { intent: "search", action: "navigate", url: "https://es.wikipedia.org?q=cats" },
  ],
  reader_fn: "() => []",
};

test("learn persists the trace and emits pending_distill", () => {
  const sig = learn({ goal: narration.goal, narration, network: [{ url: "x" }] });
  assert.equal(sig.status, "pending_distill");
  assert.match(sig.trace_id, /^trace-\d+$/);
  assert.ok(existsSync(join(sig.trace_path, "narration.json")));
  assert.ok(existsSync(join(sig.trace_path, "meta.json")));
  assert.ok(existsSync(join(sig.trace_path, "network.json")));
});

test("the suggested_prompt includes the contract and the trace_path", () => {
  const sig = learn({ goal: narration.goal, narration });
  assert.match(sig.suggested_prompt, /Distiller contract/);
  assert.ok(sig.suggested_prompt.includes(sig.trace_path));
});

test("meta.json reflects the outcome of the narration", () => {
  const sig = learn({ goal: narration.goal, narration });
  const meta = JSON.parse(readFileSync(join(sig.trace_path, "meta.json"), "utf8"));
  assert.equal(meta.outcome, "ok");
  assert.equal(meta.site, "es.wikipedia.org");
});

test("learn rejects a narration without steps", () => {
  assert.throws(() => learn({ goal: "x", narration: { ...narration, steps: [] } }));
});
