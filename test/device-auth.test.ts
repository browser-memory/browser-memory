import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-device-"));

const { paths } = await import("../src/config.ts");
const { pollDevice, attemptDeviceLogin } = await import("../src/registry/device-auth.ts");
const { readApiKey, clearApiKeyCache } = await import("../src/registry/credentials.ts");

const realFetch = globalThis.fetch;

/** fetch stub that routes by URL: returns {status, body} or "throw" per endpoint. */
function routeFetch(fn: (url: string) => { status: number; body: unknown } | "throw"): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const r = fn(url);
    if (r === "throw") throw new Error("network down");
    return new Response(JSON.stringify(r.body), {
      status: r.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
}

/** Simple stub for the pollDevice tests (a single endpoint). */
function stubFetch(status: number, body: unknown): void {
  routeFetch(() => (body === "throw" ? "throw" : { status, body }));
}

test.afterEach(() => {
  globalThis.fetch = realFetch;
  clearApiKeyCache();
  if (existsSync(paths.pendingDevice)) rmSync(paths.pendingDevice);
  if (existsSync(paths.auth)) rmSync(paths.auth);
});

// ---- pollDevice (single poll) ----

test("poll returns the api_key when the server authorizes", async () => {
  stubFetch(200, { api_key: "bmk_authorized" });
  assert.equal(await pollDevice("dc_1"), "bmk_authorized");
});

test("poll returns 'pending' while not yet authorized", async () => {
  stubFetch(200, { status: "pending" });
  assert.equal(await pollDevice("dc_1"), "pending");
});

test("poll returns null (aborts the login) on 400 expired_token", async () => {
  stubFetch(400, { error: "expired_token" });
  assert.equal(await pollDevice("dc_1"), null);
});

test("poll treats a 5xx as 'pending' (transient, keeps waiting)", async () => {
  stubFetch(503, { error: "boom" });
  assert.equal(await pollDevice("dc_1"), "pending");
});

test("poll treats a network error as 'pending' (does not abort the login)", async () => {
  stubFetch(0, "throw");
  assert.equal(await pollDevice("dc_1"), "pending");
});

// ---- attemptDeviceLogin (non-blocking, device-code on disk) ----

test("with no pending: starts the device flow, returns a link and persists the device_code", async () => {
  routeFetch((url) =>
    url.endsWith("/device/start")
      ? {
          status: 200,
          body: {
            device_code: "dc_new",
            user_code: "WDJB-MJHT",
            verification_url: "https://site/cli-auth?code=WDJB-MJHT",
            expires_in: 900,
          },
        }
      : { status: 200, body: {} },
  );
  const outcome = await attemptDeviceLogin();
  assert.equal(outcome.status, "pending");
  assert.match(
    outcome.status === "pending" ? outcome.verificationUrl : "",
    /cli-auth\?code=WDJB-MJHT/,
  );
  assert.ok(existsSync(paths.pendingDevice), "must persist pending-device.json");
});

test("with an already-authorized pending: claims the key, caches it and deletes the pending", async () => {
  writeFileSync(
    paths.pendingDevice,
    JSON.stringify({
      device_code: "dc_pending",
      user_code: "AA-BB",
      verification_url: "https://site/cli-auth?code=AA-BB",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    }) + "\n",
  );
  routeFetch((url) =>
    url.endsWith("/device/poll")
      ? { status: 200, body: { api_key: "bmk_from_device" } }
      : { status: 200, body: {} },
  );
  const outcome = await attemptDeviceLogin();
  assert.equal(outcome.status, "authorized");
  assert.equal(readApiKey(), "bmk_from_device");
  assert.ok(!existsSync(paths.pendingDevice), "must delete the pending after authorizing");
});

test("with a pending not yet authorized: returns the same link, with no new start", async () => {
  writeFileSync(
    paths.pendingDevice,
    JSON.stringify({
      device_code: "dc_pending",
      user_code: "CC-DD",
      verification_url: "https://site/cli-auth?code=CC-DD",
      expires_at: new Date(Date.now() + 600_000).toISOString(),
    }) + "\n",
  );
  let startCalls = 0;
  routeFetch((url) => {
    if (url.endsWith("/device/start")) startCalls++;
    if (url.endsWith("/device/poll")) return { status: 200, body: { status: "pending" } };
    return { status: 200, body: {} };
  });
  const outcome = await attemptDeviceLogin();
  assert.equal(outcome.status, "pending");
  assert.match(outcome.status === "pending" ? outcome.verificationUrl : "", /code=CC-DD/);
  assert.equal(startCalls, 0, "must not start a new device flow if one is still active");
});
