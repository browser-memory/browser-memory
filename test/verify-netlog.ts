/**
 * Verificación e2e del grabador de red cross-client (no es un unit test).
 *
 * Simula la realidad: tool-memory escucha la red por SU conexión CDP, mientras OTRO
 * cliente CDP (como playwright-mcp) maneja las pestañas y navega/redirige. Probamos que
 * tool-memory captura igual TODOS los requests, incluso a través de un "redirect".
 *
 *   npx tsx test/verify-netlog.ts
 */
import { chromium } from "playwright";
import { launchSharedChrome, stopSharedChrome } from "../src/browser/chrome.js";
import { startNetLog, getNetLog } from "../src/browser/netlog.js";
import { cdpEndpoint } from "../src/config.js";

async function main(): Promise<void> {
  const { reused } = await launchSharedChrome();
  // tool-memory arranca su grabador (atacha a su propia vista del contexto compartido).
  await startNetLog();

  // Segundo cliente CDP independiente = el rol de playwright-mcp.
  const mcp = await chromium.connectOverCDP(cdpEndpoint);
  const ctx = mcp.contexts()[0] ?? (await mcp.newContext());
  const page = await ctx.newPage();

  // Navegación 1 → luego navegación 2 (esto RESETEARÍA un browser_network_requests).
  await page.goto("https://example.com/", { waitUntil: "domcontentloaded" });
  await page.goto("https://www.iana.org/help/example-domains", {
    waitUntil: "domcontentloaded",
  });

  // Damos un respiro para que los eventos de red lleguen por CDP.
  await page.waitForTimeout(800);

  const log = getNetLog();
  const urls = log.map((e) => e.url);
  const sawFirst = urls.some((u) => u.includes("example.com"));
  const sawSecond = urls.some((u) => u.includes("iana.org"));

  console.log(`Chrome reused: ${reused}`);
  console.log(`Entradas capturadas: ${log.length}`);
  console.log(`  example.com (pre-redirect): ${sawFirst ? "OK" : "FALTA"}`);
  console.log(`  iana.org    (post-redirect): ${sawSecond ? "OK" : "FALTA"}`);
  console.log("Muestra:");
  for (const e of log.slice(0, 8)) {
    console.log(`  ${e.n} ${e.method} ${e.status ?? "-"} ${e.type} ${e.url}`);
  }

  await page.close().catch(() => {});
  await mcp.close().catch(() => {});
  stopSharedChrome();

  if (!sawFirst || !sawSecond) {
    console.error(
      "\nFALLO: la captura cross-client no vio todo. El pre-redirect se perdió.",
    );
    process.exit(1);
  }
  console.log("\nOK: tool-memory capturó la red de otro cliente CDP, a través del redirect.");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  stopSharedChrome();
  process.exit(1);
});
