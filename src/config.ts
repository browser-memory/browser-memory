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
