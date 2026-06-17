import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";

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
 * Cada vez que se LANZA el Chrome (una vez por sesión, lazy) refrescamos los archivos
 * de sesión (cookies/login/storage) desde el Chrome real del usuario. Así arrastrás
 * logins nuevos sin re-copiar todo el perfil. Prendido por defecto para que cualquier
 * usuario levante su browser con las sesiones al día sin configurar nada; apagalo con
 * TOOL_MEMORY_RESEED=0. Para cookies 100% frescas conviene tener el Chrome real cerrado.
 */
export const reseedEnabled = !["0", "false", "no"].includes(
  (process.env.TOOL_MEMORY_RESEED ?? "").toLowerCase(),
);

/** Endpoint CDP al que se atachan tanto el runner como @playwright/mcp. */
export const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;

/** Primer candidato existente de una lista (o undefined). */
function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((p) => p && existsSync(p));
}

/**
 * Binario de Chrome a lanzar, por plataforma. Preferimos el Google Chrome del sistema
 * (perfil real del usuario para auth manual la primera vez); si no está, caemos al
 * chromium que trae Playwright. Override con TOOL_MEMORY_CHROME_BIN.
 */
export function resolveChromeBinary(): string | undefined {
  if (process.env.TOOL_MEMORY_CHROME_BIN) return process.env.TOOL_MEMORY_CHROME_BIN;
  const home = homedir();
  let candidates: string[] = [];
  if (process.platform === "darwin") {
    candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  } else if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    candidates = [
      join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      join(local, "Google", "Chrome", "Application", "chrome.exe"),
    ];
  } else {
    // linux y otros unix
    candidates = [
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/opt/google/chrome/chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ];
  }
  // undefined => dejamos que Playwright use su chromium empaquetado.
  return firstExisting(candidates);
}

/**
 * user-data-dir REAL del Chrome del usuario (donde viven sus cuentas logueadas), por
 * plataforma. Es el origen del "seed": copiamos el perfil activo acá para arrancar con
 * las sesiones ya iniciadas, sin tocar el dir real (Chrome 136+ bloquea el CDP sobre el
 * user-data-dir por defecto, por eso usamos una copia en un dir propio).
 * Override con TOOL_MEMORY_SEED_FROM. Devuelve undefined si no se encuentra.
 */
export function realChromeUserDataDir(): string | undefined {
  if (process.env.TOOL_MEMORY_SEED_FROM) return process.env.TOOL_MEMORY_SEED_FROM;
  const home = homedir();
  let candidates: string[] = [];
  if (process.platform === "darwin") {
    candidates = [
      join(home, "Library", "Application Support", "Google", "Chrome"),
      join(home, "Library", "Application Support", "Chromium"),
    ];
  } else if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    candidates = [
      join(local, "Google", "Chrome", "User Data"),
      join(local, "Chromium", "User Data"),
    ];
  } else {
    candidates = [
      join(home, ".config", "google-chrome"),
      join(home, ".config", "chromium"),
    ];
  }
  // Sirve si tiene CUALQUIER perfil dentro (Local State lista los perfiles reales).
  return candidates.find((root) => existsSync(join(root, "Local State")));
}

/**
 * Nombre del directorio de perfil a sembrar (ej. "Default", "Profile 2"). Auto-detecta
 * el MÁS usado leyendo `Local State` (`profile.last_used`), así un usuario con varios
 * perfiles arranca con el que realmente usa, sin configurar nada. Cae a "Default" si no
 * hay info. Override explícito con TOOL_MEMORY_PROFILE.
 */
export function resolveSeedProfile(srcRoot: string): string {
  const override = process.env.TOOL_MEMORY_PROFILE;
  if (override && existsSync(join(srcRoot, override))) return override;
  try {
    const localState = JSON.parse(
      readFileSync(join(srcRoot, "Local State"), "utf8"),
    ) as { profile?: { last_used?: string; last_active_profiles?: string[] } };
    const candidate =
      localState.profile?.last_used ??
      localState.profile?.last_active_profiles?.[0];
    if (candidate && existsSync(join(srcRoot, candidate))) return candidate;
  } catch {
    // Local State ausente/ilegible: caemos al Default.
  }
  return "Default";
}
