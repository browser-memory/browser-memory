import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { join } from "node:path";
import { cdpEndpoint } from "../config.js";
import { launchSharedChrome } from "./chrome.js";
import {
  UNKNOWN_ORIGIN,
  evictExcess,
  getWorkerTab,
  isWorkerPage,
  pinWorkerTab,
  resetWorkerTabs,
  setWorkerTab,
  unpinWorkerTab,
  workerTabs,
} from "./worker-tabs.js";
import { acquireOrigin } from "./origin-lock.js";

/**
 * Replay driver: it ATTACHES to the shared Chrome via CDP. It does not launch its own
 * browser process — it shares the one from chrome.ts. Replay is lightweight: just
 * navigate/click/type/evaluate with already-known selectors (no snapshot needed).
 */

let browser: Browser | undefined;

/**
 * Hooks that run right after the shared Chrome comes up, whoever launched it (a `run`,
 * an exploration tool, a `request`). The network recorder registers itself here so it
 * starts recording as soon as there IS a browser, instead of forcing a launch of its own
 * from a tool that doesn't need one (`discover` used to pre-launch just for this).
 * Fired after `browser` is set, so a hook calling back in gets the cached instance.
 */
type ReadyHook = () => void | Promise<void>;
const readyHooks: ReadyHook[] = [];

export function onBrowserReady(hook: ReadyHook): void {
  readyHooks.push(hook);
}

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
  for (const hook of readyHooks) {
    try {
      await hook();
    } catch {
      /* best-effort: a hook must never break the connection */
    }
  }
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
    const live = ctx.pages().filter((p) => !p.isClosed());
    // `request` is called while LEARNING, so what matters is the exploration tabs — the
    // ones the human was driving. Replay worker tabs stay open now (they are not closed
    // after each run), so without this they would push the relevant tabs past the cap
    // below and we would freeze screenshots of a stale run instead of the flow we are
    // about to distill. Exploration tabs first, then worker tabs most-recent first.
    const pages = [
      ...live.filter((p) => !isWorkerPage(p)),
      ...workerTabs().filter((p) => live.includes(p)),
    ];
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
 * Runs `fn` on the worker tab of `origin` and LEAVES IT OPEN when done.
 *
 * The tab is reused by every later run against the same origin and survives this one,
 * so the user is left looking at whatever the tool produced (the profile it opened, the
 * cart it filled) and can keep going by hand. Runs against other origins get their own
 * tab and do not clobber it.
 *
 * Isolation did not disappear, it moved to the entry: `reset` blanks the tab before
 * running. Callers pass `reset: false` when the recipe starts by navigating (a `goto`
 * tears down the previous document by itself, so blanking first would just cost a
 * round-trip) and `reset: true` when it does not, so a recipe that starts by clicking
 * can never act on whatever the previous run left on screen.
 *
 * `focus` decides — from the result — whether to bring the tab to the front. It is off
 * by default and on purpose: keeping the tab is for everyone, stealing the foreground
 * is only for flows where a human has to look at the screen right now (MANUAL_CONFIRM).
 *
 * CONCURRENCY (origin-lock.ts): runs against the same origin share one tab, so they
 * synchronize through a per-origin RW lock.
 *   - Default (exclusive): `reset` and `fn` run under the exclusive grade — one run at
 *     a time per origin. For recipes that navigate or drive the DOM (playwright):
 *     measured without this, parallel calls killed each other's goto with
 *     net::ERR_ABORTED.
 *   - `shared: true` (fetch-replay): `fn` runs under the shared grade, so N evaluates
 *     against a warm tab proceed at once. `needsPrepare` is consulted under that shared
 *     grade; only when it says the tab isn't ready (cold tab → warm-up goto pending)
 *     does the run trade its shared slot for the exclusive grade, run `prepare`, and
 *     DOWNGRADE back — so the goto never races, and the warm path never waits on an
 *     exclusive grant (an early version did, and it serialized every parallel read
 *     behind the previous run's evaluate).
 * Tab creation is memoized per origin (concurrent cold runs share one newPage), and the
 * tab is pinned for the whole span so LRU eviction never closes it mid-run.
 */
const pendingTabs = new Map<string, Promise<Page>>();

async function acquireTab(key: string, context: BrowserContext): Promise<Page> {
  const existing = getWorkerTab(key);
  if (existing) return existing;
  let pending = pendingTabs.get(key);
  if (!pending) {
    pending = context
      .newPage()
      .then((page) => {
        setWorkerTab(key, page);
        return page;
      })
      .finally(() => pendingTabs.delete(key));
    pendingTabs.set(key, pending);
  }
  return pending;
}

export async function withOriginPage<T>(
  origin: string | undefined,
  fn: (page: Page) => Promise<T>,
  opts: {
    reset?: boolean;
    focus?: (result: T) => boolean;
    /** Run `fn` under the shared grade (fetch-replay evaluates). Default exclusive. */
    shared?: boolean;
    /** Under `shared`: does the tab still need `prepare`? Checked cheaply, no await. */
    needsPrepare?: (page: Page) => boolean;
    /** Warm-up that must not race (cold-tab goto). Runs under the exclusive grade. */
    prepare?: (page: Page) => Promise<void>;
  } = {},
): Promise<T> {
  const b = await getBrowser();
  const context = b.contexts()[0] ?? (await b.newContext());
  const key = origin ?? UNKNOWN_ORIGIN;

  const page = await acquireTab(key, context);
  pinWorkerTab(page);
  try {
    // Register as most-recently-used before evicting: this tab is never the victim.
    setWorkerTab(key, page);
    for (const stale of evictExcess()) await stale.close().catch(() => {});

    let hold = await acquireOrigin(key, !opts.shared);
    try {
      if (opts.shared && opts.prepare && (opts.needsPrepare?.(page) ?? true)) {
        // Cold tab: trade the shared slot for the exclusive grade. Never upgrade in
        // place (two holders upgrading would deadlock): release, re-acquire, re-check.
        hold.release();
        hold = await acquireOrigin(key, true);
        if (opts.needsPrepare?.(page) ?? true) await opts.prepare(page);
        hold.downgrade(); // back to shared for fn, with no gap for another goto
      } else if (!opts.shared) {
        if (opts.reset) await page.goto("about:blank").catch(() => {});
        await opts.prepare?.(page);
      }

      const result = await fn(page);
      if (opts.focus?.(result)) await page.bringToFront().catch(() => {});
      return result;
    } finally {
      hold.release();
    }
  } finally {
    unpinWorkerTab(page);
  }
}

export async function disconnectReplay(): Promise<void> {
  resetWorkerTabs();
  if (browser) {
    await browser.close().catch(() => {});
    browser = undefined;
  }
}
