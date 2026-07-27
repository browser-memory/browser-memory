import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { join } from "node:path";
import { cdpEndpoint } from "../config.js";
import { launchSharedChrome } from "./chrome.js";

/**
 * Replay driver: it ATTACHES to the shared Chrome via CDP. It does not launch its own
 * browser process — it shares the one from chrome.ts. Replay is lightweight: just
 * navigate/click/type/evaluate with already-known selectors (no snapshot needed).
 */

let browser: Browser | undefined;

export interface ReplayHandle {
  browser: Browser;
  context: BrowserContext;
  /** A page ready to use (the first existing one, or a new one). */
  page: Page;
}

async function getBrowser(): Promise<Browser> {
  if (browser && browser.isConnected()) return browser;
  // Lazy: only here, when we actually go to use the browser, do we launch it
  // (idempotent: reuses if there's already a live CDP). So connecting the MCP doesn't open Chrome.
  await launchSharedChrome();
  browser = await chromium.connectOverCDP(cdpEndpoint);
  return browser;
}

/**
 * Returns a replay handle over the shared Chrome. Reuses the context and the first
 * existing tab to carry over the live state (session, etc.).
 */
export async function connectReplay(): Promise<ReplayHandle> {
  const b = await getBrowser();
  const context = b.contexts()[0] ?? (await b.newContext());
  const page = context.pages()[0] ?? (await context.newPage());
  return { browser: b, context, page };
}

/**
 * Returns the shared context (the default one of the dedicated Chrome). It's used by the
 * network recorder (netlog), the screenshot capture, and the exploration tools
 * (browser/explore.ts) to operate over the SAME tabs.
 */
export async function getSharedContext(): Promise<BrowserContext> {
  const b = await getBrowser();
  return b.contexts()[0] ?? (await b.newContext());
}

/**
 * Freezes a screenshot of the current state of each open tab into `dir` (best-effort).
 * Called at the moment of `request`: captures the final state of the successful flow "just
 * in case" (what the distiller can't reconstruct from the narration). It never fails the
 * request: if something goes wrong, it returns whatever it managed to take.
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
        /* unstable tab (navigating, etc.): we skip it */
      }
    }
  } catch {
    /* no browser connected: best-effort, we return empty */
  }
  return out;
}

/**
 * Each run uses a fresh tab and closes it when done (self-contained tools).
 * Exception: if `keepIf(result)` returns true, the tab is left open and brought to the
 * front — for MANUAL_CONFIRM flows where the tool prepares a write and a human must
 * review the final screen and confirm it by hand in the visible browser.
 */
export async function withFreshPage<T>(
  fn: (page: Page) => Promise<T>,
  keepIf?: (result: T) => boolean,
): Promise<T> {
  const b = await getBrowser();
  const context = b.contexts()[0] ?? (await b.newContext());
  const page = await context.newPage();
  let keep = false;
  try {
    const result = await fn(page);
    keep = keepIf ? keepIf(result) : false;
    if (keep) await page.bringToFront().catch(() => {});
    return result;
  } finally {
    if (!keep) await page.close().catch(() => {});
  }
}

export async function disconnectReplay(): Promise<void> {
  if (browser) {
    await browser.close().catch(() => {});
    browser = undefined;
  }
}
