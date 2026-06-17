import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  cpSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { chromium } from "playwright";
import {
  cdpPort,
  cdpEndpoint,
  paths,
  resolveChromeBinary,
  realChromeUserDataDir,
  resolveSeedProfile,
  reseedEnabled,
} from "../config.js";

/**
 * Dueño del ciclo de vida del Chrome único compartido (spec §4).
 *
 * Lanza UNA instancia de Chrome con perfil dedicado persistente y un puerto de
 * remote-debugging. Tanto el runner de este server (vía connectOverCDP) como
 * @playwright/mcp (vía --cdp-endpoint) se atachan al MISMO Chrome, así ven el
 * mismo estado: pestañas, DOM y sesión.
 *
 * Arranque idempotente: si ya hay un Chrome escuchando en el puerto, lo reusa en
 * vez de relanzar (evita el lock del perfil).
 */

let child: ChildProcess | undefined;

/** Subdirectorios de caché que NO copiamos al sembrar (son la mayor parte del peso). */
const CACHE_DIRS = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GraphiteDawnCache",
  "Application Cache",
  "Media Cache",
  "CacheStorage",
  "ScriptCache",
  "Service Worker",
]);

/**
 * Siembra el perfil dedicado a partir del Chrome real del usuario — SOLO la primera
 * vez (si todavía no hay un Default). Copia las sesiones/cuentas (Cookies, Login Data,
 * Local Storage, etc.) salteando los cachés, y `Local State` para que el cifrado de
 * cookies sea coherente. Best-effort: si no hay perfil real, arrancamos vacío y el
 * usuario se loguea a mano una vez.
 */
function seedProfileIfEmpty(): void {
  const dstDefault = join(paths.chromeProfile, "Default");
  if (existsSync(dstDefault)) return; // ya sembrado / ya en uso: no tocar.

  const srcRoot = realChromeUserDataDir();
  if (!srcRoot) return; // sin Chrome real detectable: arranca vacío.
  const profile = resolveSeedProfile(srcRoot); // perfil más usado, no siempre "Default".
  const srcProfile = join(srcRoot, profile);
  if (!existsSync(srcProfile)) return;

  mkdirSync(paths.chromeProfile, { recursive: true });
  // El perfil elegido (ej. "Profile 2") se copia SIEMPRE al "Default" del dir dedicado,
  // que es el que Chrome usa al arrancar con --user-data-dir sin --profile-directory.
  cpSync(srcProfile, dstDefault, {
    recursive: true,
    filter: (src) => !CACHE_DIRS.has(basename(src)),
  });
  const localState = join(srcRoot, "Local State");
  if (existsSync(localState)) {
    cpSync(localState, join(paths.chromeProfile, "Local State"));
  }
  disableSessionRestore();
  process.stderr.write(
    `[tool-memory] Perfil "${profile}" sembrado desde ${srcRoot} (cuentas logueadas, sin cachés).\n`,
  );
}

/**
 * Bases de archivos SQLite de sesión/auth que refrescamos en cada re-seed. Por cada
 * base copiamos también sus sidecars (-wal, -shm, -journal): con el Chrome real ABIERTO
 * las cookies recién escritas viven en el -wal todavía sin volcar, así que copiar solo
 * el archivo principal daría una foto atrasada. Copiar los tres juntos preserva el estado.
 */
const AUTH_BASES = ["Cookies", "Login Data", "Web Data"];
const SQLITE_SIDECARS = ["", "-wal", "-shm", "-journal"];
const AUTH_FILES = AUTH_BASES.flatMap((b) => SQLITE_SIDECARS.map((s) => b + s));
/** Directorios de sesión/auth (cookies modernas viven en Network/). */
const AUTH_DIRS = ["Network", "Local Storage", "Session Storage"];

/**
 * Refresca SOLO los archivos de sesión/auth desde el Chrome real (no el perfil entero).
 * Pensado para correr en cada lanzamiento si reseedEnabled: arrastra logins nuevos
 * rápido y sin desgastar el disco. Best-effort: si no hay perfil sembrado todavía, lo
 * deja para seedProfileIfEmpty; si el Chrome real está abierto, copia el último estado
 * en disco (puede estar levemente atrás, pero no rompe).
 */
function reseedAuth(): void {
  const srcRoot = realChromeUserDataDir();
  if (!srcRoot) return;
  const profile = resolveSeedProfile(srcRoot); // mismo perfil que el seed inicial.
  const srcProfile = join(srcRoot, profile);
  const dstDefault = join(paths.chromeProfile, "Default");
  if (!existsSync(srcProfile) || !existsSync(dstDefault)) return;

  for (const f of AUTH_FILES) {
    const src = join(srcProfile, f);
    const dst = join(dstDefault, f);
    if (existsSync(src)) cpSync(src, dst);
    else rmSync(dst, { force: true }); // si el real ya no tiene el sidecar, no dejes el viejo
  }
  for (const d of AUTH_DIRS) {
    const src = join(srcProfile, d);
    if (!existsSync(src)) continue;
    const dst = join(dstDefault, d);
    rmSync(dst, { recursive: true, force: true }); // evita mezclar leveldb viejo/nuevo
    cpSync(src, dst, { recursive: true, filter: (p) => !CACHE_DIRS.has(basename(p)) });
  }
  const localState = join(srcRoot, "Local State");
  if (existsSync(localState)) {
    cpSync(localState, join(paths.chromeProfile, "Local State")); // coherencia de cifrado
  }
  disableSessionRestore();
  process.stderr.write(
    `[tool-memory] Auth re-sembrada (perfil "${profile}") desde ${srcRoot}.\n`,
  );
}

/**
 * Deja el perfil listo para arrancar SIN restaurar las pestañas viejas del usuario:
 * borra los archivos de sesión y fuerza "abrir nueva pestaña" + salida limpia en las
 * preferencias. Mantiene los datos (cookies/login); solo evita el ruido de tabs.
 */
function disableSessionRestore(): void {
  const def = join(paths.chromeProfile, "Default");
  for (const f of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
    rmSync(join(def, f), { force: true });
  }
  rmSync(join(def, "Sessions"), { recursive: true, force: true });

  const prefsPath = join(def, "Preferences");
  if (!existsSync(prefsPath)) return;
  try {
    const prefs = JSON.parse(readFileSync(prefsPath, "utf8")) as Record<string, any>;
    prefs.session = { ...(prefs.session ?? {}), restore_on_startup: 5 };
    delete prefs.session.startup_urls;
    prefs.profile = { ...(prefs.profile ?? {}), exit_type: "Normal", exited_cleanly: true };
    writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch {
    // Preferences ilegible: no es fatal, Chrome lo regenera.
  }
}

/** ¿Hay ya un Chrome escuchando el endpoint CDP? */
async function cdpAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${cdpEndpoint}/json/version`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Espera hasta que el endpoint CDP responda (o se agote el timeout). */
async function waitForCdp(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdpAlive()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Chrome no levantó el endpoint CDP en ${cdpEndpoint} tras ${timeoutMs}ms`,
  );
}

export interface SharedChrome {
  cdpEndpoint: string;
  /** true si ya estaba corriendo y lo reusamos (no lo matamos al cerrar). */
  reused: boolean;
}

export async function launchSharedChrome(): Promise<SharedChrome> {
  if (await cdpAlive()) {
    return { cdpEndpoint, reused: true };
  }

  // Primera vez: sembramos el perfil con las cuentas del Chrome real del usuario.
  seedProfileIfEmpty();
  // Cada lanzamiento (1 vez por sesión, lazy): refrescamos auth si está habilitado.
  if (reseedEnabled) reseedAuth();

  mkdirSync(paths.chromeProfile, { recursive: true });

  const bin = resolveChromeBinary();
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${paths.chromeProfile}`,
    "--no-first-run",
    "--no-default-browser-check",
    // Una pestaña inicial estable para atacharse.
    "about:blank",
  ];

  if (bin) {
    child = spawn(bin, args, { stdio: "ignore", detached: false });
  } else {
    // Sin Chrome del sistema: usamos el chromium de Playwright como binario.
    child = spawn(chromium.executablePath(), args, {
      stdio: "ignore",
      detached: false,
    });
  }

  child.on("exit", () => {
    child = undefined;
  });

  await waitForCdp();
  return { cdpEndpoint, reused: false };
}

/** Cierra el Chrome solo si lo lanzamos nosotros. */
export function stopSharedChrome(): void {
  if (child && !child.killed) {
    child.kill();
    child = undefined;
  }
}
