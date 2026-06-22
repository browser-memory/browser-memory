import type { Page } from "playwright";
import { withFreshPage } from "../browser/connect.js";
import { saveTool } from "../memory/store.js";
import { isComposite } from "../schema/tool.js";
import { resolveItem, isRemoteSource } from "../registry/resolve.js";
import type {
  Tool,
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
  error?: { mode: FailMode; message: string };
  /** Where the tool was resolved from (for logging). */
  source?: "local" | "remote";
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
      return { ok: false, error: { mode: "re-auth", message: `HTTP ${res.status}` } };
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

// --- entrypoint ------------------------------------------------------------------

/**
 * Persists the tool's health. NO-OP for remote tools: Option A keeps them ephemeral
 * (they must not create the local file under tools/); their health is inferred
 * server-side from `tool_run` events.
 */
function bumpHealth(tool: Tool, ok: boolean, remote: boolean): void {
  if (remote) return;
  const nowIso = new Date().toISOString();
  const health = ok
    ? { last_ok: nowIso, fail_count: 0 }
    : { last_ok: tool.health.last_ok, fail_count: tool.health.fail_count + 1 };
  saveTool({ ...tool, health });
}

export async function run(
  name: string,
  params: Record<string, unknown> = {},
): Promise<RunResult> {
  let tool: Tool;
  let remote = false;
  try {
    // Unified resolution (Option A): local disk → memory cache → remote pull.
    const resolved = await resolveItem(name);
    if (isComposite(resolved.item)) {
      return {
        ok: false,
        error: { mode: "not-applicable", message: `${name} is a composite, not a primitive` },
        source: isRemoteSource(resolved.source) ? "remote" : "local",
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
    return { ...res, source };
  }

  // Playwright path: fresh tab on the shared Chrome (self-contained).
  try {
    const result = await withFreshPage(async (page) => {
      for (const step of tool.recipe.kind === "playwright" ? tool.recipe.steps : []) {
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
    });

    bumpHealth(tool, true, remote);
    return { ok: true, result, source };
  } catch (e) {
    if (e instanceof TypedFail) {
      // Only tool-broken counts as a health failure: re-auth/not-applicable are from the
      // environment, not the tool, and must not inflate fail_count nor trigger re-learn.
      if (e.mode === "tool-broken") bumpHealth(tool, false, remote);
      return { ok: false, error: { mode: e.mode, message: e.message }, source };
    }
    // Any other Playwright exception => tool-broken (selector/timeout).
    bumpHealth(tool, false, remote);
    return {
      ok: false,
      error: { mode: "tool-broken", message: (e as Error).message },
      source,
    };
  }
}
