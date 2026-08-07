import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = mkdtempSync(join(tmpdir(), "tm-req-"));
process.env.TOOL_MEMORY_HOME = HOME;
process.env.TOOL_MEMORY_REGISTRY_ENABLED = "1";
process.env.TOOL_MEMORY_REGISTRY_URL = "https://backend.test";
process.env.TOOL_MEMORY_REGISTRY_TIMEOUT_MS = "500";

const {
  buildRequestPayload,
  reportToolRequest,
  flushPendingRequests,
} = await import("../src/registry/requests.ts");

const PENDING = join(HOME, "requests", "pending");

const narration = {
  goal: "add a product to the cart",
  site: "www.coto.com.ar",
  outcome: "ok" as const,
  steps: [{ action: "navigate", url: "https://www.coto.com.ar" }],
};

function payload(over: Record<string, unknown> = {}) {
  return {
    ...buildRequestPayload({ traceId: "trace-001", goal: narration.goal, narration }),
    ...over,
  };
}

const realFetch = global.fetch;
afterEach(() => {
  global.fetch = realFetch;
  process.env.TOOL_MEMORY_REQUEST_REPORT = "full";
  rmSync(PENDING, { recursive: true, force: true });
});

/** Stubs fetch with a fixed answer and records the bodies it was called with. */
function stubFetch(answer: () => Response | Promise<Response>): { bodies: unknown[] } {
  const bodies: unknown[] = [];
  global.fetch = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body ?? "null")));
    return answer();
  }) as typeof fetch;
  return { bodies };
}

const ok = (body: unknown = { request_id: "r-1", hits: 1, status: "new" }) =>
  new Response(JSON.stringify(body), { status: 200 });

test("only the xhr/fetch calls are reported", () => {
  const p = buildRequestPayload({
    traceId: "trace-002",
    goal: narration.goal,
    narration,
    network: [
      { n: 1, method: "GET", url: "https://x/page", type: "document" },
      { n: 2, method: "GET", url: "https://x/logo.png", type: "image" },
      { n: 3, method: "POST", url: "https://x/api", type: "xhr", resBody: "{}" },
    ],
  });
  assert.equal(p.network.length, 1);
  assert.equal(p.network[0].url, "https://x/api");
  // normalized like discovery does it: no scheme, no www, lowercased
  assert.deepEqual(p.sites, ["coto.com.ar"]);
});

test("metadata mode reports the calls without any body", () => {
  const p = buildRequestPayload({
    traceId: "trace-003",
    goal: narration.goal,
    narration,
    mode: "metadata",
    network: [
      {
        n: 1,
        method: "POST",
        url: "https://x/api",
        type: "xhr",
        reqBody: "{\"q\":\"leche\"}",
        resBody: "{\"items\":[]}",
        reqHeaders: { "content-type": "application/json" },
      },
    ],
  });
  assert.equal(p.payload_mode, "metadata");
  assert.equal(p.network[0].resBody, undefined);
  assert.equal(p.network[0].reqBody, undefined);
  assert.equal(p.network[0].reqHeaders, undefined);
  assert.equal(p.network[0].url, "https://x/api"); // the endpoint itself is still reported
});

test("an oversized payload is shrunk, flagging the calls whose body was cut", () => {
  const big = "x".repeat(400_000);
  const p = buildRequestPayload({
    traceId: "trace-004",
    goal: narration.goal,
    narration,
    network: [
      { n: 1, method: "GET", url: "https://x/a", type: "xhr", resBody: big },
      { n: 2, method: "GET", url: "https://x/b", type: "xhr", resBody: big },
      { n: 3, method: "GET", url: "https://x/c", type: "xhr", resBody: big },
    ],
  });
  assert.ok(Buffer.byteLength(JSON.stringify(p)) <= 900_000);
  assert.equal(p.network.length, 3); // no call disappears...
  assert.ok(p.network.some((e) => e.body_dropped)); // ...only the bodies that didn't fit
  assert.ok(p.network.some((e) => e.resBody));
});

test("a report that gets through is not queued", async () => {
  const { bodies } = stubFetch(() => ok());
  const res = await reportToolRequest(payload());
  assert.equal(res.status, "reported");
  assert.equal(res.request_id, "r-1");
  assert.equal((bodies[0] as { goal: string }).goal, narration.goal);
  assert.ok(!existsSync(PENDING) || readdirSync(PENDING).length === 0);
});

test("a backend that is down queues the report and the flush drains it later", async () => {
  stubFetch(() => {
    throw new Error("ECONNREFUSED");
  });
  const res = await reportToolRequest(payload());
  assert.equal(res.status, "queued");
  assert.deepEqual(readdirSync(PENDING), ["trace-001.json"]);

  const { bodies } = stubFetch(() => ok());
  const drained = await flushPendingRequests();
  assert.equal(drained, 1);
  assert.equal((bodies[0] as { trace_id: string }).trace_id, "trace-001");
  assert.equal(readdirSync(PENDING).length, 0);
});

test("a 413 is retried once without bodies", async () => {
  let first = true;
  const { bodies } = stubFetch(() => {
    if (first) {
      first = false;
      return new Response("too big", { status: 413 });
    }
    return ok();
  });
  const p = payload({
    network: [{ n: 1, method: "GET", url: "https://x/a", type: "xhr", resBody: "{...}" }],
  });
  const res = await reportToolRequest(p as never);
  assert.equal(res.status, "reported");
  assert.equal(bodies.length, 2);
  assert.equal((bodies[1] as { payload_mode: string }).payload_mode, "metadata");
  assert.equal(
    (bodies[1] as { network: { resBody?: string }[] }).network[0].resBody,
    undefined,
  );
});

test("a 400 is not retried nor queued: that payload will never be accepted", async () => {
  const { bodies } = stubFetch(() => new Response("bad", { status: 400 }));
  const res = await reportToolRequest(payload());
  assert.equal(res.status, "disabled");
  assert.equal(bodies.length, 1);
  assert.ok(!existsSync(PENDING) || readdirSync(PENDING).length === 0);
});

test("request-report off sends nothing", async () => {
  process.env.TOOL_MEMORY_REQUEST_REPORT = "off";
  const { bodies } = stubFetch(() => ok());
  const res = await reportToolRequest(payload());
  assert.equal(res.status, "disabled");
  assert.equal(bodies.length, 0);
  assert.ok(!existsSync(PENDING) || readdirSync(PENDING).length === 0);
});
