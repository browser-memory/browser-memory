/**
 * Smoke test end-to-end (E0-2). Sin MCP host: ejercita el loop discover → run
 * directo sobre las funciones del server, lanzando el Chrome compartido.
 *
 *   npm run smoke
 *
 * Para no tocar tu memoria real, corre con TOOL_MEMORY_HOME a un dir temporal.
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
  log("== E0: lanzar Chrome compartido ==");
  const chrome = await launchSharedChrome();
  log(`   Chrome ${chrome.reused ? "reusado" : "lanzado"} → ${chrome.cdpEndpoint}`);

  log("== E1: guardar tool de ejemplo + discovery ==");
  saveTool(exampleJson);
  const candidates = discover("buscar gatos en wikipedia");
  log("   discover →", JSON.stringify(candidates, null, 2));
  if (candidates[0]?.name !== "wikipedia-search") {
    throw new Error("discovery no encontró wikipedia-search en el top");
  }

  log("== E2: run() devuelve datos ==");
  const res = await run("wikipedia-search", { q: "gatos" });
  log("   run →", JSON.stringify(res, null, 2).slice(0, 600));
  if (!res.ok || !Array.isArray(res.result) || res.result.length === 0) {
    throw new Error("run no devolvió resultados");
  }
  log(`   ✓ ${res.result.length} resultados`);

  log("== E2: modo de falla tool-roto (selector roto a propósito) ==");
  const broken = {
    ...exampleJson,
    name: "wikipedia-search-broken",
    success_assertion: { type: "dom", expr: "#selector-que-no-existe-jamas" },
  };
  saveTool(broken);
  const failRes = await run("wikipedia-search-broken", { q: "gatos" });
  log("   run(broken) →", JSON.stringify(failRes));
  if (failRes.ok || failRes.error?.mode !== "tool-roto") {
    throw new Error(`esperaba tool-roto, obtuve ${JSON.stringify(failRes.error)}`);
  }
  log("   ✓ falla tipada como tool-roto");

  log("\n✅ SMOKE OK");
}

main()
  .catch((e) => {
    console.error("\n❌ SMOKE FALLÓ:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectReplay();
    stopSharedChrome();
  });
