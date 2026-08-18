import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

/**
 * The user's PERSISTED config in ~/.tool-memory/config.json. It's the middle layer between
 * the hardcoded defaults and the env vars:
 *
 *     env var   >   config.json   >   default
 *
 * The CLI writes it (`browser-memory config set ...`); config.ts and
 * registry/config.ts read it via `cfg()`. Same best-effort pattern as credentials.ts
 * (lazy + cache + if the FS is read-only it keeps going without breaking).
 *
 * CYCLE WARNING: this module does NOT import config.ts. The config.json is ANCHORED to the home by
 * env-or-default (NOT to the `home` setting): this way, setting `home` relocates the DATA dir
 * (tools/traces/profile, see config.ts) without moving the config.json itself — there's no circular
 * bootstrap. If you want to move the config.json too, use the env var TOOL_MEMORY_HOME.
 */

const ROOT = process.env.TOOL_MEMORY_HOME ?? join(homedir(), ".tool-memory");
export const configPath = join(ROOT, "config.json");

export interface SettingDef {
  /** Friendly CLI key (kebab-case), the one the user types. */
  key: string;
  /** Equivalent env var: highest-priority override and historical name. */
  env: string;
  describe: string;
  /** Text of the default for `config show` (not always a literal value). */
  defaultDesc: string;
  /** Returns an error message, or null if the value is valid. */
  validate?: (v: string) => string | null;
  /**
   * Configurable from the CLI (`config set ...`/`show`). The other keys STILL
   * work via env var or by hand-editing config.json, but the CLI does not expose them:
   * we keep the surface small on purpose (only turning the server on/off and the URL).
   */
  cli?: boolean;
}

const BOOLS = ["1", "0", "true", "false", "yes", "no", "on", "off"];
function boolish(v: string): string | null {
  return BOOLS.includes(v.toLowerCase())
    ? null
    : `invalid boolean value: "${v}" (use on/off, true/false, 1/0)`;
}
function posInt(v: string): string | null {
  return /^\d+$/.test(v) && Number(v) > 0 ? null : `expected a positive integer, not "${v}"`;
}
function httpUrl(v: string): string | null {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:" ? null : "URL must be http(s)";
  } catch {
    return `invalid URL: "${v}"`;
  }
}
function nonEmpty(v: string): string | null {
  return v.trim() ? null : "the value cannot be empty";
}
function oneOf(...allowed: string[]): (v: string) => string | null {
  return (v) =>
    allowed.includes(v.toLowerCase())
      ? null
      : `invalid value: "${v}" (use ${allowed.join(" / ")})`;
}

/** Single catalog of configurable settings. It's the source of truth for the CLI and for `cfg()`. */
export const SETTINGS: SettingDef[] = [
  {
    key: "registry-url",
    env: "TOOL_MEMORY_REGISTRY_URL",
    describe: "URL of the remote registry (server) from which tools are pulled",
    defaultDesc: "https://api.browser-memory.com",
    validate: httpUrl,
    cli: true,
  },
  {
    key: "registry-enabled",
    env: "TOOL_MEMORY_REGISTRY_ENABLED",
    describe: "Turn the remote registry on/off (default on; off = 100% local memory)",
    defaultDesc: "on",
    validate: boolish,
    cli: true,
  },
  {
    key: "registry-timeout-ms",
    env: "TOOL_MEMORY_REGISTRY_TIMEOUT_MS",
    describe: "Timeout of each request to the remote registry (ms)",
    defaultDesc: "3000",
    validate: posInt,
  },
  {
    key: "prefer-local",
    env: "TOOL_MEMORY_PREFER_LOCAL",
    describe:
      "Resolve items from the local disk FIRST and hit the registry only when the item " +
      "isn't there (dev/testing of tools whose name the registry also serves). Default " +
      "off: the server is the source of truth",
    defaultDesc: "off",
    validate: boolish,
  },
  {
    key: "request-report",
    env: "TOOL_MEMORY_REQUEST_REPORT",
    describe:
      "What `request` sends to the registry when you did a web action there was no tool " +
      "for: full = goal + steps + the recorded xhr/fetch calls (with their bodies, " +
      "secrets already redacted) so the tool can be built from it; metadata = the same " +
      "without any body; off = nothing leaves the machine (the trace still lands on disk)",
    defaultDesc: "full",
    validate: oneOf("full", "metadata", "off"),
    cli: true,
  },
  {
    key: "cdp-port",
    env: "TOOL_MEMORY_CDP_PORT",
    describe: "Internal remote-debugging port of the dedicated Chrome this server controls",
    defaultDesc: "9333",
    validate: posInt,
  },
  {
    key: "chrome-bin",
    env: "TOOL_MEMORY_CHROME_BIN",
    describe: "Chrome binary to launch",
    defaultDesc: "system Chrome, or Playwright's Chromium",
    validate: nonEmpty,
  },
  {
    key: "home",
    env: "TOOL_MEMORY_HOME",
    describe: "Dir where your tools, index, traces and Chrome profile live",
    defaultDesc: "~/.tool-memory",
    validate: nonEmpty,
    cli: true,
  },
  {
    key: "proxies",
    env: "TOOL_MEMORY_PROXIES",
    describe:
      "Egress proxies for `http-fn` tools with `proxy: true` (no effect on browser " +
      "tools). Comma/space separated URLs, e.g. " +
      "'http://user:pass@gateway:port'. Each http-fn call takes the next one round-robin " +
      "(one gateway is often enough: residential providers rotate the exit IP per " +
      "connection). Empty = direct connection off the local IP",
    defaultDesc: "(none: direct connection)",
    validate: nonEmpty,
  },
];

const BY_KEY = new Map(SETTINGS.map((s) => [s.key, s]));
const BY_ENV = new Map(SETTINGS.map((s) => [s.env, s]));

export function findByKey(key: string): SettingDef | undefined {
  return BY_KEY.get(key);
}

type FileShape = Record<string, string>;
let cache: FileShape | null = null;

/** Reads config.json (cached). `{}` if it doesn't exist or is corrupt. */
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
    // Corrupt/unreadable file: we treat it as empty.
  }
  cache = {};
  return cache;
}

function persist(obj: FileShape): void {
  cache = obj;
  mkdirSync(ROOT, { recursive: true });
  writeFileSync(configPath, JSON.stringify(obj, null, 2) + "\n");
}

/** Tests only: forgets the in-memory cache (does not touch the file). */
export function clearConfigCache(): void {
  cache = null;
}

/**
 * True for a value a host meant to interpolate and didn't, e.g. the literal `${HOME}/.tool-memory`
 * reaching us because the MCPB manifest's default was never expanded. Treating it as a real value
 * is always wrong: we'd create a directory named `${HOME}`. Unset beats nonsense — the caller's
 * default is the right answer.
 */
function unexpanded(v: string): boolean {
  return /\$\{[^}]*\}/.test(v);
}

/**
 * Resolves a value by its env var name, with precedence env → config.json → undefined
 * (the caller applies its own default). config.ts and registry/config.ts use it instead of
 * reading process.env directly.
 */
export function cfg(env: string): string | undefined {
  const fromEnv = process.env[env];
  if (fromEnv != null && fromEnv !== "" && !unexpanded(fromEnv)) return fromEnv;
  const def = BY_ENV.get(env);
  if (!def) return undefined;
  const v = loadConfigFile()[def.key];
  return v != null && v !== "" && !unexpanded(v) ? v : undefined;
}

/** Interprets a boolean-ish value ("0"/"false"/"no"/"off" => false). `dflt` if there's no value. */
export function truthy(v: string | undefined, dflt: boolean): boolean {
  if (v == null || v === "") return dflt;
  return !["0", "false", "no", "off"].includes(v.toLowerCase());
}

/** Writes a key to the file. Throws with a clear message if unknown, env-only or invalid. */
export function setSetting(key: string, value: string): void {
  const def = BY_KEY.get(key);
  if (!def) throw new Error(`unknown config: "${key}" (see \`browser-memory config show\`)`);
  const err = def.validate?.(value);
  if (err) throw new Error(err);
  const file = { ...loadConfigFile(), [key]: value };
  persist(file);
}

/** Deletes a key from the file (reverts to default). Throws if the key is unknown. */
export function unsetSetting(key: string): void {
  if (!BY_KEY.has(key)) throw new Error(`unknown config: "${key}"`);
  const file = { ...loadConfigFile() };
  delete file[key];
  persist(file);
}

/** Clears the entire file (reverts everything to default). */
export function resetConfig(): void {
  persist({});
}

export interface EffectiveEntry {
  key: string;
  env: string;
  describe: string;
  /** Effective value, or the text of the default if there's no override. */
  value: string;
  source: "env" | "config" | "default";
}

/** Resolved view of the whole config, with where each value comes from. For `config show`. */
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
