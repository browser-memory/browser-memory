import type { BrowserContext, Page, Dialog } from "playwright";
import { launchSharedChrome } from "./chrome.js";
import { getSharedContext } from "./connect.js";
import { isWorkerPage } from "./worker-tabs.js";
import { startNetLog } from "./netlog.js";
import { attachConsoleToPage } from "./console-log.js";
import { buildCandidates, type ElementSig } from "./selector.js";

/**
 * EXPLORATION driver over the shared Chrome. Replaces what the external @playwright/mcp MCP
 * used to do: navigate, take the accessibility snapshot (with refs), click, type, etc., so
 * the agent learns a NEW web action. All with the `playwright` library the project already
 * uses — a single MCP, zero extra config.
 *
 * Exploration keeps a persistent **active page**: the SAME one the user sees, to carry over
 * the live state (session, in-progress navigation, tabs that open). The model drives it
 * sequentially (MCP stdio), so there is no real concurrency on that page. The replay runner
 * also keeps its tabs open now ([browser/worker-tabs.ts], one per origin), so the two share
 * a context but never a tab: `getActivePage` below refuses to adopt a worker tab.
 *
 * The snapshot uses `page.ariaSnapshot({ mode: "ai" })` (public playwright API ≥1.53): it
 * returns the a11y tree with `[ref=eN]` refs —including iframes— and those refs are resolved
 * with the `aria-ref=eN` selector engine. The refs are EPHEMERAL (invalidated when the DOM
 * mutates): that's why each action re-snapshots and returns the fresh snapshot, and also
 * resolves the node to a **stable CSS selector** ([browser/selector.ts]) which is what the
 * agent should put in the narration (the lint rejects refs).
 */

const ACTION_TIMEOUT = 15_000;
const SNAPSHOT_TIMEOUT = 10_000;

let activePage: Page | undefined;
let ctxWired = false;
/** Policy for dialogs (alert/confirm/prompt/beforeunload). Default: accept, to avoid hanging. */
let dialogPolicy: "accept" | "dismiss" = "accept";
let dialogPromptText: string | undefined;
let lastDialog: { type: string; message: string } | undefined;

/** Common result of the actions: fresh state so the agent decides the next step. */
export interface ExploreState {
  url: string;
  title: string;
  snapshot: string;
}

/**
 * Normalizes whatever the agent passes as a ref ("e5", "ref=e5", "[ref=e5]") to the `eN`
 * token. Anchored on purpose: it does NOT reinterpret substrings like 'frame5' or 'theme5'
 * as 'e5' (that would point to the wrong node). If it isn't a complete ref, it returns the
 * input as-is and we let `aria-ref=...` fail visibly instead of resolving something wrong.
 */
export function normalizeRef(ref: string): string {
  const m = /^\[?(?:ref=)?(e\d+)\]?$/.exec(ref.trim());
  return m ? m[1] : ref.trim();
}

function wirePage(page: Page): void {
  attachConsoleToPage(page);
  const p = page as Page & { __bmDialogWired?: boolean };
  if (p.__bmDialogWired) return;
  p.__bmDialogWired = true;
  page.on("dialog", (d: Dialog) => {
    lastDialog = { type: d.type(), message: d.message() };
    const act =
      dialogPolicy === "accept" ? d.accept(dialogPromptText).catch(() => {}) : d.dismiss().catch(() => {});
    void act;
  });
}

/**
 * Guarantees a live Chrome + started network recording + wired context, and returns the
 * active exploration page. Idempotent: it can be called on each tool. If there's no active
 * page yet (or it was closed), it takes the first open one (the `about:blank` chrome.ts
 * leaves) or creates a new one — reusing the shared context to carry over the session.
 */
export async function getActivePage(): Promise<Page> {
  await launchSharedChrome();
  await startNetLog();
  const ctx: BrowserContext = await getSharedContext();

  if (!ctxWired) {
    ctxWired = true;
    // New tabs (popups, target=_blank) become the active one and get wired.
    ctx.on("page", (p) => {
      activePage = p;
      wirePage(p);
    });
    for (const p of ctx.pages()) wirePage(p);
  }

  // Replay worker tabs live in this same context and now STAY OPEN after a run
  // (browser/worker-tabs.ts), and the `page` event above makes any new tab the active
  // one — including theirs. Re-validating here instead of filtering the event keeps this
  // race-free: the tab is tagged as a worker right after it is created, which is always
  // before the agent calls an exploration tool. Exploration must never adopt one, or a
  // bm_navigate would hijack the tab a previous run left for the user.
  if (!activePage || activePage.isClosed() || isWorkerPage(activePage)) {
    activePage =
      ctx.pages().find((p) => !p.isClosed() && !isWorkerPage(p)) ?? (await ctx.newPage());
    wirePage(activePage);
  }
  return activePage;
}

/** a11y snapshot (mode "ai", with refs) + url/title of the active page. */
export async function snapshot(): Promise<ExploreState> {
  const page = await getActivePage();
  const snap = await page.ariaSnapshot({ mode: "ai", timeout: SNAPSHOT_TIMEOUT } as Parameters<Page["ariaSnapshot"]>[0]);
  return { url: page.url(), title: await page.title().catch(() => ""), snapshot: snap };
}

export async function navigate(url: string): Promise<ExploreState> {
  const page = await getActivePage();
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT });
  return snapshot();
}

export async function navigateBack(): Promise<ExploreState> {
  const page = await getActivePage();
  await page.goBack({ waitUntil: "domcontentloaded", timeout: ACTION_TIMEOUT }).catch(() => {});
  return snapshot();
}

/**
 * Resolves a `ref` from the last snapshot to a stable CSS selector. Reads the element's
 * signature on the page, builds the candidates ([browser/selector.ts]) and keeps the first
 * that matches EXACTLY one node; if none is unique, it falls back to a structural path
 * (nth-of-type). Returns null if the ref no longer resolves (best-effort: the action may have
 * worked anyway).
 */
export async function resolveCssForRef(ref: string): Promise<string | null> {
  const page = await getActivePage();
  const loc = page.locator(`aria-ref=${normalizeRef(ref)}`);
  let sig: ElementSig;
  try {
    sig = (await loc.evaluate((el: Element) => {
      const e = el as HTMLElement;
      const testId =
        e.getAttribute("data-testid") ||
        e.getAttribute("data-test-id") ||
        e.getAttribute("data-test") ||
        e.getAttribute("data-qa") ||
        undefined;
      return {
        tag: e.tagName.toLowerCase(),
        id: e.id || undefined,
        name: e.getAttribute("name") || undefined,
        ariaLabel: e.getAttribute("aria-label") || undefined,
        testId: testId || undefined,
        role: e.getAttribute("role") || undefined,
        type: e.getAttribute("type") || undefined,
        placeholder: e.getAttribute("placeholder") || undefined,
        classes: Array.from(e.classList),
      };
    })) as ElementSig;
  } catch {
    return null;
  }

  const candidates = buildCandidates(sig);
  if (candidates.length) {
    const unique = await page.evaluate((cands: string[]) => {
      for (const c of cands) {
        try {
          if (document.querySelectorAll(c).length === 1) return c;
        } catch {
          /* invalid selector in this DOM: we try the next one */
        }
      }
      return null;
    }, candidates);
    if (unique) return unique;
  }

  // Fallback: short structural path from the nearest ancestor with an id.
  // NOTE: this runs in the page, serialized by Playwright. Keep it free of NAMED function
  // declarations and function-valued `const`s: esbuild (tsx, dev/test) wraps those with a
  // `__name` helper that doesn't exist in the page → "ReferenceError: __name is not defined".
  // Only anonymous inline arrows passed directly as args are safe.
  try {
    return await loc.evaluate((el: Element) => {
      const parts: string[] = [];
      let e: Element | null = el;
      while (e && e.nodeType === 1 && parts.length < 8) {
        if (e.id) {
          const css = (window as { CSS?: { escape?: (v: string) => string } }).CSS;
          const id = css?.escape ? css.escape(e.id) : e.id.replace(/([^a-zA-Z0-9_-])/g, "\\$1");
          parts.unshift(`#${id}`);
          break;
        }
        const tag = e.tagName.toLowerCase();
        const parent: Element | null = e.parentElement;
        if (!parent) {
          parts.unshift(tag);
          break;
        }
        const sibs = Array.from(parent.children).filter((c) => c.tagName === e!.tagName);
        parts.unshift(sibs.length <= 1 ? tag : `${tag}:nth-of-type(${sibs.indexOf(e) + 1})`);
        e = parent;
      }
      return parts.join(" > ");
    });
  } catch {
    return null;
  }
}

/** Result of an action: fresh state + the resolved CSS selector (for the narration). */
export interface ActionResult extends ExploreState {
  cssSelector: string | null;
}

export async function clickRef(ref: string): Promise<ActionResult> {
  const page = await getActivePage();
  // We resolve the CSS BEFORE clicking: afterwards the DOM may mutate and the ref is invalidated.
  const cssSelector = await resolveCssForRef(ref);
  await page.locator(`aria-ref=${normalizeRef(ref)}`).click({ timeout: ACTION_TIMEOUT });
  await page.waitForLoadState("domcontentloaded", { timeout: ACTION_TIMEOUT }).catch(() => {});
  return { cssSelector, ...(await snapshot()) };
}

export async function typeRef(ref: string, text: string, submit?: boolean): Promise<ActionResult> {
  const page = await getActivePage();
  const cssSelector = await resolveCssForRef(ref);
  const loc = page.locator(`aria-ref=${normalizeRef(ref)}`);
  await loc.fill(text, { timeout: ACTION_TIMEOUT });
  if (submit) {
    await loc.press("Enter", { timeout: ACTION_TIMEOUT });
    await page.waitForLoadState("domcontentloaded", { timeout: ACTION_TIMEOUT }).catch(() => {});
  }
  return { cssSelector, ...(await snapshot()) };
}

export async function pressKey(key: string, ref?: string): Promise<ExploreState> {
  const page = await getActivePage();
  if (ref) await page.locator(`aria-ref=${normalizeRef(ref)}`).press(key, { timeout: ACTION_TIMEOUT });
  else await page.keyboard.press(key);
  await page.waitForLoadState("domcontentloaded", { timeout: ACTION_TIMEOUT }).catch(() => {});
  return snapshot();
}

export async function selectOption(ref: string, values: string[]): Promise<ActionResult> {
  const page = await getActivePage();
  const cssSelector = await resolveCssForRef(ref);
  await page.locator(`aria-ref=${normalizeRef(ref)}`).selectOption(values, { timeout: ACTION_TIMEOUT });
  return { cssSelector, ...(await snapshot()) };
}

export async function fileUpload(ref: string, paths: string[]): Promise<{ ok: true; cssSelector: string | null }> {
  const page = await getActivePage();
  const cssSelector = await resolveCssForRef(ref);
  await page.locator(`aria-ref=${normalizeRef(ref)}`).setInputFiles(paths, { timeout: ACTION_TIMEOUT });
  return { ok: true, cssSelector };
}

/**
 * Best-effort wait: for text present, text gone, or a fixed time. A timeout is NOT an error
 * (just like the runner's `wait_for`): we return the current state anyway.
 */
export async function waitFor(opts: { text?: string; textGone?: string; time?: number }): Promise<ExploreState> {
  const page = await getActivePage();
  if (typeof opts.time === "number") {
    await page.waitForTimeout(Math.min(opts.time * 1000, 30_000));
  }
  if (opts.text) {
    await page.getByText(opts.text).first().waitFor({ state: "visible", timeout: ACTION_TIMEOUT }).catch(() => {});
  }
  if (opts.textGone) {
    await page.getByText(opts.textGone).first().waitFor({ state: "hidden", timeout: ACTION_TIMEOUT }).catch(() => {});
  }
  return snapshot();
}

/** Configures dialog handling for the NEXT ones (default: accept). Reports the last one seen. */
export function handleDialog(accept: boolean, text?: string): { ok: true; policy: string; last?: { type: string; message: string } } {
  dialogPolicy = accept ? "accept" : "dismiss";
  dialogPromptText = text;
  return { ok: true, policy: dialogPolicy, last: lastDialog };
}

export interface TabInfo {
  index: number;
  url: string;
  title: string;
  active: boolean;
}

export async function tabs(
  action: "list" | "select" | "close",
  index?: number,
): Promise<{ tabs: TabInfo[] } | { ok: true }> {
  const ctx = await getSharedContext();
  const pages = ctx.pages();
  if (action === "list") {
    const out: TabInfo[] = [];
    for (let i = 0; i < pages.length; i += 1) {
      const p = pages[i];
      out.push({
        index: i,
        url: p.url(),
        title: await p.title().catch(() => ""),
        active: p === activePage,
      });
    }
    return { tabs: out };
  }
  if (index == null || index < 0 || index >= pages.length) {
    throw new Error(`tab index out of range: ${index}`);
  }
  if (action === "select") {
    // Set the active page WITHOUT bringToFront: exploration drives the tab over CDP no
    // matter which one is visually frontmost, and raising it would pull the background
    // Chrome window to the foreground (we keep it in the background, see chrome.ts).
    activePage = pages[index];
    wirePage(activePage);
    return { ok: true };
  }
  // close
  const target = pages[index];
  await target.close().catch(() => {});
  if (target === activePage) activePage = ctx.pages().find((p) => !p.isClosed());
  return { ok: true };
}

/** Screenshot of the active page (best-effort). Returns the path or null. */
export async function screenshotActive(path: string): Promise<string | null> {
  try {
    const page = await getActivePage();
    await page.screenshot({ path });
    return path;
  } catch {
    return null;
  }
}
