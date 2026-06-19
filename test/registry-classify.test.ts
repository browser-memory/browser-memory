import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-classify-"));

const { classify, RegistryAuthError, RegistryRateLimitError } = await import(
  "../src/registry/client.ts"
);

function res(status: number, headers?: Record<string, string>): Response {
  return new Response("", { status, headers });
}

test("401 y 403 lanzan RegistryAuthError con el status", () => {
  assert.throws(() => classify(res(401)), (e) => e instanceof RegistryAuthError && e.status === 401);
  assert.throws(() => classify(res(403)), (e) => e instanceof RegistryAuthError && e.status === 403);
});

test("429 lanza RegistryRateLimitError y parsea Retry-After", () => {
  assert.throws(
    () => classify(res(429, { "retry-after": "42" })),
    (e) => e instanceof RegistryRateLimitError && e.retryAfterSeconds === 42,
  );
});

test("429 sin Retry-After deja retryAfterSeconds en null", () => {
  assert.throws(
    () => classify(res(429)),
    (e) => e instanceof RegistryRateLimitError && e.retryAfterSeconds === null,
  );
});

test("Retry-After no numérico (date) cae a null sin romper", () => {
  assert.throws(
    () => classify(res(429, { "retry-after": "Wed, 21 Oct 2025 07:28:00 GMT" })),
    (e) => e instanceof RegistryRateLimitError && e.retryAfterSeconds === null,
  );
});

test("200, 404 y 5xx NO lanzan (best-effort lo maneja cada función)", () => {
  assert.doesNotThrow(() => classify(res(200)));
  assert.doesNotThrow(() => classify(res(404)));
  assert.doesNotThrow(() => classify(res(503)));
});
