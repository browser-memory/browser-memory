import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { cdpEndpoint } from "../config.js";

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
