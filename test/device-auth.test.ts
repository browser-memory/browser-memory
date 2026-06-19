import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-device-"));

const { pollDevice } = await import("../src/registry/device-auth.ts");

const realFetch = globalThis.fetch;

/** Stub de fetch que responde con el status/body dados (o lanza si body === "throw"). */
function stubFetch(status: number, body: unknown): void {
  globalThis.fetch = (async () => {
    if (body === "throw") throw new Error("network down");
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

test("poll devuelve la api_key cuando el server autoriza", async () => {
  stubFetch(200, { api_key: "bmk_authorized" });
  assert.equal(await pollDevice("dc_1"), "bmk_authorized");
});

test("poll devuelve 'pending' mientras no se autorizó", async () => {
  stubFetch(200, { status: "pending" });
  assert.equal(await pollDevice("dc_1"), "pending");
});

test("poll devuelve null (corta el login) ante 400 expired_token", async () => {
  stubFetch(400, { error: "expired_token" });
  assert.equal(await pollDevice("dc_1"), null);
});

test("poll trata un 5xx como 'pending' (transitorio, sigue esperando)", async () => {
  stubFetch(503, { error: "boom" });
  assert.equal(await pollDevice("dc_1"), "pending");
});

test("poll trata un error de red como 'pending' (no aborta el login)", async () => {
  stubFetch(0, "throw");
  assert.equal(await pollDevice("dc_1"), "pending");
});
