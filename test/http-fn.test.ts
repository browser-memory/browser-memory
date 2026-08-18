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

test("proxy:true routes egress through an http forward-proxy", async () => {
  // A forwarding HTTP proxy: undici sends `GET http://host/path` on the proxy socket
  // for plain-http targets (CONNECT is only for TLS, covered by the real-site e2e).
  const seen: string[] = [];
  const proxy = http.createServer((req, res) => {
    seen.push(req.url ?? "");
    res.end(JSON.stringify({ ok: true, via: "proxy" }));
  });
  await new Promise<void>((r) => proxy.listen(0, "127.0.0.1", () => r()));
  const proxyPort = (proxy.address() as any).port;

  process.env.TOOL_MEMORY_PROXIES = `http://127.0.0.1:${proxyPort}`;
  resetProxyPool();
  const fn = `async () => { const r = await fetch('http://target.invalid/hit'); return await r.json(); }`;
  const t = parseTool({ ...baseTool, recipe: { kind: "http-fn", fn, proxy: true } });
  const r = await runHttpFn(t as any, {});
  proxy.close();
  delete process.env.TOOL_MEMORY_PROXIES;
  resetProxyPool();

  assert.equal(r.ok, true);
  assert.equal((r.result as any).via, "proxy");
  // The proxy saw the absolute-URI request → egress really went through it, not direct
  // (a direct fetch to target.invalid would have failed to resolve).
  assert.ok(seen.some((u) => u.includes("target.invalid")));
});
