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
  delete process.env.TOOL_MEMORY_RESEED;
}

test("set persiste al archivo y cfg lo lee", () => {
  fresh();
  setSetting("registry-url", "https://mi-registry.com");
  clearConfigCache();
  assert.equal(cfg("TOOL_MEMORY_REGISTRY_URL"), "https://mi-registry.com");
  assert.ok(existsSync(configPath));
  const raw = JSON.parse(readFileSync(configPath, "utf8")) as Record<string, string>;
  assert.equal(raw["registry-url"], "https://mi-registry.com");
});

test("precedencia: env var gana sobre config.json", () => {
  fresh();
  setSetting("registry-url", "https://file.com");
  process.env.TOOL_MEMORY_REGISTRY_URL = "https://env.com";
  assert.equal(cfg("TOOL_MEMORY_REGISTRY_URL"), "https://env.com");
  delete process.env.TOOL_MEMORY_REGISTRY_URL;
});

test("unset vuelve al default (cfg => undefined)", () => {
  fresh();
  setSetting("registry-url", "https://x.com");
  unsetSetting("registry-url");
  clearConfigCache();
  assert.equal(cfg("TOOL_MEMORY_REGISTRY_URL"), undefined);
});

test("validación rechaza valores inválidos", () => {
  fresh();
  assert.throws(() => setSetting("registry-url", "not-a-url"), /URL inválida/);
  assert.throws(() => setSetting("cdp-port", "abc"), /entero positivo/);
  assert.throws(() => setSetting("registry-enabled", "maybe"), /booleano inválido/);
  assert.throws(() => setSetting("desconocida", "x"), /config desconocida/);
});

test("home se puede configurar por archivo y relocaliza el data dir", () => {
  fresh();
  // El config.json está anclado a la env (seteada al inicio): sigue resolviéndose ahí.
  // Sin la env, el data dir (home) lo gobierna el archivo.
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

test("truthy interpreta booleanoides con default", () => {
  assert.equal(truthy(undefined, true), true);
  assert.equal(truthy("", false), false);
  assert.equal(truthy("off", true), false);
  assert.equal(truthy("0", true), false);
  assert.equal(truthy("on", false), true);
});

test("el registry remoto está APAGADO por defecto", async () => {
  fresh();
  delete process.env.TOOL_MEMORY_REGISTRY_ENABLED;
  const { registryConfig } = await import("../src/registry/config.ts");
  // registryConfig se evalúa una vez al importar el módulo; con HOME limpio y sin env
  // el default tiene que ser false.
  assert.equal(registryConfig.enabled, false);
});

test("el CLI expone home, registry-url y registry-enabled", () => {
  const cliKeys = SETTINGS.filter((s) => s.cli).map((s) => s.key);
  assert.deepEqual(cliKeys.sort(), ["home", "registry-enabled", "registry-url"]);
});

test("effectiveConfig reporta la fuente de cada valor", () => {
  fresh();
  setSetting("registry-url", "https://file.com");
  process.env.TOOL_MEMORY_RESEED = "off";
  const rows = effectiveConfig();
  const byKey = Object.fromEntries(rows.map((r) => [r.key, r]));
  assert.equal(byKey["registry-url"].source, "config");
  assert.equal(byKey["reseed"].source, "env");
  assert.equal(byKey["registry-timeout-ms"].source, "default");
  delete process.env.TOOL_MEMORY_RESEED;
});
