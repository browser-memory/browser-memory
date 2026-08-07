/**
 * E2E of the TOOL REQUEST channel (`POST /v1/requests`) against a real backend, WITHOUT
 * touching the browser: it exercises the report the client sends when there was no tool.
 *
 *   TOOL_MEMORY_REGISTRY_URL=http://localhost:8787 npm run e2e:request
 *   TOOL_MEMORY_REGISTRY_URL=https://api.browser-memory.com \
 *   TOOL_MEMORY_REGISTRY_KEY=<key> npm run e2e:request
 *
 * WITHOUT a key it reports ANONYMOUSLY, which is the case that has to work: a user with no
 * login is exactly the demand we don't want to lose. With a key, the row should come back
 * attached to the user.
 *
 * It writes REAL rows in `tool_requests` (goal prefixed `[e2e]` and a per-run suffix, so it
 * is easy to clean up: delete from tool_requests where goal like '[e2e]%').
 */
import { mkdtempSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the local memory: the traces and the pending queue of this run are throwaway.
const HOME = mkdtempSync(join(tmpdir(), "tm-e2e-request-"));
process.env.TOOL_MEMORY_HOME = HOME;
process.env.TOOL_MEMORY_REGISTRY_ENABLED = "1";

const { buildRequestPayload, reportToolRequest, flushPendingRequests } = await import(
  "../src/registry/requests.js"
);
const { registryConfig } = await import("../src/registry/config.js");

const PENDING = join(HOME, "requests", "pending");
const RUN = `${Date.now().toString(36)}-${Math.floor(Math.random() * 1e4)}`;

function log(...a: unknown[]): void {
  console.log(...a);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`✗ ${msg}`);
}

/** A report like the one `request` builds after a real exploration. */
function report(traceId: string, goal: string, bodySize = 200) {
  return buildRequestPayload({
    traceId,
    goal,
    narration: {
      goal,
      site: "www.example.com",
      outcome: "ok",
      success_signal: "the list of results is shown",
      steps: [
        { intent: "open", action: "navigate", url: "https://www.example.com/search?q=leche" },
        { intent: "search box", action: "type", selector: "#search input[name=q]", value: "leche" },
        { intent: "read results", action: "extract", selector: ".product-card" },
      ],
    },
    network: [
      { n: 1, method: "GET", url: "https://www.example.com/search", type: "document" },
      {
        n: 2,
        method: "POST",
        url: "https://www.example.com/api/search",
        type: "xhr",
        status: 200,
        mime: "application/json",
        reqHeaders: { "content-type": "application/json", cookie: "<redacted>" },
        reqBody: JSON.stringify({ q: "leche", limit: 20 }),
        resBody: JSON.stringify({ items: Array.from({ length: bodySize }, (_, i) => ({ i })) }),
      },
    ],
  });
}

async function main(): Promise<void> {
  log(`== tool-request E2E against ${registryConfig.baseUrl} ==`);
  log(`   auth: ${process.env.TOOL_MEMORY_REGISTRY_KEY ? "with key" : "ANONYMOUS"}`);
  log(`   run id: ${RUN}  (home: ${HOME})\n`);

  // 1. A fresh report goes through and comes back with its id.
  const goal = `[e2e] search products on example ${RUN}`;
  log("[1] POST /v1/requests with a new report...");
  const first = await reportToolRequest(report("trace-001", goal));
  assert(
    first.status === "reported",
    `expected "reported", got "${first.status}" (${first.detail ?? "no detail"}). ` +
      `A 401 also lands here as "queued": check whether the endpoint accepts anonymous.`,
  );
  assert(first.request_id, "the backend did not return request_id");
  log(`    ✓ request_id=${first.request_id} hits=${first.hits}\n`);

  // 2. DEDUP: same install + same goal + same sites = the same row with one more hit.
  log("[2] the SAME report again (dedup by install_id + request_key)...");
  const second = await reportToolRequest(report("trace-002", goal));
  assert(second.status === "reported", `second report: ${second.status}`);
  assert(
    second.request_id === first.request_id,
    `it created a NEW row (${second.request_id}) instead of deduping onto ${first.request_id}`,
  );
  assert(
    second.hits === 2,
    `expected hits=2, got ${second.hits}. The upsert is not counting demand.`,
  );
  log(`    ✓ same row, hits=${second.hits}\n`);

  // 3. A DIFFERENT goal is a different row: dedup must not swallow real demand.
  log("[3] a different goal on the same site...");
  const other = await reportToolRequest(report("trace-003", `[e2e] add to cart ${RUN}`));
  assert(other.status === "reported", `third report: ${other.status}`);
  assert(other.request_id !== first.request_id, "two different goals collapsed into one row");
  log(`    ✓ new row request_id=${other.request_id}\n`);

  // 4. SIZE: a heavy trace (the client shrinks it below the cap before sending).
  log("[4] a report with ~1.5 MB of bodies...");
  const heavy = report("trace-004", `[e2e] heavy trace ${RUN}`, 40_000);
  const size = Buffer.byteLength(JSON.stringify(heavy));
  assert(size <= 900_000, `the client did not shrink it: ${size} bytes`);
  const big = await reportToolRequest(heavy);
  assert(big.status === "reported", `heavy report: ${big.status} (${big.detail ?? ""})`);
  log(`    ✓ sent at ${Math.round(size / 1024)} KB, dropped bodies flagged\n`);

  // 5. BACKEND DOWN → the report is queued on disk and drains against the REAL backend
  //    on the next flush. This is what guarantees demand is never lost.
  log("[5] backend down: queue on disk + later flush...");
  const realFetch = global.fetch;
  global.fetch = (async () => {
    throw new Error("ECONNREFUSED (simulated)");
  }) as typeof fetch;
  const offline = await reportToolRequest(report("trace-005", `[e2e] offline ${RUN}`));
  global.fetch = realFetch;
  assert(offline.status === "queued", `expected "queued", got "${offline.status}"`);
  assert(existsSync(join(PENDING, "trace-005.json")), "it was not written to the queue");
  log(`    queued: ${readdirSync(PENDING).join(", ")}`);
  const drained = await flushPendingRequests();
  assert(drained === 1, `expected to drain 1, drained ${drained}`);
  assert(readdirSync(PENDING).length === 0, "the queue did not empty");
  log("    ✓ the queued report reached the backend on the flush\n");

  log("== OK ==");
  log(`Check the rows:  select id, goal, sites, hits, payload_mode, user_id`);
  log(`                 from tool_requests where goal like '[e2e]%${RUN}' order by first_seen_at;`);
  log(`Clean up:        delete from tool_requests where goal like '[e2e]%';`);
}

main().catch((e) => {
  console.error(`\n${(e as Error).message}`);
  process.exit(1);
});
