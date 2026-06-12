import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { join } from "node:path";
import { cdpEndpoint } from "../config.js";
import { launchSharedChrome } from "./chrome.js";

/**
 * Driver de replay: se ATACHA al Chrome compartido vía CDP. No lanza un proceso
 * de navegador propio — comparte el de chrome.ts. El replay es liviano: solo
 * navigate/click/type/evaluate con selectores ya conocidos (no necesita snapshot).
 */

let browser: Browser | undefined;

export interface ReplayHandle {
  browser: Browser;
  context: BrowserContext;
  /** Una page lista para usar (la primera existente, o una nueva). */
  page: Page;
}

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  // Lazy: recién acá, cuando de verdad vamos a usar el navegador, lo levantamos
  // (idempotente: reusa si ya hay un CDP vivo). Así conectar el MCP no abre Chrome.
  await launchSharedChrome();
  browser = await chromium.connectOverCDP(cdpEndpoint);
  return browser;
}

/**
 * Devuelve un handle de replay sobre el Chrome compartido. Reusa el contexto y la
 * primera pestaña existente para arrastrar el estado vivo (sesión, etc.).
 */
export async function connectReplay(): Promise<ReplayHandle> {
  const b = await getBrowser();
  const context = b.contexts()[0] ?? (await b.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser: b, context, page };
}

/**
 * Devuelve el contexto compartido (el default del Chrome único). Lo usan el grabador
 * de red (netlog) y la captura de screenshots para observar lo que hace playwright-mcp
 * sobre las MISMAS pestañas.
 */
export async function getSharedContext(): Promise<BrowserContext> {
  const b = await getBrowser();
  return b.contexts()[0] ?? (await b.newContext());
}

/**
 * Congela un screenshot del estado actual de cada pestaña abierta en `dir` (best-effort).
 * Se llama al momento de `request`: captura el estado final del flujo exitoso "por las
 * dudas" (lo que el distiller no puede reconstruir desde la narración). Nunca falla el
 * request: si algo sale mal, devuelve lo que haya podido sacar.
 */
export async function captureScreenshotsInto(dir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const ctx = await getSharedContext();
    const pages = ctx.pages().filter((p) => !p.isClosed());
    let i = 0;
    for (const p of pages.slice(0, 5)) {
      i += 1;
      const file = join(dir, `page-${i}.png`);
      try {
        await p.screenshot({ path: file });
        out.push(file);
      } catch {
        /* pestaña inestable (navegando, etc.): la salteamos */
      }
    }
  } catch {
    /* sin browser conectado: best-effort, devolvemos vacío */
  }
  return out;
}

/** Cada run usa una pestaña fresca y la cierra al terminar (tools self-contained). */
export async function withFreshPage<T>(fn: (page: Page) => Promise<T>): Promise<T> {
  const b = await getBrowser();
  const context = b.contexts()[0] ?? (await b.newContext());
  const page = await context.newPage();
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

export async function disconnectReplay(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = undefined;
  }
}
