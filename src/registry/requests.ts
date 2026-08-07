import {
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { paths } from "../config.js";
import { normalizeSite } from "../memory/store.js";
import { cfg } from "../settings.js";
import { registryConfig } from "./config.js";
import { postToolRequest } from "./client.js";
import type { NetEntry } from "../browser/netlog.js";
import type { Narration } from "../schema/trace.js";

/**
 * TOOL REQUESTS: "someone did a web action there was no tool for".
 *
 * When `discover` comes back empty the agent solves the task by hand with the `bm_*` tools
 * and then calls `request`, which freezes the trace on disk and reports it HERE. We build the
 * tool from that report; the agent does NOT distill anything on its own anymore.
 *
 * Unlike telemetry (log.ts, fire-and-forget), this POST is the deliverable: if it is lost we
 * never find out the tool was missing. So a failure is NOT swallowed — the payload is queued
 * in `~/.tool-memory/requests/pending/` and retried on the next `request` and on startup.
 *
 * WHAT TRAVELS: goal, the canonical steps (CSS selectors + urls) and the recorded xhr/fetch
 * calls with their bodies — already redacted by netlog.ts (cookies, authorization, password,
 * token... never make it into the buffer). Those bodies are what make a `fetch-replay` recipe
 * reconstructible, but they are also real page data from a logged-in site, so `request-report`
 * downgrades them: `metadata` sends the same report with no body at all, `off` sends nothing
 * (the trace still lands on disk and can be reported by hand later).
 */

export type ReportMode = "full" | "metadata" | "off";

/** Payload size we accept before shrinking. The backend rejects >1 MB, so we leave headroom. */
const MAX_PAYLOAD_BYTES = 900_000;

/** Cap on queued reports: a permanently unreachable backend must not fill the disk. */
const MAX_PENDING = 200;

/** A reported call: the recorded entry plus a mark when we had to cut its body to fit. */
export type ReportedNetEntry = NetEntry & { body_dropped?: boolean };

export interface ToolRequestPayload {
  install_id: string;
  client_version: string;
  trace_id: string;
  goal: string;
  sites: string[];
  outcome?: string;
  success_signal?: string;
  narration: Narration;
  network: ReportedNetEntry[];
  /** true when entries had to be dropped whole to fit under the size cap. */
  network_truncated?: boolean;
  payload_mode: "full" | "metadata";
}

export interface ReportOutcome {
  /** reported = the backend took it; queued = on disk, will be retried; disabled = not sent on purpose. */
  status: "reported" | "queued" | "disabled";
  request_id?: string;
  hits?: number;
  /** Why it was queued/disabled. Goes into the message the agent shows the user. */
  detail?: string;
}

export function reportMode(): ReportMode {
  const raw = (cfg("TOOL_MEMORY_REQUEST_REPORT") ?? "full").toLowerCase();
  return raw === "off" || raw === "metadata" ? raw : "full";
}

/** Is this entry one of the API calls (the ones worth reporting)? */
function isApiCall(e: NetEntry): boolean {
  // an entry merged by the agent may come without `type`: we keep it, it is cheap and it is
  // exactly the call the agent chose to annotate.
  return e.type == null || e.type === "xhr" || e.type === "fetch";
}

function stripBodies(e: ReportedNetEntry): ReportedNetEntry {
  const { reqHeaders: _h, reqBody: _q, resBody: _s, ...rest } = e;
  return rest;
}

function bytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v));
}

/**
 * Shrinks the payload until it fits, dropping what is least valuable first: the biggest
 * response body, then request bodies, then whole entries. Every drop is flagged so whoever
 * builds the tool knows the call existed and its body was cut, instead of silently seeing
 * an endpoint with no data.
 */
function fitPayload(payload: ToolRequestPayload): ToolRequestPayload {
  const net = payload.network.map((e) => ({ ...e }));
  const out = { ...payload, network: net };

  const biggest = (field: "resBody" | "reqBody"): number => {
    let idx = -1;
    let max = 0;
    net.forEach((e, i) => {
      const len = e[field]?.length ?? 0;
      if (len > max) {
        max = len;
        idx = i;
      }
    });
    return idx;
  };

  while (bytes(out) > MAX_PAYLOAD_BYTES) {
    const res = biggest("resBody");
    if (res >= 0) {
      delete net[res].resBody;
      net[res].body_dropped = true;
      continue;
    }
    const req = biggest("reqBody");
    if (req >= 0) {
      delete net[req].reqBody;
      net[req].body_dropped = true;
      continue;
    }
    if (net.length > 1) {
      // no bodies left: halve the tail. The earliest calls are the ones that set the flow up.
      net.length = Math.floor(net.length / 2);
      out.network_truncated = true;
      continue;
    }
    break; // narration alone is over the cap: nothing left to trim, let the backend decide.
  }
  return out;
}

/** Builds the report from what `request` received. Pure: it does not touch the network. */
export function buildRequestPayload(input: {
  traceId: string;
  goal: string;
  narration: Narration;
  network?: unknown;
  mode?: ReportMode;
}): ToolRequestPayload {
  const mode = input.mode ?? reportMode();
  const raw = Array.isArray(input.network) ? (input.network as NetEntry[]) : [];
  const api = raw.filter(isApiCall);
  const network = mode === "metadata" ? api.map(stripBodies) : api;
  const site = input.narration.site ? normalizeSite(input.narration.site) : "";

  return fitPayload({
    install_id: registryConfig.installId,
    client_version: registryConfig.clientVersion,
    trace_id: input.traceId,
    goal: input.goal,
    sites: site ? [site] : [],
    outcome: input.narration.outcome,
    success_signal: input.narration.success_signal,
    narration: input.narration,
    network,
    payload_mode: mode === "metadata" ? "metadata" : "full",
  });
}

/** Same report with every body removed — what we retry with when the backend answers 413. */
function downgrade(payload: ToolRequestPayload): ToolRequestPayload {
  return {
    ...payload,
    network: payload.network.map(stripBodies),
    payload_mode: "metadata",
  };
}

function queueFile(traceId: string): string {
  return join(paths.pendingRequests, `${traceId}.json`);
}

/** Queued files, oldest first (`trace-9` before `trace-10`: numeric, not lexicographic). */
function pendingFiles(): string[] {
  if (!existsSync(paths.pendingRequests)) return [];
  const num = (f: string): number => Number(/(\d+)/.exec(f)?.[1] ?? Number.MAX_SAFE_INTEGER);
  return readdirSync(paths.pendingRequests)
    .filter((f) => f.endsWith(".json"))
    .sort((a, b) => num(a) - num(b) || a.localeCompare(b));
}

function enqueue(payload: ToolRequestPayload): void {
  try {
    mkdirSync(paths.pendingRequests, { recursive: true });
    const files = pendingFiles();
    for (const stale of files.slice(0, Math.max(0, files.length - MAX_PENDING + 1))) {
      try {
        unlinkSync(join(paths.pendingRequests, stale));
      } catch {
        /* it was already gone */
      }
    }
    writeFileSync(queueFile(payload.trace_id), JSON.stringify(payload) + "\n");
  } catch {
    // the disk is the last resort; if it fails too there is nothing else to do.
  }
}

function dequeue(file: string): void {
  try {
    unlinkSync(join(paths.pendingRequests, file));
  } catch {
    /* already removed */
  }
}

/**
 * Sends one report, retrying once without bodies if the backend found it too big.
 * `null` = it did not get through and should be queued.
 */
async function send(
  payload: ToolRequestPayload,
): Promise<{ request_id?: string; hits?: number } | { permanent: true } | null> {
  const res = await postToolRequest(payload);
  if (res.ok) {
    return { request_id: res.request_id ?? undefined, hits: res.hits ?? undefined };
  }
  if (res.code === 413 && payload.payload_mode === "full") {
    const retry = await postToolRequest(downgrade(payload));
    if (retry.ok) {
      return { request_id: retry.request_id ?? undefined, hits: retry.hits ?? undefined };
    }
    return retry.permanent || retry.code === 413 ? { permanent: true } : null;
  }
  return res.permanent ? { permanent: true } : null;
}

/**
 * Retries the queued reports, oldest first. Stops at the first transient failure: if the
 * backend is down there is no point hammering it with the whole queue. Returns how many
 * left the disk (sent or definitively discarded).
 */
export async function flushPendingRequests(): Promise<number> {
  if (!registryConfig.enabled || reportMode() === "off") return 0;
  let drained = 0;
  for (const file of pendingFiles()) {
    let payload: ToolRequestPayload;
    try {
      payload = JSON.parse(readFileSync(join(paths.pendingRequests, file), "utf8"));
    } catch {
      dequeue(file); // corrupt file: it will never be sent
      drained++;
      continue;
    }
    const res = await send(payload);
    if (res === null) break; // backend down: keep the rest for the next round
    dequeue(file);
    drained++;
  }
  return drained;
}

/**
 * Reports the tool request. NEVER throws: at worst it queues on disk and says so, because
 * this runs inside the `request` MCP call and must not break a task that already succeeded.
 */
export async function reportToolRequest(payload: ToolRequestPayload): Promise<ReportOutcome> {
  if (reportMode() === "off") {
    return { status: "disabled", detail: "request-report is off" };
  }
  if (!registryConfig.enabled) {
    return { status: "disabled", detail: "the remote registry is off (`config server off`)" };
  }
  try {
    const res = await send(payload);
    if (res === null) {
      enqueue(payload);
      return { status: "queued", detail: "the backend did not answer; it will be retried" };
    }
    if ("permanent" in res) {
      return { status: "disabled", detail: "the backend rejected the report" };
    }
    // the queue only drains once something got through: proof the backend is up again.
    void flushPendingRequests();
    return { status: "reported", request_id: res.request_id, hits: res.hits };
  } catch (e) {
    enqueue(payload);
    return { status: "queued", detail: (e as Error).message };
  }
}
