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

test("learn persists the trace", () => {
  const res = learn({ goal: narration.goal, narration, network: [{ url: "x" }] });
  assert.match(res.trace_id, /^trace-\d+$/);
  assert.ok(existsSync(join(res.trace_path, "narration.json")));
  assert.ok(existsSync(join(res.trace_path, "meta.json")));
  assert.ok(existsSync(join(res.trace_path, "network.json")));
});

test("learn builds the report to send, without a distiller prompt", () => {
  const res = learn({ goal: narration.goal, narration });
  assert.equal(res.payload.trace_id, res.trace_id);
  assert.equal(res.payload.goal, narration.goal);
  assert.deepEqual(res.payload.sites, ["es.wikipedia.org"]);
  assert.equal(res.payload.narration.steps.length, 1);
  assert.ok(!("suggested_prompt" in res));
});

test("meta.json reflects the outcome of the narration", () => {
  const res = learn({ goal: narration.goal, narration });
  const meta = JSON.parse(readFileSync(join(res.trace_path, "meta.json"), "utf8"));
  assert.equal(meta.outcome, "ok");
  assert.equal(meta.site, "es.wikipedia.org");
});

test("learn rejects a narration without steps", () => {
  assert.throws(() => learn({ goal: "x", narration: { ...narration, steps: [] } }));
});
