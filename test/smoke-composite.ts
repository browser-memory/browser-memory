/**
 * Smoke E4 (composites): chains two Wikipedia primitives with a handle (the URL
 * of the first result) and verifies the out → in mapping end to end over the shared
 * Chrome.
 *
 *   npm run smoke:composite
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { launchSharedChrome, stopSharedChrome } from "../src/browser/chrome.js";
import { disconnectReplay } from "../src/browser/connect.js";
import { saveItem } from "../src/memory/store.js";
import { discover } from "../src/memory/discover.js";
import { runComposite } from "../src/runner/compose.js";

const here = dirname(fileURLToPath(import.meta.url));
const load = (f: string) =>
  JSON.parse(readFileSync(join(here, "fixtures", f), "utf8"));

async function main() {
  console.log("== E0: shared Chrome ==");
  const chrome = await launchSharedChrome();
  console.log(`   ${chrome.reused ? "reused" : "launched"} → ${chrome.cdpEndpoint}`);

  console.log("== save 2 primitives + composite ==");
  saveItem(load("wikipedia-first-result.json"));
  saveItem(load("wikipedia-read-summary.json"));
  saveItem(load("wikipedia-search-and-read.json"));

  console.log("== discovery prioritizes the composite ==");
  const cands = discover(["wikipedia"]);
  console.log("   top →", cands[0]?.name, `(${cands[0]?.type})`);
  if (cands[0]?.type !== "composite") throw new Error("the composite did not come first");

  console.log("== run the composite (out → in with URL handle) ==");
  const res = await runComposite("wikipedia-search-and-read", { q: "cats" });
  console.log(JSON.stringify(res, null, 2).slice(0, 900));
  if (!res.ok) throw new Error(`composite failed at step ${JSON.stringify(res.aborted_at)}`);

  const handle = res.steps[0]?.out;
  if (!handle || !String(handle.value).startsWith("http")) {
    throw new Error("the articleUrl handle was not produced");
  }
  console.log(`   ✓ handle ${handle.name} = ${handle.value}`);

  console.log("\n✅ SMOKE COMPOSITE OK");
}

main()
  .catch((e) => {
    console.error("\n❌ SMOKE COMPOSITE FAILED:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectReplay();
    stopSharedChrome();
  });
