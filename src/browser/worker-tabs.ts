import type { Page } from "playwright";

/**
 * Registry of the REPLAY worker tabs: one live tab per origin, reused across runs.
 *
 * Why it exists (it replaces the old "one fresh tab per run, closed at the end"): a run
 * that closes its tab throws away the very thing the user wanted to see — the LinkedIn
 * profile it just opened, the cart it just filled. Here the tab SURVIVES the run and
 * stays where the tool left it, so the user can keep working on it by hand. The
 * isolation between runs is not lost: it moves from closing on EXIT to cleaning on
 * ENTRY (every recipe starts by navigating, which is a real reset — see connect.ts).
 *
 * One tab PER ORIGIN so a run against one site doesn't clobber the tab another site's
 * run left open. The Map is insertion-ordered and we re-insert on every touch, so its
 * first entry is always the least recently used (LRU eviction).
 *
 * This module deliberately imports nothing local: connect.ts (creates/evicts tabs),
 * explore.ts (must NOT adopt a worker tab as its exploration page) and the screenshot
 * capture all read it, and going through a leaf module keeps those three from importing
 * each other.
 */

/** Past this we evict the least recently used tab: N origins open forever costs RAM. */
export const MAX_WORKER_TABS = 6;

/** Key for tools whose origin we couldn't determine: they share one generic tab. */
export const UNKNOWN_ORIGIN = "*";

type Tagged = Page & { __bmWorkerOrigin?: string };

/** origin → live tab. Insertion order is LRU order (least recent first). */
const tabs = new Map<string, Page>();

/** "https://x.com/a?b=1" → "https://x.com". Undefined if it isn't a usable URL. */
export function originOf(url: string | undefined | null): string | undefined {
  if (!url) return undefined;
  try {
    const { origin } = new URL(url);
    // about:blank and friends parse fine but their origin is "null" — not a real site.
    return origin && origin !== "null" ? origin : undefined;
  } catch {
    return undefined;
  }
}

/** True for a replay worker tab: exploration must leave these alone. */
export function isWorkerPage(page: Page): boolean {
  return typeof (page as Tagged).__bmWorkerOrigin === "string";
}

function alive(page: Page | undefined): page is Page {
  return Boolean(page && !page.isClosed());
}

/** The live tab for `origin` (touched as most-recently-used), or undefined. */
export function getWorkerTab(origin: string): Page | undefined {
  const page = tabs.get(origin);
  if (!alive(page)) {
    tabs.delete(origin);
    return undefined;
  }
  tabs.delete(origin);
  tabs.set(origin, page);
  return page;
}

/** Registers `page` as the worker tab for `origin` and marks it most-recently-used. */
export function setWorkerTab(origin: string, page: Page): void {
  (page as Tagged).__bmWorkerOrigin = origin;
  tabs.delete(origin);
  tabs.set(origin, page);
}

/**
 * Drops and returns the tabs above MAX_WORKER_TABS, least recently used first. The
 * caller closes them — this module never touches the browser. The tab just used is the
 * most recent one, so it is never in the returned list.
 */
export function evictExcess(): Page[] {
  for (const [origin, page] of [...tabs]) if (!alive(page)) tabs.delete(origin);
  const evicted: Page[] = [];
  while (tabs.size > MAX_WORKER_TABS) {
    const oldest = tabs.keys().next();
    if (oldest.done) break;
    const page = tabs.get(oldest.value);
    tabs.delete(oldest.value);
    if (alive(page)) evicted.push(page);
  }
  return evicted;
}

/** Live worker tabs, MOST recently used first. */
export function workerTabs(): Page[] {
  return [...tabs.values()].filter(alive).reverse();
}

/** Forgets every tab (does not close them). For shutdown and for tests. */
export function resetWorkerTabs(): void {
  tabs.clear();
}
