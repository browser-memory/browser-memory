import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the memory to a temp dir BEFORE importing the modules that read config.
process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-creds-"));

const { paths } = await import("../src/config.ts");
const { readApiKey, writeApiKey, clearApiKeyCache } = await import(
  "../src/registry/credentials.ts"
);

test("without a prior login, readApiKey returns null", () => {
  clearApiKeyCache();
  assert.equal(readApiKey(), null);
});

test("writeApiKey persists and readApiKey returns it", () => {
  writeApiKey("bmk_test_123");
  assert.equal(readApiKey(), "bmk_test_123");
  assert.ok(existsSync(paths.auth), "must write credentials.json");
  const onDisk = JSON.parse(readFileSync(paths.auth, "utf8"));
  assert.equal(onDisk.api_key, "bmk_test_123");
  assert.ok(onDisk.issued_at, "stores issued_at");
});

test("after clearing the cache, readApiKey re-reads from disk", () => {
  clearApiKeyCache();
  assert.equal(readApiKey(), "bmk_test_123");
});

test("getApiKey prioritizes the env var over the file", async () => {
  const prev = process.env.TOOL_MEMORY_REGISTRY_KEY;
  process.env.TOOL_MEMORY_REGISTRY_KEY = "bmk_env_override";
  const { getApiKey } = await import("../src/registry/config.ts");
  assert.equal(getApiKey(), "bmk_env_override");
  if (prev === undefined) delete process.env.TOOL_MEMORY_REGISTRY_KEY;
  else process.env.TOOL_MEMORY_REGISTRY_KEY = prev;
});
