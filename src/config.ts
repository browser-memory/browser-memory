import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

/**
 * Rutas y parámetros globales del sistema.
 *
 * La memoria es global (no por-proyecto): un tool de un sitio sirve en cualquier
 * contexto. Vive en ~/.tool-memory/ salvo override por env (útil para tests).
 */
const ROOT = process.env.TOOL_MEMORY_HOME ?? join(homedir(), ".tool-memory");

export const paths = {
  root: ROOT,
  tools: join(ROOT, "tools"),
  index: join(ROOT, "index.json"),
  traces: join(ROOT, "traces"),
  creds: join(ROOT, "creds.local.json"),
  chromeProfile: join(ROOT, "chrome-profile"),
};

/** Puerto del remote-debugging del Chrome compartido. */
export const cdpPort = Number(process.env.TOOL_MEMORY_CDP_PORT ?? 9333);

/**
 * Si está activo (TOOL_MEMORY_RESEED=1), cada vez que se LANZA el Chrome (una vez por
 * sesión, lazy) refrescamos los archivos de sesión (cookies/login/storage) desde el
 * Chrome real del usuario. Así arrastrás logins nuevos sin re-copiar todo el perfil.
 * Para cookies 100% frescas conviene tener el Chrome real cerrado en ese momento.
 */
export const reseedEnabled = ["1", "true", "yes"].includes(
  (process.env.TOOL_MEMORY_RESEED ?? "").toLowerCase(),
);

/** Endpoint CDP al que se atachan tanto el runner como @playwright/mcp. */
export const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;

/**
 * Binario de Chrome a lanzar. Preferimos el Google Chrome del sistema (perfil real
 * del usuario para auth manual la primera vez); si no está, caemos al chromium que
 * trae Playwright.
 */
const SYSTEM_CHROME =
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

export function resolveChromeBinary(): string | undefined {
  if (process.env.TOOL_MEMORY_CHROME_BIN) return process.env.TOOL_MEMORY_CHROME_BIN;
  if (existsSync(SYSTEM_CHROME)) return SYSTEM_CHROME;
  // undefined => dejamos que Playwright use su chromium empaquetado.
  return undefined;
}

/**
 * user-data-dir REAL del Chrome del usuario (donde viven sus cuentas logueadas).
 * Es el origen del "seed": la primera vez copiamos su Default acá para arrancar con
 * las sesiones ya iniciadas, sin tocar el perfil Default (Chrome 136+ bloquea el CDP
 * sobre el Default por seguridad, por eso usamos una copia en un dir propio).
 * Override con TOOL_MEMORY_SEED_FROM. Devuelve undefined si no se encuentra.
 */
export function realChromeUserDataDir(): string | undefined {
  if (process.env.TOOL_MEMORY_SEED_FROM) return process.env.TOOL_MEMORY_SEED_FROM;
  const macDir = join(homedir(), "Library", "Application Support", "Google", "Chrome");
  if (existsSync(join(macDir, "Default"))) return macDir;
  return undefined;
}
