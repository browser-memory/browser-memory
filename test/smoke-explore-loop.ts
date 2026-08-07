/**
 * E2E smoke of the FULL self-contained learning LOOP (without @playwright/mcp):
 *
 *   explore (bm_*) → resolve cssSelector → lint → save tool → REPLAY
 *   + verify that the network/console captured by the server make it into the trace.
 *
 *   npm run smoke:explore:loop
 *
 * This is the "real" test: it proves that the selector resolved by exploration is valid CSS
 * that the runner can replay, and that the learning material (network.json) is built from the
 * server's internal capture, without the agent passing anything external.
 */
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { launchSharedChrome, stopSharedChrome } from "../src/browser/chrome.js";
import { disconnectReplay } from "../src/browser/connect.js";
import { getNetLog, mergeNetwork, clearNetLog } from "../src/browser/netlog.js";
import { getConsoleLog } from "../src/browser/console-log.js";
import * as explore from "../src/browser/explore.js";
import { parseTool } from "../src/schema/tool.js";
import { lintTool } from "../src/memory/lint.js";
import { saveItem, removeItem } from "../src/memory/store.js";
import { run } from "../src/runner/execute.js";
import { learn } from "../src/learn/signal.js";

const TOOL_NAME = "wikipedia-home-has-search--smoketest";

function log(...a: unknown[]) {
  console.log(...a);
}

function findSearchRef(snapshot: string): string | undefined {
  for (const line of snapshot.split("\n")) {
    if (/(searchbox|textbox|combobox)/i.test(line)) {
      const m = /\[ref=(e\d+)\]/.exec(line);
      if (m) return m[1];
    }
  }
  return undefined;
}

function findRefByText(snapshot: string, text: string): string | undefined {
  for (const line of snapshot.split("\n")) {
    if (line.includes(text)) {
      const m = /\[ref=(e\d+)\]/.exec(line);
      if (m) return m[1];
    }
  }
  return undefined;
}

let tracePath: string | undefined;

async function main() {
  log("== E0: dedicated Chrome ==");
  await launchSharedChrome();
  clearNetLog();

  log("== explore: navigate + snapshot ==");
  const nav = await explore.navigate("https://es.wikipedia.org/");
  if (!/\[ref=e\d+\]/.test(nav.snapshot)) throw new Error("snapshot without refs");
  const ref = findSearchRef(nav.snapshot);
  if (!ref) throw new Error("could not find the search box in the snapshot");
  log(`   search box → ${ref}`);

  log("== resolve cssSelector from the ref ==");
  const css = await explore.resolveCssForRef(ref);
  log(`   cssSelector → ${css}`);
  if (!css) throw new Error("resolveCssForRef returned null");
  if (/aria-ref/.test(css)) throw new Error("cssSelector is an ephemeral ref");
  if (/^\s*[a-zA-Z][\w-]*\s+["']/.test(css)) throw new Error("cssSelector ended up in role+name notation");

  // Load-bearing: the resolved css must point to the SAME node as the ref, not another unique one.
  const pageA = await explore.getActivePage();
  const refHandle = await pageA.locator(`aria-ref=${ref}`).elementHandle();
  if (!refHandle) throw new Error("the ref no longer resolves");
  const sameNode = await pageA
    .locator(css)
    .first()
    .evaluate((el, target) => el === target, refHandle);
  if (!sameNode) throw new Error("cssSelector does NOT point to the same node as the ref");
  log("   ✓ cssSelector points to the SAME node as the ref (load-bearing)");

  log("== build a tool with THAT selector (lint must pass) ==");
  const tool = parseTool({
    name: TOOL_NAME,
    site: "es.wikipedia.org",
    intent: "open wikipedia and confirm the search box is there",
    type: "primitive",
    side_effect: "read",
    requires: { params: {}, env: {} },
    recipe: { kind: "playwright", steps: [{ action: "navigate", url: "https://es.wikipedia.org/" }] },
    result_extractor: { type: "dom", fn: "(document, params) => document.title" },
    success_assertion: { type: "dom", expr: css }, // ← the selector resolved by exploration
  });
  const problems = lintTool(tool);
  if (problems.length) throw new Error(`lint rejected the resolved selector: ${problems.join("; ")}`);
  log("   ✓ lint OK (the resolved selector is valid CSS)");

  log("== save + REPLAY (round-trip) ==");
  saveItem(tool);
  const res = await run(TOOL_NAME, {});
  log(`   run → ok=${res.ok} result=${JSON.stringify(res.result)?.slice(0, 80)}`);
  if (!res.ok) throw new Error(`run failed: ${JSON.stringify(res.error)}`);
  if (typeof res.result !== "string" || !/wikipedia/i.test(res.result)) {
    throw new Error(`unexpected result: ${JSON.stringify(res.result)}`);
  }
  log("   ✓ the tool learned by exploration replayed correctly");

  log("== learning: the network captured by the server makes it into the trace ==");
  const net = mergeNetwork(getNetLog(), undefined); // no external input: internal capture only
  if (net.length === 0) throw new Error("empty netlog: the internal capture did not work");
  const signal = learn({
    goal: "open wikipedia and confirm the search box",
    narration: {
      steps: [
        { intent: "open wikipedia", action: "navigate", url: "https://es.wikipedia.org/" },
        { intent: "search field", action: "type", selector: css, value: "gato" },
      ],
    },
    network: net,
    console: getConsoleLog(),
  });
  tracePath = signal.trace_path;
  // the trace is frozen locally and the report is built from it; the POST itself is not
  // exercised here (this smoke runs with the registry off).
  if (signal.payload.trace_id !== signal.trace_id) {
    throw new Error(`the report does not point at the trace: ${JSON.stringify(signal.payload)}`);
  }
  if (signal.payload.network.length === 0) {
    throw new Error("the report carries no xhr/fetch call");
  }
  const netFile = join(signal.trace_path, "network.json");
  if (!existsSync(netFile)) throw new Error("network.json was not written to the trace");
  const persisted = JSON.parse(readFileSync(netFile, "utf8"));
  if (!Array.isArray(persisted) || persisted.length === 0) throw new Error("empty network.json");
  log(`   ✓ trace ${signal.trace_id} with network.json (${persisted.length} requests)`);

  log("== structural fallback: element WITHOUT stable attributes ==");
  // DOM built deliberately without id/name/aria/testid/classes on the target → buildCandidates
  // produces no unique candidate and resolveCssForRef has to fall back to the nth-of-type path.
  const html =
    "<main id=app><div>x</div><div><button>Alpha</button><button>Beta</button></div></main>";
  const f = await explore.navigate("data:text/html," + encodeURIComponent(html));
  const bref = findRefByText(f.snapshot, "Beta");
  if (!bref) throw new Error("could not find the Beta button in the snapshot");
  const bcss = await explore.resolveCssForRef(bref);
  log(`   cssSelector (fallback) → ${bcss}`);
  if (!bcss) throw new Error("resolveCssForRef returned null in the fallback");
  if (!/nth-of-type|#app/.test(bcss)) throw new Error(`does not look like a structural path: ${bcss}`);
  const pageB = await explore.getActivePage();
  const count = await pageB.locator(bcss).count();
  if (count !== 1) throw new Error(`the structural path is not unique (count=${count})`);
  const fallbackTool = parseTool({
    name: TOOL_NAME + "-fallback",
    site: "data",
    intent: "structural path of a node without stable attributes",
    type: "primitive",
    side_effect: "read",
    requires: { params: {}, env: {} },
    recipe: { kind: "playwright", steps: [{ action: "navigate", url: "https://example.com/" }] },
    success_assertion: { type: "dom", expr: bcss },
  });
  if (lintTool(fallbackTool).length) {
    throw new Error(`lint rejected the structural path: ${lintTool(fallbackTool).join("; ")}`);
  }
  log("   ✓ structural path is unique and accepted by the lint");

  log("\n✅ SMOKE EXPLORE LOOP OK (learn → save → replay, without @playwright/mcp)");
}

main()
  .catch((e) => {
    console.error("\n❌ SMOKE EXPLORE LOOP FAILED:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // Cleanup: we don't leave junk in the user's memory.
    try {
      removeItem(TOOL_NAME);
    } catch {
      /* it was no longer there */
    }
    if (tracePath) rmSync(tracePath, { recursive: true, force: true });
    await disconnectReplay();
    stopSharedChrome();
  });
