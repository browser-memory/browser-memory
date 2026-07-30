/**
 * End-to-end smoke for the worker-tab lifecycle. No MCP host: it drives `run` directly
 * against the shared Chrome and checks what the unit tests cannot — that the tabs
 * really behave in a live browser.
 *
 *   npm run smoke:tabs
 *
 * What it pins down:
 *   1. a run LEAVES ITS TAB OPEN, on the page the tool ended on (that is the point:
 *      the user keeps working on it);
 *   2. a run against another origin gets its OWN tab and does not clobber the first;
 *   3. running the same tool again REUSES its tab instead of piling up new ones;
 *   4. a `fetch-replay` recipe replays with NO navigation when the tab is already on
 *      the site, and still returns data;
 *   5. exploration never adopts a worker tab as its active page.
 *
 * Run it with TOOL_MEMORY_HOME pointing at a temp dir so it doesn't touch your memory.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

import { launchSharedChrome, stopSharedChrome } from "../src/browser/chrome.js";
import { disconnectReplay, getSharedContext } from "../src/browser/connect.js";
import { isWorkerPage, workerTabs } from "../src/browser/worker-tabs.js";
import { getActivePage } from "../src/browser/explore.js";
import { saveTool } from "../src/memory/store.js";
import { run } from "../src/runner/execute.js";

const here = dirname(fileURLToPath(import.meta.url));
const esSearch = JSON.parse(
  readFileSync(join(here, "fixtures/wikipedia-search.json"), "utf8"),
);

/** Same recipe on a DIFFERENT origin — that's the whole point of the fixture. */
const enSearch = {
  ...esSearch,
  name: "wikipedia-search-en",
  site: "en.wikipedia.org",
  keywords: ["wikipedia", "english"],
  recipe: {
    kind: "playwright",
    steps: [
      {
        action: "navigate",
        url: "https://en.wikipedia.org/w/index.php?search={{q}}&fulltext=1&ns0=1",
      },
      { action: "assert_precondition", expr: ".mw-search-results, .searchresults" },
    ],
  },
};

/** Same site as `esSearch`, but replayed as an in-page fetch (no UI, no navigation). */
const esApi = {
  name: "wikipedia-opensearch",
  version: 1,
  site: "es.wikipedia.org",
  intent: "buscar titulos en wikipedia por la api, sin abrir la ui",
  keywords: ["wikipedia", "api", "opensearch"],
  type: "primitive",
  side_effect: "read",
  requires: { params: { q: "string" }, env: {} },
  recipe: {
    kind: "fetch-replay",
    origin: "https://es.wikipedia.org",
    fn: "async (params) => { const r = await fetch(`/w/api.php?action=opensearch&search=${encodeURIComponent(params.q)}&limit=5&format=json`, { headers: { accept: 'application/json' } }); if (!r.ok) return null; const j = await r.json(); return { query: j[0], titles: j[1] }; }",
  },
  success_assertion: { type: "json", jsonPath: "titles" },
  health: { last_ok: null, fail_count: 0 },
};

function log(...a: unknown[]) {
  console.log(...a);
}

function check(cond: unknown, msg: string): void {
  if (!cond) throw new Error(msg);
  log(`   ✓ ${msg}`);
}

async function main() {
  log("== launch the shared Chrome ==");
  const chrome = await launchSharedChrome();
  log(`   Chrome ${chrome.reused ? "reused" : "launched"} → ${chrome.cdpEndpoint}`);

  saveTool(esSearch);
  saveTool(enSearch);
  saveTool(esApi);

  log("== 1. a run leaves its tab open, where the tool ended ==");
  const a1 = await run("wikipedia-search", { q: "gatos" });
  check(a1.ok, "run(es) returned data");
  const afterA = workerTabs();
  check(afterA.length === 1, `exactly 1 worker tab open (got ${afterA.length})`);
  const esTab = afterA[0];
  check(!esTab.isClosed(), "the tab was NOT closed after the run");
  check(
    esTab.url().includes("es.wikipedia.org"),
    `the tab is left on the result page (${esTab.url()})`,
  );

  log("== 2. another origin gets its own tab and does not clobber the first ==");
  const b1 = await run("wikipedia-search-en", { q: "cats" });
  check(b1.ok, "run(en) returned data");
  const afterB = workerTabs();
  check(afterB.length === 2, `2 worker tabs open, one per origin (got ${afterB.length})`);
  check(!esTab.isClosed(), "the es tab is still alive");
  check(
    esTab.url().includes("es.wikipedia.org"),
    `the es tab still shows its own page (${esTab.url()})`,
  );

  log("== 3. re-running a tool reuses its tab instead of piling up ==");
  const a2 = await run("wikipedia-search", { q: "perros" });
  check(a2.ok, "the second run(es) returned data");
  check(workerTabs().length === 2, "still 2 tabs: it reused, it did not create");
  check(workerTabs().includes(esTab), "it is the SAME tab object as the first run");
  check(esTab.url().includes("perros"), `the reused tab navigated (${esTab.url()})`);

  log("== 4. fetch-replay: no navigation when the tab is already on the site ==");
  const urlBefore = esTab.url();
  const c1 = await run("wikipedia-opensearch", { q: "buenos aires" });
  check(c1.ok, `fetch-replay returned data (${JSON.stringify(c1.result).slice(0, 120)})`);
  const titles = (c1.result as { titles?: unknown[] })?.titles;
  check(Array.isArray(titles) && titles.length > 0, "the in-page fetch brought titles");
  check(workerTabs().length === 2, "it reused the es tab, no new one");
  check(
    esTab.url() === urlBefore,
    `it did NOT navigate: ${urlBefore} === ${esTab.url()}`,
  );

  log("== 5. exploration never adopts a worker tab ==");
  const active = await getActivePage();
  check(!isWorkerPage(active), "the active exploration page is not a worker tab");
  check(
    !workerTabs().includes(active),
    "the active exploration page is none of the run tabs",
  );

  const ctx = await getSharedContext();
  log(`   (context has ${ctx.pages().filter((p) => !p.isClosed()).length} live tabs)`);

  log("\n✅ SMOKE TABS OK");
}

main()
  .catch((e) => {
    console.error("\n❌ SMOKE TABS FAILED:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectReplay();
    await stopSharedChrome();
  });
