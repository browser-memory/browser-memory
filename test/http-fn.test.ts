import { test } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

const { parseTool } = await import("../src/schema/tool.ts");
const { runHttpFn } = await import("../src/runner/http-fn.ts");
const { nextDispatcher, proxyCount, resetProxyPool } = await import(
  "../src/runner/proxy-pool.ts"
);

const baseTool = {
  name: "echo-fn",
  site: "example.com",
  intent: "echo",
  keywords: ["x"],
  type: "primitive",
  side_effect: "read",
  requires: { params: {}, env: {} },
  success_assertion: { type: "json", jsonPath: "ok" },
};

test("http-fn recipe parses", () => {
  const t = parseTool({
    ...baseTool,
    recipe: { kind: "http-fn", fn: "async () => ({ ok: true })", proxy: true },
  });
  assert.equal(t.recipe.kind, "http-fn");
});

test("runHttpFn runs the fn in Node and passes params", async () => {
  const t = parseTool({
    ...baseTool,
    recipe: { kind: "http-fn", fn: "async (p) => ({ ok: true, got: p.n * 2 })" },
  });
  const r = await runHttpFn(t as any, { n: 21 });
  assert.equal(r.ok, true);
  assert.equal((r.result as any).got, 42);
});

test("success_assertion over json fails when the path is empty", async () => {
  const t = parseTool({
    ...baseTool,
    recipe: { kind: "http-fn", fn: "async () => ({ nope: 1 })" },
  });
  const r = await runHttpFn(t as any, {});
  assert.equal(r.ok, false);
  assert.equal(r.error?.mode, "tool-broken");
});

test("a per-call cookie jar carries Set-Cookie to the next request", async () => {
  // Server sets a cookie on /a and echoes back whatever cookie arrives on /b.
  const srv = http.createServer((req, res) => {
    if (req.url === "/a") {
      res.setHeader("set-cookie", "sid=abc123; Path=/");
      res.end(JSON.stringify({ step: "a" }));
    } else {
      res.end(JSON.stringify({ ok: true, cookie: req.headers.cookie ?? null }));
    }
  });
  await new Promise<void>((r) => srv.listen(0, "127.0.0.1", () => r()));
  const port = (srv.address() as any).port;
  const fn = `async () => { await fetch('http://127.0.0.1:${port}/a'); const r = await fetch('http://127.0.0.1:${port}/b'); return await r.json(); }`;
  const t = parseTool({ ...baseTool, recipe: { kind: "http-fn", fn } });
  const r = await runHttpFn(t as any, {});
  srv.close();
  assert.equal(r.ok, true);
  assert.equal((r.result as any).cookie, "sid=abc123");
});

test("cookies are isolated per host (no cross-origin leak)", async () => {
  // Two servers each set their OWN cookie; a request to one must never carry the other's.
  const mk = (name: string) =>
    new Promise<any>((resolve) => {
      const s = http.createServer((req, res) => {
        if (req.url === "/set") res.setHeader("set-cookie", `who=${name}; Path=/`);
        res.end(JSON.stringify({ cookie: req.headers.cookie ?? null }));
      });
      s.listen(0, "127.0.0.1", () => resolve(s));
    });
  const a = await mk("A");
  const b = await mk("B");
  const pa = (a.address() as any).port;
  const pb = (b.address() as any).port;
  // Set a cookie on host A, then hit host B: B must see NO cookie (not A's).
  const fn = `async () => {
    await fetch('http://127.0.0.1:${pa}/set');
    const rb = await fetch('http://127.0.0.1:${pb}/read');
    const ra = await fetch('http://127.0.0.1:${pa}/read');
    return { ok: true, bSaw: (await rb.json()).cookie, aSaw: (await ra.json()).cookie };
  }`;
  const t = parseTool({ ...baseTool, recipe: { kind: "http-fn", fn } });
  const r = await runHttpFn(t as any, {});
  a.close();
  b.close();
  assert.equal(r.ok, true);
  assert.equal((r.result as any).bSaw, null); // host B never saw host A's cookie
  assert.equal((r.result as any).aSaw, "who=A"); // host A still gets its own
});

test("proxy pool rotates round-robin and is empty by default", () => {
  resetProxyPool();
  assert.equal(proxyCount(), 0);
  assert.equal(nextDispatcher(), null);
  process.env.TOOL_MEMORY_PROXIES = "http://a:1, http://b:1";
  resetProxyPool();
  assert.equal(proxyCount(), 2);
  assert.equal(nextDispatcher()?.url, "http://a:1");
  assert.equal(nextDispatcher()?.url, "http://b:1");
  assert.equal(nextDispatcher()?.url, "http://a:1");
  delete process.env.TOOL_MEMORY_PROXIES;
  resetProxyPool();
});

test("proxy:true routes egress through the dispatcher, not direct", async () => {
  // Point the pool at a dead proxy (nothing listening). A request to a host that
  // resolves fine (example.com) must now FAIL with a proxy connection error: proof the
  // fetch went to the proxy instead of straight to the host. Direct would have
  // succeeded. Fast and deterministic (ECONNREFUSED), no hang. The happy-path egress
  // through a live proxy is covered by test/smoke-http-fn.ts and the Bright Data e2e.
  process.env.TOOL_MEMORY_PROXIES = "http://127.0.0.1:59999";
  resetProxyPool();
  const fn = `async () => { const r = await fetch('https://example.com', { signal: AbortSignal.timeout(8000) }); return { ok: r.ok }; }`;
  const t = parseTool({ ...baseTool, recipe: { kind: "http-fn", fn, proxy: true } });
  const r = await runHttpFn(t as any, {});
  delete process.env.TOOL_MEMORY_PROXIES;
  resetProxyPool();

  assert.equal(r.ok, false); // the dead proxy broke the request → dispatcher was applied
  assert.equal(r.error?.mode, "tool-broken");
});
