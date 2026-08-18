import vm from "node:vm";
import { fetch as undiciFetch, Headers as UndiciHeaders, type Dispatcher } from "undici";
import type { Tool } from "../schema/tool.js";
import type { RunResult } from "./execute.js";
import { nextDispatcher } from "./proxy-pool.js";

/**
 * The `http-fn` runner: runs a tool's serialized `fn` in Node, with NO browser.
 *
 * `fetch-replay` runs the same kind of `fn` inside a page so the browser attaches the
 * session cookie for it — but that ties the run to one browser and its single exit IP,
 * and serializes behind the origin lock. `http-fn` lifts the exact same `(params) =>
 * data` function into Node and gives it two things the page gave for free, so the fn
 * needs no changes:
 *
 *   1. a COOKIE JAR per call — the fn can `POST /api/sessions` and have the resulting
 *      cookie ride along on its later requests, which is how a region/session-bound
 *      flow (Jumbo's store selection) works without a browser; and
 *   2. an EGRESS PROXY per call (when `recipe.proxy` and BMEM_PROXIES is set), so N
 *      concurrent runs leave through N different IPs.
 *
 * Because there is no page and no origin lock, calls run fully in parallel.
 *
 * The fn is compiled in a fresh `vm` context with only the globals it legitimately uses
 * (fetch, btoa/atob, TextEncoder, timers, URL, JSON, …). That is isolation for tidiness,
 * NOT a security sandbox: tool code is already trusted (it also runs in the user's page).
 */

const FN_TIMEOUT_MS = 120_000;

type CookieJar = Map<string, string>;

/** "name=value; Path=/; HttpOnly" → ["name", "value"]. */
function parseSetCookie(line: string): [string, string] | null {
  const first = line.split(";", 1)[0];
  const eq = first.indexOf("=");
  if (eq <= 0) return null;
  return [first.slice(0, eq).trim(), first.slice(eq + 1).trim()];
}

function cookieHeader(jar: CookieJar): string {
  return [...jar.entries()].map(([k, v]) => `${k}=${v}`).join("; ");
}

/**
 * A `fetch` bound to one call: threads the cookie jar (reads Set-Cookie, resends
 * Cookie) and, if given, routes every request through the same proxy dispatcher. The fn
 * keeps calling plain `fetch(url, opts)` and `credentials: "include"` as if it were in
 * the page; the jar makes that a no-op-compatible truth here.
 */
function boundFetch(jar: CookieJar, dispatcher: Dispatcher | null): typeof fetch {
  return (async (input: any, init: any = {}) => {
    const headers = new UndiciHeaders(init.headers || {});
    const existing = cookieHeader(jar);
    if (existing && !headers.has("cookie")) headers.set("cookie", existing);
    const res = await undiciFetch(input, {
      ...init,
      headers,
      ...(dispatcher ? { dispatcher } : {}),
    });
    const setCookies =
      typeof (res.headers as any).getSetCookie === "function"
        ? (res.headers as any).getSetCookie()
        : [];
    for (const line of setCookies) {
      const kv = parseSetCookie(line);
      if (kv) jar.set(kv[0], kv[1]);
    }
    return res as unknown as Response;
  }) as typeof fetch;
}

function getJsonPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

export async function runHttpFn(
  tool: Tool,
  params: Record<string, unknown>,
): Promise<RunResult> {
  if (tool.recipe.kind !== "http-fn") throw new Error("recipe is not http-fn");
  const recipe = tool.recipe;

  const jar: CookieJar = new Map();
  const picked = recipe.proxy ? nextDispatcher() : null;
  const fetchImpl = boundFetch(jar, picked?.dispatcher ?? null);

  // Only the globals a replay fn legitimately reaches for. Trusted code, plain isolation.
  const sandbox: Record<string, unknown> = {
    fetch: fetchImpl,
    btoa,
    atob,
    TextEncoder,
    TextDecoder,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    Promise,
    JSON,
    Math,
    Date,
    Array,
    Object,
    String,
    Number,
    Boolean,
    isFinite,
    isNaN,
    parseInt,
    parseFloat,
    console,
  };
  vm.createContext(sandbox);

  let fn: (p: unknown) => unknown;
  try {
    fn = vm.runInContext(`(${recipe.fn})`, sandbox, { timeout: 1000 }) as any;
  } catch (e) {
    return {
      ok: false,
      error: { mode: "tool-broken", message: `http-fn compile: ${(e as Error).message}` },
    };
  }

  let data: unknown;
  try {
    data = await withTimeout(Promise.resolve(fn(params)), FN_TIMEOUT_MS);
  } catch (e) {
    return {
      ok: false,
      error: { mode: "tool-broken", message: `http-fn: ${(e as Error).message}` },
    };
  }

  const narrowed =
    tool.result_extractor?.type === "json"
      ? getJsonPath(data, tool.result_extractor.jsonPath)
      : data;

  if (narrowed === undefined || narrowed === null) {
    return {
      ok: false,
      error: { mode: "tool-broken", message: "http-fn returned no data" },
    };
  }
  if (tool.success_assertion.type === "json") {
    const at = getJsonPath(narrowed, tool.success_assertion.jsonPath);
    if (at === undefined || at === null) {
      return {
        ok: false,
        error: {
          mode: "tool-broken",
          message: `success_assertion failed: empty jsonPath \`${tool.success_assertion.jsonPath}\``,
        },
      };
    }
  }
  return { ok: true, result: narrowed };
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}
