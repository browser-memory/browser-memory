/**
 * End-to-end smoke test (E0-2). No MCP host: exercises the discover → run loop
 * directly over the server's functions, launching the shared Chrome.
 *
 *   npm run smoke
 *
 * To avoid touching your real memory, run with TOOL_MEMORY_HOME pointing at a temp dir.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { launchSharedChrome, stopSharedChrome } from "../src/browser/chrome.js";
import { disconnectReplay } from "../src/browser/connect.js";
import { saveTool } from "../src/memory/store.js";
import { discover } from "../src/memory/discover.js";
import { run } from "../src/runner/execute.js";

const here = dirname(fileURLToPath(import.meta.url));
const exampleJson = JSON.parse(
  readFileSync(join(here, "fixtures/wikipedia-search.json"), "utf8"),
);

function log(...a: unknown[]) {
  console.log(...a);
}

async function main() {
  log("== E0: launch the shared Chrome ==");
  const chrome = await launchSharedChrome();
  log(`   Chrome ${chrome.reused ? "reused" : "launched"} → ${chrome.cdpEndpoint}`);

  log("== E1: save an example tool + discovery ==");
  saveTool(exampleJson);
  const candidates = discover(["wikipedia"]);
  log("   discover →", JSON.stringify(candidates, null, 2));
  if (candidates[0]?.name !== "wikipedia-search") {
    throw new Error("discovery did not find wikipedia-search at the top");
  }

  log("== E2: run() returns data ==");
  const res = await run("wikipedia-search", { q: "cats" });
  log("   run →", JSON.stringify(res, null, 2).slice(0, 600));
  if (!res.ok || !Array.isArray(res.result) || res.result.length === 0) {
    throw new Error("run did not return results");
  }
  log(`   ✓ ${res.result.length} results`);

  log("== E2: tool-broken failure mode (broken selector on purpose) ==");
  const broken = {
    ...exampleJson,
    name: "wikipedia-search-broken",
    success_assertion: { type: "dom", expr: "#selector-that-never-exists" },
  };
  saveTool(broken);
  const failRes = await run("wikipedia-search-broken", { q: "cats" });
  log("   run(broken) →", JSON.stringify(failRes));
  if (failRes.ok || failRes.error?.mode !== "tool-broken") {
    throw new Error(`expected tool-broken, got ${JSON.stringify(failRes.error)}`);
  }
  log("   ✓ failure typed as tool-broken");

  log("\n✅ SMOKE OK");
}

main()
  .catch((e) => {
    console.error("\n❌ SMOKE FAILED:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectReplay();
    stopSharedChrome();
  });
