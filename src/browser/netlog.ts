import type { BrowserContext, Request, Response } from "playwright";
import { getSharedContext } from "./connect.js";

/**
 * Network recorder over the shared Chrome (via CDP).
 *
 * PROBLEM it solves: an IN-MEMORY network list that RESETS on every
 * navigation/redirect leaves the agent without the XHRs from before the redirect → the
 * distiller never sees them.
 *
 * SOLUTION: this server controls the dedicated Chrome over CDP. Here we listen to the
 * network events at the CONTEXT level continuously: the event stream is NOT erased by a
 * redirect. The buffer accumulates from when exploration starts (empty discover) until
 * `request` freezes it into the trace. So we have ALL the networks, not the last snapshot.
 *
 * For `xhr`/`fetch` (the API calls: GraphQL, JSON, form-urlencoded) we ALSO store request
 * headers, request body, and response body. That's what the distiller needs to reconstruct
 * a **direct HTTP recipe** and replay it without a browser (faster and deterministic). For
 * the rest of the resources (document, image, css, font, script...) we keep storing only
 * method/url/status/type: their bodies are heavy noise.
 *
 * SECRETS: never persisted. Before storing, (1) the headers whose name smells like a
 * credential (cookie, authorization, *-token, *-key, *-auth...) are replaced with
 * "<redacted>" preserving the KEY (the distiller sees it existed without seeing the value),
 * and (2) JSON/form bodies are walked, redacting values of sensitive fields (password,
 * token, secret, otp, cvv...). The rest of the body —the search query, the GraphQL
 * variables— is kept as-is: it's not a secret and it's exactly what must be parameterized.
 * The session keeps living in the Chrome profile, not in the trace.
 */

export interface NetEntry {
  n: number;
  method: string;
  url: string;
  status?: number;
  /** resourceType de playwright: xhr, fetch, document, image, stylesheet... */
  type: string;
  failed?: boolean;
  /** Optional annotation the agent provides when merging its snapshot. */
  role?: string;
  source?: "cdp" | "agent" | "cdp+agent";
  /** content-type (without parameters) of the response. Only xhr/fetch. */
  mime?: string;
  /** Request headers with secrets redacted. Only xhr/fetch. */
  reqHeaders?: Record<string, string>;
  /** Request body (postData), capped and with secrets redacted. Only xhr/fetch. */
  reqBody?: string;
  /** Response body (json/text/form), capped and with secrets redacted. Only xhr/fetch. */
  resBody?: string;
}

/** Cap on entries to avoid growing without bound on very heavy pages. */
const CAP = 4000;

/** Size caps per body (characters). Local and gitignored, but not infinite. */
const REQ_BODY_CAP = 64_000;
const RES_BODY_CAP = 512_000;

/** Header name that smells like a credential → the value is redacted, the key is kept. */
function isSecretHeader(name: string): boolean {
  const n = name.toLowerCase();
  return (
    n === "cookie" ||
    n === "set-cookie" ||
    n === "authorization" ||
    n === "proxy-authorization" ||
    n === "x-client-data" ||
    n === "x-goog-authuser" ||
    /token|secret|api[-_]?key|auth|password|session|x-csrf|x-xsrf/.test(n)
  );
}

/** Key of a field (in a JSON/form body) whose VALUE is sensitive. */
const SECRET_KEY =
  /pass(word|wd)?|token|secret|otp|^pin$|cvv|card.?number|auth|session|api[-_]?key|credential/i;

export function sanitizeHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = isSecretHeader(k) ? "<redacted>" : v;
  }
  return out;
}

/** Recursively redacts values of sensitive keys in a JSON object/array. */
function scrubJson(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(scrubJson);
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = SECRET_KEY.test(k) ? "<redacted>" : scrubJson(val);
    }
    return out;
  }
  return v;
}

function cap(s: string, max: number): string {
  return s.length <= max ? s : `${s.slice(0, max)}…[+${s.length - max} chars]`;
}

/**
 * Sanitizes a body before persisting it: if it's JSON or form-urlencoded, redacts the
 * values of sensitive fields; if it can't parse it, it leaves it as it came (capped).
 */
export function scrubBody(body: string, mime: string): string {
  const t = body.trimStart();
  if (/json|graphql/i.test(mime) || t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.stringify(scrubJson(JSON.parse(body)));
    } catch {
      /* wasn't valid JSON */
    }
  }
  if (/x-www-form-urlencoded/i.test(mime) || /^[^=&\s]+=[^=]*(&|$)/.test(t)) {
    try {
      const p = new URLSearchParams(body);
      let touched = false;
      for (const k of [...p.keys()]) {
        if (SECRET_KEY.test(k)) {
          p.set(k, "<redacted>");
          touched = true;
        }
      }
      if (touched) return p.toString();
    } catch {
      /* wasn't form-urlencoded */
    }
  }
  return body;
}

/** Is it worth storing this response's body? (data APIs, not binaries.) */
function capturableMime(mime: string): boolean {
  return /json|graphql|x-www-form-urlencoded|xml|text\/plain/i.test(mime);
}

let buffer: NetEntry[] = [];
let seq = 0;
let attached = false;
/** Correlates the response with its request to fill in the status. */
const byReq = new WeakMap<Request, NetEntry>();

/** Only real network traffic (http/ws); we discard data:/blob:/about:. */
function interesting(url: string): boolean {
  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("ws://") ||
    url.startsWith("wss://")
  );
}

/** Only API calls justify storing headers/body (not document/image/css...). */
function isApiCall(type: string): boolean {
  return type === "xhr" || type === "fetch";
}

function attachTo(ctx: BrowserContext): void {
  ctx.on("request", (req: Request) => {
    const url = req.url();
    if (!interesting(url) || buffer.length >= CAP) return;
    const type = req.resourceType();
    const entry: NetEntry = {
      n: (seq += 1),
      method: req.method(),
      url,
      type,
      source: "cdp",
    };
    if (isApiCall(type)) {
      const headers = req.headers();
      entry.reqHeaders = sanitizeHeaders(headers);
      const pd = req.postData();
      if (pd) entry.reqBody = cap(scrubBody(pd, headers["content-type"] ?? ""), REQ_BODY_CAP);
    }
    byReq.set(req, entry);
    buffer.push(entry);
  });
  ctx.on("response", async (res: Response) => {
    const entry = byReq.get(res.request());
    if (!entry) return;
    entry.status = res.status();
    if (!isApiCall(entry.type)) return;
    const ct = res.headers()["content-type"] ?? "";
    entry.mime = ct.split(";")[0].trim() || undefined;
    if (!capturableMime(ct)) return;
    try {
      const txt = await res.text();
      entry.resBody = cap(scrubBody(txt, ct), RES_BODY_CAP);
    } catch {
      /* response with no accessible body (redirect, 204, already discarded) */
    }
  });
  ctx.on("requestfailed", (req: Request) => {
    const entry = byReq.get(req);
    if (entry) entry.failed = true;
  });
}

/**
 * Ensures the recorder is attached and recording. Called on EVERY `discover`. It does NOT
 * clear the buffer: it accumulates across the whole task, so several discovers (e.g.
 * multi-site: discover(["kayak"]) and then discover(["google"])) ADD UP instead of
 * overwriting. The buffer is cleared only when a `request` freezes the episode into a trace
 * (see clearNetLog). Idempotent: the listeners are set only once.
 */
export async function startNetLog(): Promise<void> {
  if (attached) return;
  try {
    attachTo(await getSharedContext());
    attached = true;
  } catch (e) {
    process.stderr.write(
      `[tool-memory] could not start the network recorder: ${(e as Error).message}\n`,
    );
  }
}

/** Snapshot of the buffer accumulated so far. */
export function getNetLog(): NetEntry[] {
  return buffer.slice();
}

/**
 * Clears the buffer. Called by `request` AFTER freezing the trace: it closes the learning
 * episode so the next task starts clean. It's not called on discover (that would lose what
 * was accumulated by a previous discover of the SAME task).
 */
export function clearNetLog(): void {
  buffer = [];
  seq = 0;
}

function keyOf(e: { method?: string; url?: string }): string {
  return `${(e.method ?? "GET").toUpperCase()} ${e.url ?? ""}`;
}

/** The legacy agent sent the network as a JSON string; we normalize to an array. */
function normalizeAgent(raw: unknown): Array<Record<string, unknown>> {
  if (raw == null) return [];
  let v: unknown = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (Array.isArray(v)) return v as Array<Record<string, unknown>>;
  return [v as Record<string, unknown>];
}

/**
 * Joins the server's COMPLETE capture (CDP, survives redirects) with the snapshot the agent
 * passed (which may bring useful `role` annotations). Dedup by method+url: the server's
 * capture is the base and the agent's annotations are preserved. Returns a clean JSON array
 * (and along the way fixes the double-encoding from when the agent sent a string).
 */
export function mergeNetwork(captured: NetEntry[], agentRaw: unknown): NetEntry[] {
  const byKey = new Map<string, NetEntry>();
  for (const e of captured) byKey.set(keyOf(e), { ...e });
  for (const a of normalizeAgent(agentRaw)) {
    const k = keyOf(a as { method?: string; url?: string });
    const ex = byKey.get(k);
    if (ex) {
      if (typeof a.role === "string" && !ex.role) ex.role = a.role;
      ex.source = "cdp+agent";
    } else {
      byKey.set(k, { ...(a as unknown as NetEntry), source: "agent" });
    }
  }
  return [...byKey.values()];
}
