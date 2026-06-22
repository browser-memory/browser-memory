/**
 * E2E verification of the cross-client network recorder (not a unit test).
 *
 * Verifies that the recorder captures the network even when the tabs are driven by ANOTHER CDP
 * connection (historical case: an external client). Today that role is filled by the server's
 * own bm_* tools, but the guarantee still matters: it captures ALL requests, even across a
 * "redirect" that would reset an in-memory list.
 *
 *   npx tsx test/verify-netlog.ts
 */
import { chromium } from "playwright";
import { launchSharedChrome, stopSharedChrome } from "../src/browser/chrome.js";
import { startNetLog, getNetLog } from "../src/browser/netlog.js";
import { cdpEndpoint } from "../src/config.js";

async function main(): Promise<void> {
  const { reused } = await launchSharedChrome();
  // tool-memory starts its recorder (attaches to its own view of the shared context).
  await startNetLog();

  // Second independent CDP client = the role of playwright-mcp.
  const mcp = await chromium.connectOverCDP(cdpEndpoint);
  const ctx = mcp.contexts()[0] ?? (await mcp.newContext());
  const page = await ctx.newPage();

  // Navigation 1 → then navigation 2 (this WOULD RESET a browser_network_requests).
  await page.goto("https://example.com/", { waitUntil: "domcontentloaded" });
  await page.goto("https://www.iana.org/help/example-domains", {
    waitUntil: "domcontentloaded",
  });

  // Give it a moment for the network events to arrive over CDP.
  await page.waitForTimeout(800);

  const log = getNetLog();
  const urls = log.map((e) => e.url);
  const sawFirst = urls.some((u) => u.includes("example.com"));
  const sawSecond = urls.some((u) => u.includes("iana.org"));

  console.log(`Chrome reused: ${reused}`);
  console.log(`Captured entries: ${log.length}`);
  console.log(`  example.com (pre-redirect): ${sawFirst ? "OK" : "MISSING"}`);
  console.log(`  iana.org    (post-redirect): ${sawSecond ? "OK" : "MISSING"}`);
  console.log("Sample:");
  for (const e of log.slice(0, 8)) {
    console.log(`  ${e.n} ${e.method} ${e.status ?? "-"} ${e.type} ${e.url}`);
  }

  await page.close().catch(() => {});
  await mcp.close().catch(() => {});
  stopSharedChrome();

  if (!sawFirst || !sawSecond) {
    console.error(
      "\nFAILURE: the cross-client capture did not see everything. The pre-redirect was lost.",
    );
    process.exit(1);
  }
  console.log("\nOK: tool-memory captured another CDP client's network, across the redirect.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  stopSharedChrome();
  process.exit(1);
});
