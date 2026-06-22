import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * Config PERSISTIDA del usuario en ~/.tool-memory/config.json. Es la capa del medio entre
 * los defaults hardcodeados y las env vars:
 *
 *     env var   >   config.json   >   default
 *
 * La escribe el CLI (`browser-memory config set ...`); la leen config.ts y
 * registry/config.ts vía `cfg()`. Mismo patrón best-effort que credentials.ts
 * (lazy + cache + si el FS es read-only se sigue sin romper).
 *
 * OJO ciclo: este módulo NO importa config.ts. El config.json queda ANCLADO a la home por
 * env-o-default (NO al setting `home`): así, setear `home` reubica el dir de DATOS
 * (tools/traces/perfil, ver config.ts) sin mover el propio config.json — no hay bootstrap
 * circular. Si querés mover también el config.json, usá la env var TOOL_MEMORY_HOME.
 */

const ROOT = process.env.TOOL_MEMORY_HOME ?? join(homedir(), ".tool-memory");
export const configPath = join(ROOT, "config.json");

export interface SettingDef {
  /** Clave amigable del CLI (kebab-case), la que escribe el usuario. */
  key: string;
  /** Env var equivalente: override de mayor prioridad y nombre histórico. */
  env: string;
  describe: string;
  /** Texto del default para `config show` (no siempre es un valor literal). */
  defaultDesc: string;
  /** Devuelve un mensaje de error, o null si el valor es válido. */
  validate?: (v: string) => string | null;
  /**
   * Configurable desde el CLI (`config set ...`/`show`). Las demás claves SIGUEN
   * funcionando por env var o editando config.json a mano, pero el CLI no las expone:
   * mantenemos la superficie chica a propósito (solo prender/apagar el server y la URL).
   */
  cli?: boolean;
}

const BOOLS = ["1", "0", "true", "false", "yes", "no", "on", "off"];
function boolish(v: string): string | null {
  return BOOLS.includes(v.toLowerCase())
    ? null
    : `valor booleano inválido: "${v}" (usá on/off, true/false, 1/0)`;
}
function posInt(v: string): string | null {
  return /^\d+$/.test(v) && Number(v) > 0 ? null : `se esperaba un entero positivo, no "${v}"`;
}
function httpUrl(v: string): string | null {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? null : "la URL debe ser http(s)";
  } catch {
    return `URL inválida: "${v}"`;
  }
}
function nonEmpty(v: string): string | null {
  return v.trim() ? null : "el valor no puede estar vacío";
}

/** Catálogo único de settings configurables. Es la fuente de verdad del CLI y de `cfg()`. */
export const SETTINGS: SettingDef[] = [
  {
    key: "registry-url",
    env: "TOOL_MEMORY_REGISTRY_URL",
    describe: "URL del registry remoto (server) del que se bajan tools",
    defaultDesc: "https://api.browser-memory.com",
    validate: httpUrl,
    cli: true,
  },
  {
    key: "registry-enabled",
    env: "TOOL_MEMORY_REGISTRY_ENABLED",
    describe: "Prender/apagar el registry remoto (default on; off = memoria 100% local)",
    defaultDesc: "on",
    validate: boolish,
    cli: true,
  },
  {
    key: "registry-timeout-ms",
    env: "TOOL_MEMORY_REGISTRY_TIMEOUT_MS",
    describe: "Timeout de cada request al registry remoto (ms)",
    defaultDesc: "3000",
    validate: posInt,
  },
  {
    key: "cdp-port",
    env: "TOOL_MEMORY_CDP_PORT",
    describe: "Puerto remote-debugging del Chrome compartido (matchear con @playwright/mcp)",
    defaultDesc: "9333",
    validate: posInt,
  },
  {
    key: "chrome-bin",
    env: "TOOL_MEMORY_CHROME_BIN",
    describe: "Binario de Chrome a lanzar",
    defaultDesc: "Chrome del sistema, o el Chromium de Playwright",
    validate: nonEmpty,
  },
  {
    key: "reseed",
    env: "TOOL_MEMORY_RESEED",
    describe: "Refrescar sesión/login desde tu Chrome real en cada launch",
    defaultDesc: "on",
    validate: boolish,
  },
  {
    key: "profile",
    env: "TOOL_MEMORY_PROFILE",
    describe: 'Perfil de Chrome a sembrar (ej. "Default", "Profile 2")',
    defaultDesc: "el más usado (auto)",
    validate: nonEmpty,
  },
  {
    key: "seed-from",
    env: "TOOL_MEMORY_SEED_FROM",
    describe: "user-data-dir real de Chrome del que copiar sesiones",
    defaultDesc: "auto por plataforma",
    validate: nonEmpty,
  },
  {
    key: "home",
    env: "TOOL_MEMORY_HOME",
    describe: "Dir donde viven tus tools, índice, traces y el perfil de Chrome",
    defaultDesc: "~/.tool-memory",
    validate: nonEmpty,
    cli: true,
  },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
const BY_ENV = new Map(SETTINGS.map((s) => [s.env, s]));

export function findByKey(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

type FileShape = Record<string, string>;
let cache: FileShape | null = null;

/** Lee config.json (cacheado). `{}` si no existe o está corrupto. */
export function loadConfigFile(): FileShape {
  if (cache) return cache;
  try {
    if (existsSync(configPath)) {
      const raw = JSON.parse(readFileSync(configPath, "utf8")) as FileShape;
      if (raw && typeof raw === "object") {
        cache = raw;
        return raw;
      }
    }
  } catch {
    // Archivo corrupto/ilegible: lo tratamos como vacío.
  }
  cache = {};
  return cache;
}

function persist(obj: FileShape): void {
  cache = obj;
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(configPath, JSON.stringify(obj, null, 2) + "\n");
}

/** Solo para tests: olvida la cache en memoria (no toca el archivo). */
export function clearConfigCache(): void {
  cache = null;
}

/**
 * Resuelve un valor por su nombre de env var, con precedencia env → config.json → undefined
 * (el caller aplica su propio default). Lo usan config.ts y registry/config.ts en vez de
 * leer process.env directo.
 */
export function cfg(env: string): string | undefined {
  const fromEnv = process.env[env];
  if (fromEnv != null && fromEnv !== "") return fromEnv;
  const def = BY_ENV.get(env);
  if (!def) return undefined;
  const v = loadConfigFile()[def.key];
  return v != null && v !== "" ? v : undefined;
}

/** Interpreta un valor booleanoide ("0"/"false"/"no"/"off" => false). `dflt` si no hay valor. */
export function truthy(v: string | undefined, dflt: boolean): boolean {
  if (v == null || v === "") return dflt;
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
}

/** Escribe una clave al archivo. Lanza con mensaje claro si es desconocida, env-only o inválida. */
export function setSetting(key: string, value: string): void {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`config desconocida: "${key}" (mirá \`browser-memory config show\`)`);
  const err = def.validate?.(value);
  if (err) throw new Error(err);
  const file = { ...loadConfigFile(), [key]: value };
  persist(file);
}

/** Borra una clave del archivo (vuelve al default). Lanza si la clave es desconocida. */
export function unsetSetting(key: string): void {
  if (!BY_KEY.has(key)) throw new Error(`config desconocida: "${key}"`);
  const file = { ...loadConfigFile() };
  delete file[key];
  persist(file);
}

/** Vacía el archivo entero (vuelve todo a default). */
export function resetConfig(): void {
  persist({});
}

export interface EffectiveEntry {
  key: string;
  env: string;
  describe: string;
  /** Valor efectivo, o el texto del default si no hay override. */
  value: string;
  source: "env" | "config" | "default";
}

/** Vista resuelta de toda la config, con de dónde sale cada valor. Para `config show`. */
export function effectiveConfig(): EffectiveEntry[] {
  const file = loadConfigFile();
  return SETTINGS.map((def) => {
    const fromEnv = process.env[def.env];
    if (fromEnv != null && fromEnv !== "")
      return { key: def.key, env: def.env, describe: def.describe, value: fromEnv, source: "env" as const };
    const fromFile = file[def.key];
    if (fromFile != null && fromFile !== "")
      return { key: def.key, env: def.env, describe: def.describe, value: fromFile, source: "config" as const };
    return { key: def.key, env: def.env, describe: def.describe, value: def.defaultDesc, source: "default" as const };
  });
}
