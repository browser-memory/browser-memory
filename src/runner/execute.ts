import type { Page } from "playwright";
import { withOriginPage } from "../browser/connect.js";
import { originOf } from "../browser/worker-tabs.js";
import { saveItem } from "../memory/store.js";
import { isComposite } from "../schema/tool.js";
import { resolveItem, isRemoteSource } from "../registry/resolve.js";
import { runHttpFn } from "./http-fn.js";
import type {
  Tool,
  MemoryItem,
  PlaywrightStep,
  SuccessAssertion,
  ResultExtractor,
} from "../schema/tool.js";

/**
 * Runner (spec §5.2 / §8): runs a tool deterministically and returns DATA.
 * No model in the loop. Verifies environment preconditions on entry and the
 * success_assertion on exit; classifies failures into three modes with their remedy.
 */

export type FailMode = "re-auth" | "not-applicable" | "tool-broken";

export interface RunResult {
  ok: boolean;
  result?: unknown;
  /**
   * `retryable` marks a failure the USER can clear without any change to the tool —
   * today only `re-auth`: the tab was left open on the login screen and brought to the
   * front, so once the human logs in the very same call works. It tells the agent to
   * ask and retry instead of reporting a dead end or re-learning a healthy tool.
   */
  error?: { mode: FailMode; message: string; retryable?: boolean };
  /** Where the tool was resolved from (for logging). */
  source?: "local" | "remote";
  /** Version of the resolved item, for the `ver` column of the run log. */
  version?: number;
}

const DEFAULT_TIMEOUT = 15000;
/** Shorter wait for wait_for: it's best-effort, blocking 15s in vain is not worth it. */
const WAIT_FOR_TIMEOUT = 6000;
/**
 * Default retry window for the success_assertion (dom/text). The confirmer
 * of an action is often asynchronous or transient (a toast that appears after a
 * network submit and goes away within seconds); a single synchronous check loses it
 * to a race. If the assertion already holds, the poll returns on the first attempt (it
 * adds no latency to reads); only the failing path waits until the window is exhausted.
 */
const DEFAULT_ASSERT_WINDOW = 4000;
const ASSERT_POLL_INTERVAL = 300;

/**
 * Transformation filters applicable to a placeholder: {{q|kebab}}.
 * They cover the transformations a distiller usually wants to express (and which it
 * previously described in prose, without anyone executing them). Keep this list in sync
 * with the linter's (lint.ts).
 */
export const FILTERS: Record<string, (s: string) => string> = {
  kebab: (s) => s.trim().toLowerCase().replace(/\s+/g, "-"),
  lower: (s) => s.toLowerCase(),
  upper: (s) => s.toUpperCase(),
  encode: (s) => encodeURIComponent(s),
};

/**
 * Substitutes {{param}} (and {{param|filter}}) in a string with the provided values.
 * Literal replacement + declared filters; does NOT eval arbitrary code.
 */
export function injectParams(
  template: string,
  params: Record<string, unknown>,
): string {
  return template.replace(
    /\{\{\s*([\w.]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g,
    (_, key: string, filter?: string) => {
      const v = params[key];
      if (v === undefined) {
        throw new Error(`Missing required parameter: ${key}`);
      }
      let s = String(v);
      if (filter) {
        const fn = FILTERS[filter];
        if (!fn) throw new Error(`Unknown filter in {{${key}|${filter}}}`);
        s = fn(s);
      }
      return s;
    },
  );
}

/** Heuristic: is this URL/page a login? (environment precondition by effect). */
function looksLikeLogin(url: string): boolean {
  return /\/(login|signin|sign-in|auth|sso)(\b|\/|\?)/i.test(url);
}

// --- session-failure upgrade -------------------------------------------------------

/** Matches the way distillers describe a session precondition in `requires.env`. */
const SESSION_ENV_RE = /session|log[- ]?in|logged|auth|signed[- ]?in/i;

/** Does the tool declare a logged-in session as an environment precondition? */
export function requiresSession(tool: Tool): boolean {
  return Object.entries(tool.requires.env ?? {}).some(
    ([key, desc]) => SESSION_ENV_RE.test(key) || SESSION_ENV_RE.test(desc),
  );
}

/** "https://www.x.com" → "x.com": ignore scheme + a leading www when comparing sites. */
function hostKey(origin: string | undefined): string | undefined {
  if (!origin) return undefined;
  try {
    return new URL(origin).hostname.replace(/^www\./i, "").toLowerCase();
  } catch {
    return undefined;
  }
}

/**
 * Environment signal that a SESSION failure hid behind a generic error: the tool
 * declares a session precondition and the page did not stay where the recipe pointed
 * it — it sits on a login URL, or it was bounced to a DIFFERENT site (Coto's pattern:
 * logged out, cotodigital.com.ar redirects to coto.com.ar and the extractor's
 * same-site fetch dies cross-origin as a bare "Failed to fetch"). It only inspects
 * declared metadata + URLs, so a tool without a session requirement is never touched.
 */
export function looksLikeSessionRedirect(
  tool: Tool,
  params: Record<string, unknown>,
  pageUrl: string,
): boolean {
  if (!requiresSession(tool)) return false;
  if (looksLikeLogin(pageUrl)) return true;
  const wanted = hostKey(toolOrigin(tool, params));
  const landed = hostKey(originOf(pageUrl));
  return Boolean(wanted && landed && wanted !== landed);
}

/**
 * Upgrades a failure to `re-auth` when the environment says the session is the real
 * culprit. tool-broken (and raw Playwright/extractor errors) are the runner BLAMING
 * THE TOOL; if the page shows a session redirect that blame is wrong — the tool never
 * got to run against the page it was written for — and calling it broken sends the
 * agent to re-learn a healthy tool and inflates fail_count. `not-applicable` and
 * genuine `re-auth` pass through untouched: they already blame the environment.
 */
function upgradeSessionFailure(
  tool: Tool,
  params: Record<string, unknown>,
  page: Page,
  e: unknown,
): unknown {
  if (e instanceof TypedFail && e.mode !== "tool-broken") return e;
  let url = "";
  try {
    url = page.url();
  } catch {
    return e; // page gone: no environment to read, keep the original blame
  }
  if (!looksLikeSessionRedirect(tool, params, url)) return e;
  const cause = e instanceof Error ? e.message : String(e);
  return new TypedFail(
    "re-auth",
    `session required: this tool needs a logged-in session and the site sent the tab ` +
      `to ${url} instead of ${toolOrigin(tool, params)} (typical logged-out redirect). ` +
      `Underlying error: ${cause}`,
  );
}

// --- recipe execution ------------------------------------------------------------

async function runPlaywrightStep(
  page: Page,
  step: PlaywrightStep,
  params: Record<string, unknown>,
): Promise<void> {
  const timeout = step.timeoutMs ?? DEFAULT_TIMEOUT;
  switch (step.action) {
    case "navigate":
      await page.goto(injectParams(step.url!, params), {
        waitUntil: "domcontentloaded",
        timeout,
      });
      return;
    case "assert_precondition": {
      // Environment precondition: the expected selector/expr must exist. If the
      // page redirected to login => re-auth; if it simply doesn't appear => not-applicable.
      const expr = injectParams(step.expr ?? step.selector!, params);
      try {
        await page.waitForSelector(expr, { timeout, state: "attached" });
      } catch {
        if (looksLikeLogin(page.url())) {
          throw new TypedFail("re-auth", `session required at ${page.url()}`);
        }
        throw new TypedFail("not-applicable", `precondition not met: ${expr}`);
      }
      return;
    }
    case "click":
      await page.click(injectParams(step.selector!, params), { timeout });
      return;
    case "type":
      await page.fill(
        injectParams(step.selector!, params),
        injectParams(step.value ?? "", params),
        { timeout },
      );
      return;
    case "fill":
      await page.fill(
        injectParams(step.selector!, params),
        injectParams(step.value ?? "", params),
        { timeout },
      );
      return;
    case "press":
      await page.press(
        injectParams(step.selector!, params),
        injectParams(step.value!, params),
        { timeout },
      );
      return;
    case "wait_for": {
      // BEST-EFFORT: wait_for is an optimization (wait for dynamic content), NOT a
      // correctness gate. If the selector doesn't appear, we do NOT kill the tool: the
      // real judge is the success_assertion. This prevents an overly specific wait
      // selector (e.g. a text regex that doesn't match due to language/format) from
      // timing out and breaking a tool that could still extract the data.
      // `attached` (not `visible`): being in the DOM is enough.
      const waitTimeout = step.timeoutMs ?? WAIT_FOR_TIMEOUT;
      try {
        await page.waitForSelector(injectParams(step.expr ?? step.selector!, params), {
          timeout: waitTimeout,
          state: "attached",
        });
      } catch {
        // keep going: the success_assertion will confirm whether the data is there.
      }
      return;
    }
    case "upload": {
      // Uploads file(s) to an <input type=file> (e.g. a tweet's image). `value` is
      // the local path(s), separated by '\n', and accepts {{param}}. setInputFiles
      // works even with a hidden input (X hides it behind the media button).
      const paths = injectParams(step.value ?? "", params)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      await page.setInputFiles(injectParams(step.selector!, params), paths, {
        timeout,
      });
      return;
    }
  }
}

/**
 * Should this step be SKIPPED? Only those marked `optional` that reference a {{param}}
 * not provided: that's the mechanism for steps that depend on an optional input (e.g.
 * uploading an image). A non-optional step with a missing param is NOT skipped: let
 * injectParams throw the error and the run fail as it should.
 */
export function skipOptionalStep(
  step: PlaywrightStep,
  params: Record<string, unknown>,
): boolean {
  if (!step.optional) return false;
  for (const text of [step.url, step.selector, step.value, step.expr]) {
    if (!text) continue;
    try {
      injectParams(text, params);
    } catch {
      return true; // a param of the optional step is missing → we skip it
    }
  }
  return false;
}

class TypedFail extends Error {
  constructor(public mode: FailMode, message: string) {
    super(message);
  }
}

async function extractDom(
  page: Page,
  ex: ResultExtractor,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (ex.type === "dom") {
    // The fn is a serialized JS function; we evaluate it in the page context.
    // Canonical signature: (root, params). We pass `document` as the root and the run
    // params serialized as a JSON literal — so the extractor can filter by the query
    // (params.q) without depending on magic free variables, and without using
    // eval/Function in the page (which many sites' CSP block).
    const paramsLiteral = JSON.stringify(params ?? {});
    return page.evaluate(`(${ex.fn})(document, ${paramsLiteral})`);
  }
  return undefined;
}

/** Text alternatives: `contains` can be a string or a list (match = any). */
function textAlternatives(a: Extract<SuccessAssertion, { type: "text" }>): string[] {
  return Array.isArray(a.contains) ? a.contains : [a.contains];
}

/** Describes in prose what the assertion expected (for the failure detail). */
function describeAssertion(a: SuccessAssertion): string {
  switch (a.type) {
    case "dom":
      return `that the page had the element/expression \`${a.expr}\``;
    case "text":
      return `that the page contained the text ${textAlternatives(a)
        .map((t) => `"${t}"`)
        .join(" or ")}`;
    case "json":
      return `that the jsonPath \`${a.jsonPath}\` had a value`;
  }
}

/** Evaluates the assertion ONCE (no retries). */
async function assertionHolds(page: Page, a: SuccessAssertion): Promise<boolean> {
  switch (a.type) {
    case "dom":
      // `expr` can be a CSS selector (presence = success) or a boolean JS expression
      // (e.g. "document.querySelector(...) !== null"). We try it as CSS and, if it
      // doesn't parse as a selector, we evaluate it as JS in the page.
      try {
        return (await page.$(a.expr)) !== null;
      } catch {
        return Boolean(await page.evaluate(a.expr));
      }
    case "text": {
      const html = await page.content();
      return textAlternatives(a).some((t) => html.includes(t));
    }
    case "json":
      return true; // http recipes check jsonPath on their own path
  }
}

export interface AssertionResult {
  ok: boolean;
  /** ALWAYS explains what was expected and what was seen when it fails (ok=false). */
  detail: string;
}

/**
 * Postcondition with a retry window. Polls until `within_ms` (default
 * DEFAULT_ASSERT_WINDOW) to tolerate asynchronous/transient confirmers. When it
 * fails, it builds an actionable detail: what was expected, how long was waited, and
 * the real page state (url + title) to distinguish a broken tool from a re-auth/redirect.
 */
async function checkAssertion(
  page: Page,
  a: SuccessAssertion,
): Promise<AssertionResult> {
  if (a.type === "json") return { ok: true, detail: "" };

  const within = a.within_ms ?? DEFAULT_ASSERT_WINDOW;
  const deadline = Date.now() + within;
  for (;;) {
    if (await assertionHolds(page, a)) return { ok: true, detail: "" };
    const left = deadline - Date.now();
    if (left <= 0) break;
    await page.waitForTimeout(Math.min(ASSERT_POLL_INTERVAL, left));
  }

  // Real page state, defensive (the page may have closed/navigated).
  let url = "";
  let title = "";
  try {
    url = page.url();
  } catch {
    /* ignore */
  }
  try {
    title = await page.title();
  } catch {
    /* ignore */
  }
  const waited = within > 0 ? ` (retried ${within}ms)` : "";
  const detail =
    `expected ${describeAssertion(a)}, but it did not hold${waited}. ` +
    `Page on failure: url=${url || "?"} title="${title}". ` +
    `If the action did happen anyway, the assertion fell short (transient toast or ` +
    `different wording); if the page is a login, it's re-auth, not a broken tool.`;
  return { ok: false, detail };
}

// --- HTTP path -------------------------------------------------------------------

function getJsonPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

async function runHttp(
  tool: Tool,
  params: Record<string, unknown>,
): Promise<RunResult> {
  if (tool.recipe.kind !== "http") throw new Error("recipe is not http");
  const r = tool.recipe;
  const url = injectParams(r.url, params);
  const headers = Object.fromEntries(
    Object.entries(r.headers ?? {}).map(([k, v]) => [k, injectParams(v, params)]),
  );
  const body = r.body ? injectParams(r.body, params) : undefined;

  const res = await fetch(url, { method: r.method, headers, body });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return {
        ok: false,
        error: { mode: "re-auth", message: `HTTP ${res.status}`, retryable: true },
      };
    }
    return { ok: false, error: { mode: "tool-broken", message: `HTTP ${res.status}` } };
  }
  const json = await res.json();
  const result = r.jsonPath ? getJsonPath(json, r.jsonPath) : json;

  if (result === undefined || result === null) {
    return {
      ok: false,
      error: { mode: "tool-broken", message: `empty jsonPath: ${r.jsonPath}` },
    };
  }
  return { ok: true, result };
}

// --- fetch-replay path -----------------------------------------------------------

/** "x.com" → "https://x.com". Leaves a full URL alone. */
function siteOrigin(site: string | undefined): string | undefined {
  if (!site) return undefined;
  return originOf(/^[a-z]+:\/\//i.test(site) ? site : `https://${site}`);
}

/**
 * The origin this run works against — it selects the worker tab the run reuses.
 * Read from the first `navigate` of the recipe (the real entry point) and falling back
 * to the declared `site`. It only has to be *stable*, not exact: a wrong guess costs an
 * extra tab, never a wrong page, because the recipe navigates where it wants anyway.
 */
export function toolOrigin(
  tool: Tool,
  params: Record<string, unknown>,
): string | undefined {
  if (tool.recipe.kind === "fetch-replay") {
    try {
      return originOf(injectParams(tool.recipe.origin, params)) ?? siteOrigin(tool.site);
    } catch {
      return siteOrigin(tool.site);
    }
  }
  if (tool.recipe.kind === "playwright") {
    for (const step of tool.recipe.steps) {
      if (step.action !== "navigate" || !step.url) continue;
      try {
        return originOf(injectParams(step.url, params)) ?? siteOrigin(tool.site);
      } catch {
        break; // a missing param: the step itself will report it
      }
    }
  }
  return siteOrigin(tool.site);
}

/**
 * Whether the worker tab has to be blanked before this run — the entry-side isolation
 * that replaced closing the tab on exit.
 *
 * Only a `playwright` recipe whose first executable step is NOT a navigation needs it:
 * it would otherwise click or type on whatever the previous run left on that tab. One
 * that starts with `navigate` resets by itself (a `goto` tears the document down), and
 * a `fetch-replay` must NEVER be blanked — reusing the live page already sitting on
 * that origin is precisely what makes it cheap.
 */
export function needsBlankReset(
  tool: Tool,
  params: Record<string, unknown>,
): boolean {
  if (tool.recipe.kind !== "playwright") return false;
  for (const step of tool.recipe.steps) {
    if (skipOptionalStep(step, params)) continue;
    return step.action !== "navigate";
  }
  return false;
}

/**
 * Warm-up half of a fetch-replay: navigates ONLY when the worker tab isn't on the site
 * already. Runs under the EXCLUSIVE grade of the origin lock (withOriginPage `prepare`),
 * because a goto must never race another run on the same tab; on a warm tab it is a
 * no-op URL check and costs nothing.
 */
async function ensureFetchReplayOrigin(
  tool: Tool,
  params: Record<string, unknown>,
  page: Page,
): Promise<void> {
  if (tool.recipe.kind !== "fetch-replay") throw new Error("recipe is not fetch-replay");
  const r = tool.recipe;
  const want = originOf(injectParams(r.origin, params));
  if (!want || originOf(page.url()) !== want) {
    const target = injectParams(r.url ?? r.origin, params);
    await page.goto(target, { waitUntil: "domcontentloaded", timeout: DEFAULT_TIMEOUT });
    if (looksLikeLogin(page.url())) {
      throw new TypedFail("re-auth", `session required at ${page.url()}`);
    }
  }
}

/**
 * A navigation tore the document down *while* the in-page fn was running, so the
 * evaluate lost its execution context. It says nothing about the tool: the usual cause
 * is the site redirecting a moment after the warm-up `goto` (doordash.com → /home),
 * which kills a long fetch (a batch) and spares a short one — i.e. a flaky failure that
 * looks like `tool-broken` but isn't.
 */
export function isNavigationRace(e: unknown): boolean {
  const msg = String((e as Error)?.message ?? e ?? "");
  return (
    /Execution context was destroyed/i.test(msg) ||
    /Cannot find context with specified id/i.test(msg) ||
    /Execution context is not available in detached frame/i.test(msg)
  );
}

/**
 * Evaluate half of a fetch-replay: the common case is JUST this — no page load, and the
 * session travels with the request because it is same-origin (what `kind: "http"`
 * cannot do from Node). Runs under the SHARED grade, so N of these against a warm tab
 * proceed concurrently (the browser parallelizes the in-page fetches).
 *
 * Retries ONCE on a navigation race (see `isNavigationRace`), and only for `read` tools —
 * a write may already have landed before the context died, so re-running it could double
 * the effect. The retry waits for the new document and re-evaluates on it; it never
 * navigates, because a `goto` here would run under the SHARED grade and could clobber a
 * run that is overlapping on the same tab.
 */
export async function evaluateFetchReplay(
  tool: Tool,
  params: Record<string, unknown>,
  page: Page,
): Promise<unknown> {
  if (tool.recipe.kind !== "fetch-replay") throw new Error("recipe is not fetch-replay");
  const paramsLiteral = JSON.stringify(params ?? {});
  const expr = `(${tool.recipe.fn})(${paramsLiteral})`;
  try {
    return await page.evaluate(expr);
  } catch (e) {
    if (tool.side_effect !== "read" || !isNavigationRace(e)) throw e;
    await page
      .waitForLoadState("domcontentloaded", { timeout: DEFAULT_TIMEOUT })
      .catch(() => {});
    return await page.evaluate(expr);
  }
}

/**
 * On a session failure, leaves the user one step from fixing it: the tab is already
 * sitting on the login screen (runs don't close their tab any more), so we bring it to
 * the front and say so. The very same call works once they log in — hence `retryable`:
 * the agent should ask and retry, never re-learn a tool that isn't broken.
 */
async function assistReAuth(page: Page, e: unknown): Promise<unknown> {
  if (!(e instanceof TypedFail) || e.mode !== "re-auth") return e;
  let url = "";
  try {
    url = page.url();
  } catch {
    /* the page may be gone: the message degrades, the mode doesn't */
  }
  await page.bringToFront().catch(() => {});
  return new TypedFail(
    "re-auth",
    `${e.message}. I left the tab open and focused${url ? ` on ${url}` : ""}: log in ` +
      `by hand there and ask me for the same thing again — the tool is fine, don't re-learn it.`,
  );
}

// --- entrypoint ------------------------------------------------------------------

/**
 * Reserved markers an extractor may set on its result to ask the runner to bring the
 * run's tab to the FRONT. Meant for MANUAL_CONFIRM flows: the tool prepares a write,
 * navigates the tab to the final review screen, and the human confirms by hand.
 *
 * `_keep_page` used to mean "don't close this tab (and focus it)". Keeping the tab is
 * now what every run does (browser/worker-tabs.ts), so only the focus half is still a
 * decision and that is all the marker does today. The old name keeps working — tools
 * saved with it are in the wild — and `_focus_page` is the name that says what happens.
 * Both are stripped from the result handed back to the agent.
 */
const FOCUS_PAGE_KEYS = ["_focus_page", "_keep_page"] as const;

export function wantsFocus(data: unknown): boolean {
  if (typeof data !== "object" || data === null) return false;
  const rec = data as Record<string, unknown>;
  return FOCUS_PAGE_KEYS.some((k) => rec[k] === true);
}

/** Removes the focus markers so they never reach the agent as if they were data. */
function stripFocusMarkers(data: unknown): void {
  if (typeof data !== "object" || data === null) return;
  for (const k of FOCUS_PAGE_KEYS) delete (data as Record<string, unknown>)[k];
}

/**
 * Persists the item's health. Takes any MemoryItem, not just a Tool, because the
 * composite runner records its own health through here too (compose.ts): otherwise a
 * composite would keep `last_ok: null` forever no matter how often it ran, since only
 * the primitives it dispatches to went through this path.
 *
 * NO-OP for remote items: Option A keeps them ephemeral (they must not create the local
 * file under tools/); their health is inferred server-side from `tool_run` events.
 */
export function bumpHealth(item: MemoryItem, ok: boolean, remote: boolean): void {
  if (remote) return;
  const nowIso = new Date().toISOString();
  const health = ok
    ? { last_ok: nowIso, fail_count: 0 }
    : { last_ok: item.health.last_ok, fail_count: item.health.fail_count + 1 };
  saveItem({ ...item, health });
}

export async function run(
  name: string,
  params: Record<string, unknown> = {},
): Promise<RunResult> {
  let tool: Tool;
  let remote = false;
  try {
    // Unified resolution (Option A): the server wins — memory cache → remote pull →
    // local disk only as fallback (404 or server down). See registry/resolve.ts.
    const resolved = await resolveItem(name);
    if (isComposite(resolved.item)) {
      return {
        ok: false,
        error: { mode: "not-applicable", message: `${name} is a composite, not a primitive` },
        source: isRemoteSource(resolved.source) ? "remote" : "local",
        version: resolved.item.version,
      };
    }
    tool = resolved.item;
    remote = isRemoteSource(resolved.source);
  } catch (e) {
    return {
      ok: false,
      error: { mode: "not-applicable", message: (e as Error).message },
    };
  }
  const source: "local" | "remote" = remote ? "remote" : "local";

  // HTTP path: does not touch the browser.
  if (tool.recipe.kind === "http") {
    const res = await runHttp(tool, params);
    bumpHealth(tool, res.ok, remote);
    return { ...res, source, version: tool.version };
  }

  // http-fn path: runs the serialized fn in Node (cookie jar + optional egress proxy),
  // no browser and no origin lock, so calls are fully parallel. See runner/http-fn.ts.
  if (tool.recipe.kind === "http-fn") {
    const res = await runHttpFn(tool, params);
    bumpHealth(tool, res.ok, remote);
    return { ...res, source, version: tool.version };
  }

  // Browser path: the worker tab of this origin, reused across runs and LEFT OPEN so
  // the user can keep working on what the tool produced (browser/worker-tabs.ts).
  // Concurrency: fetch-replay runs take the SHARED grade of the origin lock (their
  // warm-up goto goes in `prepare`, under the exclusive grade), so parallel read calls
  // against a warm tab truly overlap; playwright runs are exclusive per origin — a
  // parallel call queues instead of clobbering the tab (see browser/origin-lock.ts).
  const recipe = tool.recipe;
  try {
    const result = await withOriginPage(
      toolOrigin(tool, params),
      async (page) => {
        try {
          if (recipe.kind === "fetch-replay") {
            const data = await evaluateFetchReplay(tool, params, page);
            // The fn already returns the data; a json extractor only narrows it.
            const narrowed =
              tool.result_extractor?.type === "json"
                ? getJsonPath(data, tool.result_extractor.jsonPath)
                : data;
            // The postcondition of a fetch is the payload itself: an assertion over the
            // DOM would be checking a page nobody looked at.
            if (narrowed === undefined || narrowed === null) {
              throw new TypedFail(
                "tool-broken",
                `success_assertion failed: the in-page fetch returned no data`,
              );
            }
            if (tool.success_assertion.type === "json") {
              const at = getJsonPath(narrowed, tool.success_assertion.jsonPath);
              if (at === undefined || at === null) {
                throw new TypedFail(
                  "tool-broken",
                  `success_assertion failed: empty jsonPath \`${tool.success_assertion.jsonPath}\` in the fetched data`,
                );
              }
            }
            return narrowed;
          }

          for (const step of recipe.kind === "playwright" ? recipe.steps : []) {
            if (skipOptionalStep(step, params)) continue;
            await runPlaywrightStep(page, step, params);
          }

          // success_assertion (mandatory postcondition).
          const check = await checkAssertion(page, tool.success_assertion);
          if (!check.ok) {
            throw new TypedFail("tool-broken", `success_assertion failed: ${check.detail}`);
          }

          // result_extractor for read tools.
          const data = tool.result_extractor
            ? await extractDom(page, tool.result_extractor, params)
            : { ok: true };
          return data;
        } catch (e) {
          throw await assistReAuth(page, upgradeSessionFailure(tool, params, page, e));
        }
      },
      {
        reset: needsBlankReset(tool, params),
        focus: wantsFocus,
        ...(recipe.kind === "fetch-replay"
          ? {
              shared: true,
              // Cheap warm check under the SHARED grade: only a cold tab pays the
              // exclusive warm-up. Any doubt (bad origin template) says "cold" and
              // lets `prepare` surface the real error.
              needsPrepare: (page: Page) => {
                try {
                  const want = originOf(injectParams(recipe.origin, params));
                  return !want || originOf(page.url()) !== want;
                } catch {
                  return true;
                }
              },
              prepare: async (page: Page) => {
                try {
                  await ensureFetchReplayOrigin(tool, params, page);
                } catch (e) {
                  throw await assistReAuth(page, upgradeSessionFailure(tool, params, page, e));
                }
              },
            }
          : {}),
      },
    );

    stripFocusMarkers(result);
    bumpHealth(tool, true, remote);
    return { ok: true, result, source, version: tool.version };
  } catch (e) {
    if (e instanceof TypedFail) {
      // Only tool-broken counts as a health failure: re-auth/not-applicable are from the
      // environment, not the tool, and must not inflate fail_count nor trigger re-learn.
      if (e.mode === "tool-broken") bumpHealth(tool, false, remote);
      return {
        ok: false,
        error: { mode: e.mode, message: e.message, retryable: e.mode === "re-auth" },
        source,
        version: tool.version,
      };
    }
    // Any other Playwright exception => tool-broken (selector/timeout).
    bumpHealth(tool, false, remote);
    return {
      ok: false,
      error: { mode: "tool-broken", message: (e as Error).message },
      source,
      version: tool.version,
    };
  }
}
