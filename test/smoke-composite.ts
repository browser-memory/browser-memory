/**
 * Smoke E4 (composites): encadena dos primitivas de Wikipedia con un handle (la URL
 * del primer resultado) y verifica el mapeo out → in punta a punta sobre el Chrome
 * compartido.
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
  console.log("== E0: Chrome compartido ==");
  const chrome = await launchSharedChrome();
  console.log(`   ${chrome.reused ? "reusado" : "lanzado"} → ${chrome.cdpEndpoint}`);

  console.log("== guardar 2 primitivas + composite ==");
  saveItem(load("wikipedia-first-result.json"));
  saveItem(load("wikipedia-read-summary.json"));
  saveItem(load("wikipedia-search-and-read.json"));

  console.log("== discovery prioriza el composite ==");
  const cands = discover(["wikipedia"]);
  console.log("   top →", cands[0]?.name, `(${cands[0]?.type})`);
  if (cands[0]?.type !== "composite") throw new Error("el composite no quedó primero");

  console.log("== run del composite (out → in con handle URL) ==");
  const res = await runComposite("wikipedia-search-and-read", { q: "gatos" });
  console.log(JSON.stringify(res, null, 2).slice(0, 900));
  if (!res.ok) throw new Error(`composite falló en paso ${JSON.stringify(res.aborted_at)}`);

  const handle = res.steps[0]?.out;
  if (!handle || !String(handle.value).startsWith("http")) {
    throw new Error("el handle articleUrl no se produjo");
  }
  console.log(`   ✓ handle ${handle.name} = ${handle.value}`);

  console.log("\n✅ SMOKE COMPOSITE OK");
}

main()
  .catch((e) => {
    console.error("\n❌ SMOKE COMPOSITE FALLÓ:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectReplay();
    stopSharedChrome();
  });
