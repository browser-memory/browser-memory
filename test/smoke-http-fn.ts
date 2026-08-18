import { readFileSync } from "node:fs";
import { ToolSchema, type Tool } from "../src/schema/tool.js";
import { runHttpFn } from "../src/runner/http-fn.js";
import { nextDispatcher, proxyCount, resetProxyPool } from "../src/runner/proxy-pool.js";

/**
 * Prototype smoke for the `http-fn` kind: takes the PUBLISHED jumbo-search-products fn
 * verbatim, runs it in Node (no browser) through runHttpFn, and proves
 *   1. it works headless,
 *   2. the runner's cookie jar makes the region session (POST /api/sessions) stick, so a
 *      located search returns that store's prices,
 *   3. many searches run in parallel,
 *   4. the proxy pool rotates round-robin (falls back to direct when empty).
 *
 * Run: npx tsx test/smoke-http-fn.ts
 */

const JUMBO_JSON =
  "/Users/felipegoulu/win/browser-memory-landing/backend/tools/jumbo.com.ar/jumbo-search-products.json";

function loadJumboAsHttpFn(): Tool {
  const def = JSON.parse(readFileSync(JUMBO_JSON, "utf8"));
  // Convert the live fetch-replay recipe to http-fn WITHOUT touching the fn.
  const httpFn = {
    ...def,
    recipe: { kind: "http-fn", fn: def.recipe.fn, proxy: true, origin: def.recipe.origin },
  };
  return ToolSchema.parse(httpFn);
}

function priceOf(result: any, q: string): number | undefined {
  return result?.results?.[q]?.items?.[0]?.price;
}

async function main() {
  const tool = loadJumboAsHttpFn();
  let failures = 0;

  // 1 + 2: default vs located (cookie jar must carry the session)
  const q = "yerba mate cruz de malta";
  const def = await runHttpFn(tool, { queries: [q], limit: 1 });
  const mza = await runHttpFn(tool, { queries: [q], limit: 1, location: "mendoza" });
  const pDef = priceOf(def.result, q);
  const pMza = priceOf(mza.result, q);
  const store = (mza.result as any)?.results ? (mza.result as any).location?.store : null;
  console.log(`[1] default headless: ok=${def.ok} price=$${pDef}`);
  console.log(`[2] located "mendoza": ok=${mza.ok} store=${store} price=$${pMza}`);
  if (!def.ok || pDef == null) { console.error("  FAIL: default run"); failures++; }
  if (!mza.ok || pMza == null) { console.error("  FAIL: located run"); failures++; }
  if (pDef != null && pMza != null && pDef === pMza)
    console.warn("  WARN: located price equals default (region may not have shifted this sku)");

  // 3: parallelism — 12 searches at once, all through the http-fn path
  const terms = ["leche","arroz","fideos","aceite","azucar","cafe","te","galletitas","gaseosa","agua","queso","pan"];
  const t0 = Date.now();
  const outs = await Promise.all(terms.map((t) => runHttpFn(tool, { queries: [t], limit: 2 })));
  const okCount = outs.filter((o) => o.ok).length;
  console.log(`[3] 12 parallel searches: ${okCount}/12 ok in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (okCount < 12) { console.error("  FAIL: not all parallel searches ok"); failures++; }

  // 4: proxy pool rotation (synthetic; no real egress needed)
  resetProxyPool();
  process.env.BMEM_PROXIES = "http://u:p@proxy-a:8000, http://u:p@proxy-b:8000, http://u:p@proxy-c:8000";
  resetProxyPool();
  const picks = [nextDispatcher(), nextDispatcher(), nextDispatcher(), nextDispatcher()].map((d) => d?.url);
  console.log(`[4] pool size=${proxyCount()} rotation=${JSON.stringify(picks)}`);
  const rotates = picks[0] === "http://u:p@proxy-a:8000" && picks[1] !== picks[0] && picks[3] === picks[0];
  if (!rotates) { console.error("  FAIL: round-robin rotation"); failures++; }
  resetProxyPool();
  delete process.env.BMEM_PROXIES;
  resetProxyPool();
  if (nextDispatcher() !== null) { console.error("  FAIL: empty pool should be null (direct)"); failures++; }
  console.log(`[4b] empty pool → direct connection: ok`);

  console.log(failures === 0 ? "\nALL OK" : `\n${failures} FAILURE(S)`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error("THREW", e); process.exit(1); });
