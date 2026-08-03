import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-settings-"));

const {
  cfg,
  truthy,
  setSetting,
  unsetSetting,
  resetConfig,
  effectiveConfig,
  configPath,
  clearConfigCache,
  SETTINGS,
} = await import("../src/settings.ts");

function fresh(): void {
  resetConfig();
  clearConfigCache();
  delete process.env.TOOL_MEMORY_REGISTRY_URL;
  delete process.env.TOOL_MEMORY_CDP_PORT;
}

test("set persists to the file and cfg reads it", () => {
  fresh();
  setSetting("registry-url", "https://mi-registry.com");
  clearConfigCache();
  assert.equal(cfg("TOOL_MEMORY_REGISTRY_URL"), "https://mi-registry.com");
  assert.ok(existsSync(configPath));
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, string>;
  assert.equal(raw["registry-url"], "https://mi-registry.com");
});

test("precedence: env var wins over config.json", () => {
  fresh();
  setSetting("registry-url", "https://file.com");
  process.env.TOOL_MEMORY_REGISTRY_URL = "https://env.com";
  assert.equal(cfg("TOOL_MEMORY_REGISTRY_URL"), "https://env.com");
  delete process.env.TOOL_MEMORY_REGISTRY_URL;
});

test("unset reverts to the default (cfg => undefined)", () => {
  fresh();
  setSetting("registry-url", "https://x.com");
  unsetSetting("registry-url");
  clearConfigCache();
  assert.equal(cfg("TOOL_MEMORY_REGISTRY_URL"), undefined);
});

test("validation rejects invalid values", () => {
  fresh();
  assert.throws(() => setSetting("registry-url", "not-a-url"), /invalid URL/);
  assert.throws(() => setSetting("cdp-port", "abc"), /positive integer/);
  assert.throws(() => setSetting("registry-enabled", "maybe"), /invalid boolean/);
  assert.throws(() => setSetting("desconocida", "x"), /unknown config/);
});

test("home can be configured by file and relocates the data dir", () => {
  fresh();
  // config.json is anchored to the env (set at the start): it still resolves there.
  // Without the env, the data dir (home) is governed by the file.
  const saved = process.env.TOOL_MEMORY_HOME;
  delete process.env.TOOL_MEMORY_HOME;
  try {
    setSetting("home", "/tmp/datos-bm");
    clearConfigCache();
    assert.equal(cfg("TOOL_MEMORY_HOME"), "/tmp/datos-bm");
  } finally {
    process.env.TOOL_MEMORY_HOME = saved;
  }
});

test("truthy interprets boolean-ish values with a default", () => {
  assert.equal(truthy(undefined, true), true);
  assert.equal(truthy("", false), false);
  assert.equal(truthy("off", true), false);
  assert.equal(truthy("0", true), false);
  assert.equal(truthy("on", false), true);
});

test("the remote registry is ON by default", async () => {
  fresh();
  delete process.env.TOOL_MEMORY_REGISTRY_ENABLED;
  const { registryConfig } = await import("../src/registry/config.ts");
  // registryConfig is evaluated once on import; with a clean HOME and no env
  // the default has to be true.
  assert.equal(registryConfig.enabled, true);
});

test("the CLI exposes home, registry-url and registry-enabled", () => {
  const cliKeys = SETTINGS.filter((s) => s.cli).map((s) => s.key);
  assert.deepEqual(cliKeys.sort(), ["home", "registry-enabled", "registry-url"]);
});

test("an un-interpolated placeholder is not a value", () => {
  fresh();
  // What a host sends when it never expanded the manifest's default: taking it at face
  // value would make us mkdir a directory literally named "${HOME}".
  process.env.TOOL_MEMORY_REGISTRY_URL = "${HOME}/.tool-memory";
  assert.equal(cfg("TOOL_MEMORY_REGISTRY_URL"), undefined);
  process.env.TOOL_MEMORY_REGISTRY_URL = "${user_config.registry_url}";
  assert.equal(cfg("TOOL_MEMORY_REGISTRY_URL"), undefined);
  // A real value that merely contains a dollar sign still comes through.
  process.env.TOOL_MEMORY_REGISTRY_URL = "https://reg.com/a$b";
  assert.equal(cfg("TOOL_MEMORY_REGISTRY_URL"), "https://reg.com/a$b");
  delete process.env.TOOL_MEMORY_REGISTRY_URL;
});

test("effectiveConfig reports the source of each value", () => {
  fresh();
  setSetting("registry-url", "https://file.com");
  process.env.TOOL_MEMORY_CDP_PORT = "9999";
  const rows = effectiveConfig();
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(byKey["registry-url"].source, "config");
  assert.equal(byKey["cdp-port"].source, "env");
  assert.equal(byKey["registry-timeout-ms"].source, "default");
  delete process.env.TOOL_MEMORY_CDP_PORT;
});
