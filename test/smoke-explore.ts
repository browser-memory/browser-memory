/**
 * End-to-end smoke test of the self-contained EXPLORATION (without @playwright/mcp).
 * Exercises the bm_* tools directly over the dedicated Chrome:
 *   navigate → snapshot (refs) → type+submit (resolves cssSelector) → snapshot → network.
 *
 *   npm run smoke:explore
 *
 * Verifies what matters about the dependency cut:
 *  - the snapshot brings [ref=eN] refs
 *  - typing by ref resolves a real CSS cssSelector (not a ref, not role+name)
 *  - the network was captured by this server (netlog), with no external tool
 */
import { launchSharedChrome, stopSharedChrome } from "../src/browser/chrome.js";
import { disconnectReplay } from "../src/browser/connect.js";
import { getNetLog, clearNetLog } from "../src/browser/netlog.js";
import * as explore from "../src/browser/explore.js";

function log(...a: unknown[]) {
  console.log(...a);
}

/** Pulls the first ref from a snapshot line that looks like a text/search field. */
function findSearchRef(snapshot: string): string | undefined {
  for (const line of snapshot.split("\n")) {
    if (/(searchbox|textbox|combobox)/i.test(line)) {
      const m = /\[ref=(e\d+)\]/.exec(line);
      if (m) return m[1];
    }
  }
  return undefined;
}

async function main() {
  log("== E0: launch the dedicated Chrome ==");
  const chrome = await launchSharedChrome();
  log(`   Chrome ${chrome.reused ? "reused" : "launched"} → ${chrome.cdpEndpoint}`);
  clearNetLog();

  log("== bm_navigate + bm_snapshot ==");
  const nav = await explore.navigate("https://es.wikipedia.org/");
  if (!/\[ref=e\d+\]/.test(nav.snapshot)) {
    throw new Error("the snapshot does not bring [ref=eN] refs");
  }
  log(`   ✓ snapshot with refs (${nav.snapshot.length} chars), title="${nav.title}"`);

  const ref = findSearchRef(nav.snapshot);
  if (!ref) throw new Error("could not find a search field in the snapshot");
  log(`   search field → ${ref}`);

  log("== bm_type (with submit) ==");
  const typed = await explore.typeRef(ref, "Gato", true);
  log(`   resolved cssSelector → ${typed.cssSelector}`);
  if (!typed.cssSelector) throw new Error("type did not resolve a cssSelector");
  if (/aria-ref/.test(typed.cssSelector)) throw new Error("cssSelector is an ephemeral ref");
  if (/^\s*[a-zA-Z][\w-]*\s+["']/.test(typed.cssSelector)) {
    throw new Error("cssSelector ended up in role+name notation (breaks the lint)");
  }
  log(`   ✓ cssSelector is real CSS`);

  log("== state after submit ==");
  const after = await explore.snapshot();
  log(`   url → ${after.url}`);
  // Hard assert: the submit MUST have navigated (the url changed from the home).
  if (after.url === nav.url) throw new Error("the submit did not navigate: the url did not change");
  if (!/gato|search|index|wiki/i.test(after.url)) {
    throw new Error(`unexpected post-submit url: ${after.url}`);
  }
  log(`   ✓ the submit navigated`);

  log("== bm_network: network captured by the server ==");
  const net = getNetLog();
  log(`   ${net.length} requests captured`);
  if (net.length === 0) throw new Error("netlog captured nothing (did the recorder not start?)");
  const apis = net.filter((e) => e.type === "xhr" || e.type === "fetch");
  log(`   of which ${apis.length} xhr/fetch`);

  log("\n✅ SMOKE EXPLORE OK (without @playwright/mcp)");
}

main()
  .catch((e) => {
    console.error("\n❌ SMOKE EXPLORE FAILED:", e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await disconnectReplay();
    stopSharedChrome();
  });
