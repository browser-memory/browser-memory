import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Aislamos la memoria a un dir temporal ANTES de importar los módulos que leen config.
process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-creds-"));

const { paths } = await import("../src/config.ts");
const { readApiKey, writeApiKey, clearApiKeyCache } = await import(
  "../src/registry/credentials.ts"
);

test("sin login previo, readApiKey devuelve null", () => {
  clearApiKeyCache();
  assert.equal(readApiKey(), null);
});

test("writeApiKey persiste y readApiKey la devuelve", () => {
  writeApiKey("bmk_test_123");
  assert.equal(readApiKey(), "bmk_test_123");
  assert.ok(existsSync(paths.auth), "debe escribir credentials.json");
  const onDisk = JSON.parse(readFileSync(paths.auth, "utf8"));
  assert.equal(onDisk.api_key, "bmk_test_123");
  assert.ok(onDisk.issued_at, "guarda issued_at");
});

test("tras limpiar la cache, readApiKey relee del disco", () => {
  clearApiKeyCache();
  assert.equal(readApiKey(), "bmk_test_123");
});

test("getApiKey prioriza la env var sobre el archivo", async () => {
  const prev = process.env.TOOL_MEMORY_REGISTRY_KEY;
  process.env.TOOL_MEMORY_REGISTRY_KEY = "bmk_env_override";
  const { getApiKey } = await import("../src/registry/config.ts");
  assert.equal(getApiKey(), "bmk_env_override");
  if (prev === undefined) delete process.env.TOOL_MEMORY_REGISTRY_KEY;
  else process.env.TOOL_MEMORY_REGISTRY_KEY = prev;
});
