import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const {
  MAX_WORKER_TABS,
  evictExcess,
  getWorkerTab,
  isWorkerPage,
  originOf,
  resetWorkerTabs,
  setWorkerTab,
  workerTabs,
} = await import("../src/browser/worker-tabs.ts");

/** The registry only ever asks a page whether it is closed, so this is enough. */
function fakePage(closed = false) {
  return { isClosed: () => closed } as never;
}

beforeEach(() => resetWorkerTabs());

test("originOf strips path and query", () => {
  assert.equal(originOf("https://x.com/a/b?c=1#d"), "https://x.com");
  assert.equal(originOf("https://x.com:8443/a"), "https://x.com:8443");
});

test("originOf returns undefined for what isn't a real site", () => {
  assert.equal(originOf(undefined), undefined);
  assert.equal(originOf(""), undefined);
  assert.equal(originOf("not a url"), undefined);
  // about:blank parses, but its origin is not a site we can key a tab on.
  assert.equal(originOf("about:blank"), undefined);
});

test("a registered page is a worker page and comes back by origin", () => {
  const page = fakePage();
  assert.equal(isWorkerPage(page), false);
  setWorkerTab("https://x.com", page);
  assert.equal(isWorkerPage(page), true);
  assert.equal(getWorkerTab("https://x.com"), page);
  assert.equal(getWorkerTab("https://other.com"), undefined);
});

test("tabs of different origins do not clobber each other", () => {
  const linkedin = fakePage();
  const walmart = fakePage();
  setWorkerTab("https://linkedin.com", linkedin);
  setWorkerTab("https://walmart.com", walmart);
  assert.equal(getWorkerTab("https://linkedin.com"), linkedin);
  assert.equal(getWorkerTab("https://walmart.com"), walmart);
});

test("a closed tab is forgotten instead of handed back", () => {
  setWorkerTab("https://x.com", fakePage(true));
  assert.equal(getWorkerTab("https://x.com"), undefined);
  assert.deepEqual(workerTabs(), []);
});

test("eviction drops the least recently used and never the newest", () => {
  const pages = Array.from({ length: MAX_WORKER_TABS + 2 }, () => fakePage());
  pages.forEach((p, i) => setWorkerTab(`https://s${i}.com`, p));

  const evicted = evictExcess();
  assert.deepEqual(evicted, [pages[0], pages[1]], "the two oldest go");
  assert.equal(workerTabs().length, MAX_WORKER_TABS);
  assert.equal(getWorkerTab("https://s0.com"), undefined);
  assert.equal(workerTabs()[0], pages.at(-1), "most recently used first");
});

test("reusing an origin makes it recent again, so it survives eviction", () => {
  const pages = Array.from({ length: MAX_WORKER_TABS }, () => fakePage());
  pages.forEach((p, i) => setWorkerTab(`https://s${i}.com`, p));

  getWorkerTab("https://s0.com"); // touch the oldest
  setWorkerTab("https://new.com", fakePage());

  const evicted = evictExcess();
  assert.deepEqual(evicted, [pages[1]], "s1 is now the oldest, not s0");
  assert.equal(getWorkerTab("https://s0.com"), pages[0]);
});

test("nothing is evicted while under the cap", () => {
  setWorkerTab("https://x.com", fakePage());
  assert.deepEqual(evictExcess(), []);
});
