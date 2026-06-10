import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import { cdpPort, cdpEndpoint, paths, resolveChromeBinary } from "../config.js";

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
