#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { join } from "node:path";

import { stopSharedChrome } from "./browser/chrome.js";
import { disconnectReplay, captureScreenshotsInto } from "./browser/connect.js";
// side effect on import: the recorder registers itself to attach when Chrome comes up.
import { getNetLog, mergeNetwork, clearNetLog } from "./browser/netlog.js";
import { getConsoleLog, clearConsoleLog, pickConsole } from "./browser/console-log.js";
import * as explore from "./browser/explore.js";
import { bmHandler } from "./browser/bm-handler.js";
import { paths } from "./config.js";
import {
  discover,
  matchRemoteSites,
  mergeCandidates,
  listSites,
  mergeSites,
  forgetSite,
  type Candidate,
} from "./memory/discover.js";
import { registryConfig } from "./registry/config.js";
import { loadItem, saveItem, removeItem } from "./memory/store.js";
import { isComposite } from "./schema/tool.js";
import { run, type RunResult } from "./runner/execute.js";
import { runComposite, type ComposeResult } from "./runner/compose.js";
import { learn } from "./learn/signal.js";
import {
  fetchRemoteIndex,
  fetchRemoteSites,
  RegistryAuthError,
  RegistryRateLimitError,
} from "./registry/client.js";
import { resolveItem, isRemoteSource, type Resolved } from "./registry/resolve.js";
import { logEvent, formatMsg } from "./registry/log.js";
import { newRunId } from "./registry/run-id.js";
import { runCli } from "./cli.js";

/**
 * MCP entry (stdio). Registers discover / run / save (spec §5). Owns the lifecycle
 * of the shared Chrome: it launches it on startup (spec §4).
 */

/**
 * Protocol the server declares to the host via the MCP handshake (`instructions`).
 * It is injected into the model's context on connect — it installs the discover → run
 * → request loop WITHOUT touching the user's CLAUDE.md. It travels inside the package: it
 * works for everyone, zero config. (It is a protocol hint; Claude Code respects it.)
 */
const INSTRUCTIONS = `
This server gives you a MEMORY of reusable web actions and ALSO controls its own
dedicated Chrome (its own profile, internal port) to explore and learn — you don't need
any other browser server.

ALWAYS FOLLOW this loop when a task involves operating a website:

1. BEFORE exploring with the browser → call \`discover(sites)\` passing the
   site(s) of the task (e.g. ["infobae"] or ["airbnb","booking"]). It returns ALL the
   tools for those sites (login/auth included): pick the right one by its intent
   and RUN IT with \`run\` instead of exploring. Don't open the browser by hand if there's
   already a tool that does the job.

2. If there is NO tool (discover empty) → solve the task by exploring with THIS server's
   \`bm_*\` tools: \`bm_navigate(url)\`, \`bm_snapshot()\`, \`bm_click(ref)\`,
   \`bm_type(ref, text)\`, \`bm_press_key\`, \`bm_wait_for\`, etc. The snapshot returns the
   accessibility tree with \`[ref=eN]\` refs: pass THOSE refs to click/type. Each action
   returns the REAL \`cssSelector\` of the node you touched — use that CSS selector in the
   narration, NEVER the ref (refs are ephemeral and can't be saved). When the task
   finishes WELL, capture the learning with \`request(goal, narration)\`:
   - narration: the canonical steps that worked (intent + action + cssSelector/url/
     value), separating the signal from the exploration noise (no backtracks).
   - you don't need to pass the network: this server already records it on its own (look at it
     with \`bm_network\` to detect a direct HTTP endpoint, more robust than the UI).
   request returns { status: "pending_distill", suggested_prompt, trace_path }. Right
   after that SPAWN A BACKGROUND SUBAGENT with that suggested_prompt: it distills the
   trace and saves the tool(s) with \`save\`. The distiller never touches the browser.

3. \`run(name, params)\` returns DATA, not instructions. Any computation or decision
   over that data is yours. Typed errors:
   - re-auth (retryable) → expired session. I ALREADY left the tab open and focused on
     the login page: ask the user to log in by hand there and then CALL THE SAME run
     AGAIN. Do NOT re-learn, the tool is fine.
   - not-applicable → doesn't apply (no permission / doesn't exist): report and stop.
   - tool-broken → selector/API changed: re-learn from a fresh trace.

PARALLELIZE reads. \`run\` calls of READ tools are safe to issue CONCURRENTLY (same
site or different sites): the server queues what must not race and overlaps the rest,
so N searches cost ~the slowest one, not the sum. Prefer, in order: (1) a tool's own
batch param when its intent mentions one (e.g. \`queries\`/\`asins\` instead of
\`query\`/\`asin\` — one call, fanned out in-page), (2) parallel run calls in one
message. Keep WRITE runs (side_effect write-*) sequential, one at a time.

The tab a run used STAYS OPEN on the page the tool ended on, one per site, so the user
can keep working there (the profile you opened, the cart you filled). Mention it when
it's useful — you don't need to re-open or re-navigate anything for them to see it.

Rules: parametrize whatever varies (q, hours), don't hardcode it. Secrets never go in
tools/traces. write-irreversible (sending, paying) has NO confirmation gate yet:
every run executes for real — confirm with the user before replaying one.

To DISCONNECT this server, the user runs \`npx -y browser-memory@latest uninstall\` in a
terminal and restarts the app: that removes the entry from the host's MCP config. It
CANNOT be unloaded from inside the session, so tell them those two steps if they ask.
\`uninstall\` takes the same optional host as \`install\` (codex | cursor | vscode |
claude); with no host it removes it from every host where it is configured. It touches
only the host config: the learned tools in ~/.tool-memory and the Chrome profile stay.
`.trim();

const server = new McpServer(
  { name: "tool-memory", version: "0.1.0" },
  { instructions: INSTRUCTIONS },
);

/** Message to the agent when the remote usage limit is hit (HTTP 429). */
function rateLimitNotice(e: RegistryRateLimitError): string {
  const when = e.retryAfterSeconds ? ` Retry in ~${e.retryAfterSeconds}s.` : "";
  return `Remote registry usage limit reached.${when} For now, local tools only.`;
}

/**
 * Message to the agent when the remote registry rejects the request (401/403).
 *
 * The client is ANONYMOUS by default: it sends no key unless one was configured and it
 * NEVER starts a login flow on its own — nothing must ever stand between the user and
 * their tools. If the backend requires a key for the remote catalog, the remedy is
 * out-of-band (`browser-memory login`, or TOOL_MEMORY_REGISTRY_KEY) and meanwhile we
 * degrade to the local tools instead of blocking the call.
 */
function authNotice(): string {
  return (
    "The remote registry rejected the request (anonymous or invalid key): local tools only. " +
    "To use the remote catalog, run `npx -y browser-memory@latest login` or set TOOL_MEMORY_REGISTRY_KEY."
  );
}

/** Loads the REMOTE candidates for the requested sites (sites → index → Candidate[]). */
async function loadRemoteCandidates(sites: string[]): Promise<Candidate[]> {
  // the server filters by EXACT site: we translate the term into the real name (matchRemoteSites).
  const remoteSiteList = await fetchRemoteSites();
  const remoteTargets = matchRemoteSites(
    sites,
    remoteSiteList.map((s) => s.site),
  );
  const remoteEntries = await fetchRemoteIndex(
    remoteTargets.length ? remoteTargets : sites,
  );
  return remoteEntries.map((e) => ({
    name: e.name,
    type: e.type,
    site: e.site,
    intent: e.intent,
    params: e.params ?? [],
    side_effect: e.side_effect,
    source: "remote" as const,
  }));
}

/**
 * Resolves the remote candidates WITHOUT ever gating the call. 401 (anonymous or invalid
 * key) and 429 (limit) both degrade to "no remote" + a notice; the LOCAL tools always come
 * back. Never throws.
 */
async function remoteCandidatesSafe(
  sites: string[],
): Promise<{ remote: Candidate[]; notice?: string }> {
  try {
    return { remote: await loadRemoteCandidates(sites) };
  } catch (e) {
    if (e instanceof RegistryAuthError) return { remote: [], notice: authNotice() };
    if (e instanceof RegistryRateLimitError) return { remote: [], notice: rateLimitNotice(e) };
    throw e; // unexpected: the client already degrades 5xx/timeout to [] without throwing.
  }
}

/**
 * resolveItem without any login flow. Returns the resolved item, or a `notice` when the
 * registry refused (anonymous/invalid key, or limit) and the tool lives ONLY there — a
 * local tool never gets here, it resolves off disk. Re-throws "doesn't exist" so run()
 * reports it as not-applicable.
 */
async function resolveWithGate(
  name: string,
): Promise<{ resolved?: Resolved; notice?: string }> {
  try {
    return { resolved: await resolveItem(name) };
  } catch (e) {
    if (e instanceof RegistryAuthError) return { notice: authNotice() };
    if (e instanceof RegistryRateLimitError) return { notice: rateLimitNotice(e) };
    throw e; // "doesn't exist" → run()/runComposite() report it as not-applicable.
  }
}

/** MCP result for a run that couldn't reach a remote-only tool: just the notice. */
function gateResult(notice: string): {
  content: { type: "text"; text: string }[];
  isError: true;
} {
  return { content: [{ type: "text", text: notice }], isError: true };
}

server.tool(
  "discover",
  "FIRST STEP of every web task: call discover BEFORE opening the browser. The " +
    "matching is BY SITE: pass the site(s) of the task (brand or domain, e.g. " +
    "['infobae'], ['airbnb','booking']) and it returns ALL the tools for those sites " +
    "— login/auth included — with the composites first. Pick the right one by " +
    "its intent and, if needed, run its login first. If none of the sites is in " +
    "memory it returns EMPTY: there's nothing learned there, explore with playwright and then " +
    "capture with request() to learn new tools.",
  {
    sites: z
      .array(z.string())
      .describe("site(s) of the task: brand or domain, e.g. ['infobae'] or ['airbnb','booking']"),
  },
  async ({ sites }) => {
    // 1. remote: the server is the source of truth (curated offering). The index already carries the
    //    param names, so there's no need to read the item. A refusal (anonymous/invalid key, or
    //    limit) leaves a notice and no remote; a downed backend degrades to [] without throwing.
    //    Either way we go on with the LOCAL tools: discover never returns empty-handed over auth.
    const { remote, notice } = await remoteCandidatesSafe(sites);

    // 2. local candidates, enriched with the real params by reading the item
    //    (requires.params or params). Dedup against remote happens in mergeCandidates:
    //    the server wins by default, the local copy wins under `prefer-local` (it is
    //    what `run` will execute, so its contract is the one the agent must see).
    const local: Candidate[] = discover(sites).map((c) => {
      try {
        const item = loadItem(c.name);
        const params = isComposite(item)
          ? Object.keys(item.params)
          : Object.keys(item.requires.params);
        return { ...c, params };
      } catch {
        return c;
      }
    });

    const candidates = mergeCandidates(local, remote, registryConfig.preferLocal);

    // "someone wanted to do something and there's no tool (neither local nor remote)": signal of unmet demand.
    if (candidates.length === 0) {
      logEvent({ event_type: "discover_miss", sites });
    }
    // discover does NOT touch the browser: it's a search over the on-disk index + the remote
    // registry, so opening a Chrome window here would be a visible side effect for a call
    // that may end in a `http` recipe, or in nothing at all. Chrome is launched by whoever
    // actually needs it (run / bm_* / request), and the network recorder attaches itself the
    // moment that happens (browser/netlog.ts registers an onBrowserReady hook), so a run
    // followed by exploration on the same site is still fully recorded.

    // if the remote refused (auth / limit), we prepend its notice as a separate text
    // block; the candidates still go as parseable JSON in the second block.
    const content: { type: "text"; text: string }[] = [];
    if (notice) content.push({ type: "text", text: notice });
    content.push({ type: "text", text: JSON.stringify(candidates, null, 2) });
    return { content };
  },
);

server.tool(
  "list_sites",
  "Lists ALL the sites that have at least one tool in memory — the ones from the " +
    "REMOTE registry (the server's curated offering) and the user's LOCAL ones, deduplicated by site. " +
    "Use it to answer 'which sites do we support natively'. It does NOT touch the browser nor " +
    "needs params. Each site carries its `source` (local / remote / both) and the count of " +
    "tools on each side.",
  {},
  async () => {
    // remote best-effort: if the backend is down it returns []. And if it gates (401 without key /
    // 429), we degrade to LOCAL only without throwing — list_sites is informative, it's not worth
    // hanging on a 5-min login nor breaking the call over a site to list.
    let remote: Awaited<ReturnType<typeof fetchRemoteSites>> = [];
    try {
      remote = await fetchRemoteSites();
    } catch (e) {
      if (!(e instanceof RegistryAuthError || e instanceof RegistryRateLimitError)) throw e;
    }
    const local = listSites();
    const sites = mergeSites(local, remote);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ count: sites.length, sites }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "forget_site",
  "Deletes from LOCAL memory all the tools of a site (same brand/" +
    "domain matching as discover: 'wikipedia' → es.wikipedia.org). Use it when the user asks to " +
    "'remove X from the available sites'. It's DIRECT and IRREVERSIBLE: there's no trash bin nor " +
    "undo — confirm with the user before calling it. It does NOT touch the remote registry (the " +
    "server's curated offering is curated separately): if the site exists only in remote, " +
    "`deleted` comes back empty.",
  {
    site: z.string().describe("site to forget: brand or domain, e.g. 'wikipedia' or 'es.wikipedia.org'"),
  },
  async ({ site }) => {
    const res = forgetSite(site);
    const text = res.deleted.length
      ? `Deleted ${res.deleted.length} local tool(s) for '${res.site}': ${res.deleted.join(", ")}.`
      : `There were no local tools for '${res.site}' (it may exist only in the remote registry, which isn't touched from here).`;
    return { content: [{ type: "text", text }] };
  },
);

server.tool(
  "run",
  "Runs a tool from memory deterministically (no model in the loop) and " +
    "returns structured DATA. It checks environment preconditions and the " +
    "success_assertion. The tab it used is LEFT OPEN on the resulting page (one per " +
    "site) for the user to keep working on. READ tools may be called in PARALLEL " +
    "(and some take a batch param — queries/asins — for many lookups in one call); " +
    "keep write runs sequential. Typed errors: re-auth (retryable — the " +
    "login tab is already open and focused: ask the user to log in and call run " +
    "again), not-applicable (doesn't apply), tool-broken (re-learn with request).",
  {
    name: z.string().describe("name of the tool or composite"),
    params: z.record(z.unknown()).optional().describe("params/handles of the tool"),
  },
  async ({ name, params }) => {
    // unified resolution (Option A) to decide the dispatch and know the origin.
    // the cache makes this resolution and the one inside run/runComposite cheap.
    // if the tool is EXCLUSIVELY remote, resolveItem may throw gating (the local ones
    // fall to disk without throwing): 401 → login + retry; 429 → bail out with notice.
    let composite = false;
    let source: "local" | "remote" = "local";
    let version: number | undefined;
    try {
      const gate = await resolveWithGate(name);
      if (gate.notice) return gateResult(gate.notice); // login pending / limit: we don't run.
      if (gate.resolved) {
        composite = isComposite(gate.resolved.item);
        source = isRemoteSource(gate.resolved.source) ? "remote" : "local";
        version = gate.resolved.item.version;
      }
    } catch {
      // doesn't exist anywhere; run()/runComposite() report it as not-applicable.
    }
    // One correlation id for the whole call: a composite shares it with every step of
    // its chain, so the `runs` table can reconstruct the chain by grouping on run_id.
    const runId = newRunId();
    const started = Date.now();
    const res = composite
      ? await runComposite(name, params ?? {}, runId)
      : await run(name, params ?? {});
    const ms = Date.now() - started;

    // tool_run: ONE event per top-level call (a composite = 1 here; its steps are
    // logged by compose.ts as tool_step, sharing this run_id).
    logEvent({
      event_type: "tool_run",
      run_id: runId,
      runtime: "browser",
      tool_name: name,
      ver: !composite ? ((res as RunResult).version ?? version) : version,
      item_type: composite ? "composite" : "primitive",
      source: !composite && (res as RunResult).source ? (res as RunResult).source! : source,
      phase: res.ok ? "ok" : "fail",
      msg: formatMsg(
        composite
          ? (res as ComposeResult).steps.find((s) => !s.ok)?.error
          : (res as RunResult).error,
      ),
      param_keys: Object.keys(params ?? {}),
      ms,
    });

    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      isError: !res.ok,
    };
  },
);

server.tool(
  "save",
  "Saves (or replaces) a primitive tool or a composite in memory. Before " +
    "persisting it validates schema + static lint of the param wiring. For READ " +
    "tools, pass `verify_with` with the concrete params from the trace: the server does " +
    "a real smoke-run and REJECTS the tool if it returns no result (catches the case of a " +
    "param that doesn't arrive and an extractor that returns something anyway). The distiller uses it.",
  {
    tool: z.record(z.unknown()).describe("the Tool (§10.1) or Composite (§10.2) object"),
    verify_with: z
      .record(z.unknown())
      .optional()
      .describe(
        "concrete params (from the trace) for the verification smoke-run. Only applies " +
          "to read primitives; on writes it's ignored (can't be tested without effect).",
      ),
  },
  async ({ tool, verify_with }) => {
    let saved;
    try {
      saved = saveItem(tool);
    } catch (e) {
      // we don't log failed saves: the log only stores what worked well.
      return {
        content: [{ type: "text", text: `Invalid: ${(e as Error).message}` }],
        isError: true,
      };
    }

    const itemType = isComposite(saved) ? "composite" : "primitive";
    const paramKeys = isComposite(saved)
      ? Object.keys(saved.params)
      : Object.keys(saved.requires.params);

    // smoke-run: ONLY read primitives (a write would execute the effect for real).
    if (verify_with && !isComposite(saved) && saved.side_effect === "read") {
      const res = await run(saved.name, verify_with);
      if (!res.ok || res.result == null) {
        removeItem(saved.name); // we revert: a tool that doesn't verify doesn't stay in memory.
        const why = res.ok ? "the extractor returned null/no data" : res.error?.message;
        // we don't log the rejection: the log only stores what worked well.
        return {
          content: [
            {
              type: "text",
              text:
                `Rejected by smoke-run: '${saved.name}' produced no result with ` +
                `${JSON.stringify(verify_with)} — ${why}. The tool was NOT saved; check ` +
                `the param wiring (URL/extractor) and save again.`,
            },
          ],
          isError: true,
        };
      }
      logEvent({
        event_type: "tool_saved",
        tool_name: saved.name,
        item_type: itemType,
        outcome: "ok",
        param_keys: paramKeys,
        meta: { version: saved.version, verified: true },
      });
      return {
        content: [
          {
            type: "text",
            text: `Saved and verified: ${saved.name} (${saved.type} v${saved.version}) — smoke-run OK.`,
          },
        ],
      };
    }

    logEvent({
      event_type: "tool_saved",
      tool_name: saved.name,
      item_type: itemType,
      outcome: "ok",
      param_keys: paramKeys,
      meta: { version: saved.version },
    });
    return {
      content: [
        { type: "text", text: `Saved: ${saved.name} (${saved.type} v${saved.version})` },
      ],
    };
  },
);

server.tool(
  "request",
  "LAST STEP when you did a NEW web action with the browser and it went WELL: " +
    "call request so you don't have to re-discover it next time. It does NOT block: it persists " +
    "the frozen trace and returns `pending_distill` with a `suggested_prompt`. " +
    "MANDATORY CONTRACT: on receiving it, spawn a BACKGROUND SUBAGENT with that " +
    "prompt; the subagent distills the trace and saves the tools via `save`. The distiller " +
    "never touches the browser.",
  {
    goal: z.string().describe("the goal that was achieved, in natural language"),
    narration: z
      .record(z.unknown())
      .describe(
        "object with { steps: [{ intent?, action, url?, selector?, value? }, ...] } — " +
          "the canonical steps of the successful path. `action` is a free label " +
          "(navigate, click, type, parse, extract...). No need to repeat goal/site " +
          "inside: they're filled in on their own. Optional: reader_fn, api_candidate.",
      ),
    network: z
      .unknown()
      .optional()
      .describe("optional: this server already records the network on its own. Only if you want to annotate something extra (see bm_network)."),
    console: z
      .unknown()
      .optional()
      .describe("optional: this server already captures the console on its own (see bm_console)."),
  },
  async ({ goal, narration, network, console }) => {
    try {
      // the server's continuous capture (CDP, complete) wins; whatever the agent passes is
      // merged on top for its `role` annotations. This way the distiller sees ALL the networks.
      const mergedNetwork = mergeNetwork(getNetLog(), network);
      // console: use the agent's only if it brought something; otherwise the server-captured
      // one (avoids a `console: []` silently discarding the internal capture).
      const mergedConsole = pickConsole(console, getConsoleLog());
      const signal = learn({ goal, narration, network: mergedNetwork, console: mergedConsole });
      // we freeze screenshots of the final state "just in case" (best-effort, non-blocking).
      await captureScreenshotsInto(join(signal.trace_path, "screenshots"));
      // frozen episode: we empty the buffers so the next task starts clean.
      // (if learn() had failed, we don't get here and the exploration stays recorded to retry.)
      clearNetLog();
      clearConsoleLog();
      return { content: [{ type: "text", text: JSON.stringify(signal, null, 2) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `invalid request: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// EXPLORATION tools (bm_ prefix): they replace @playwright/mcp to learn NEW
// web actions, all inside this server. They operate on the shared dedicated Chrome
// (the same session the user sees). The bm_ prefix avoids clashing with
// @playwright/mcp's `browser_*` tools if the user has it installed separately.
// ─────────────────────────────────────────────────────────────────────────────

server.tool(
  "bm_navigate",
  "Navigates the active exploration page to a URL and returns { url, title, snapshot } " +
    "(snapshot = accessibility tree with [ref=eN] refs). Use this instead of opening the " +
    "browser by hand when discover didn't bring back a tool.",
  { url: z.string().describe("absolute URL to navigate to") },
  ({ url }) => bmHandler(() => explore.navigate(url))(),
);

server.tool(
  "bm_snapshot",
  "Returns the accessibility snapshot of the active page with [ref=eN] refs (includes " +
    "iframes) + url/title. The refs are used for bm_click/bm_type and are EPHEMERAL: take a " +
    "new one after each action that changes the page.",
  {},
  bmHandler(() => explore.snapshot()),
);

server.tool(
  "bm_click",
  "Clicks the element of the given ref (from the last snapshot) and returns { ok, cssSelector, " +
    "snapshot }. `cssSelector` is the REAL resolved CSS selector of the node: use THAT in the " +
    "request narration, not the ref.",
  {
    ref: z.string().describe("snapshot ref, e.g. 'e12'"),
    element: z.string().optional().describe("human description of the element (readability only)"),
  },
  ({ ref }) => bmHandler(() => explore.clickRef(ref))(),
);

server.tool(
  "bm_type",
  "Types `text` into the field of the given ref and returns { ok, cssSelector, snapshot }. With " +
    "`submit: true` it presses Enter afterwards (useful for search boxes). Use `cssSelector` in the " +
    "narration, not the ref.",
  {
    ref: z.string().describe("ref of the field, e.g. 'e7'"),
    text: z.string().describe("text to type"),
    submit: z.boolean().optional().describe("press Enter after typing"),
    element: z.string().optional().describe("human description (readability only)"),
  },
  ({ ref, text, submit }) => bmHandler(() => explore.typeRef(ref, text, submit))(),
);

server.tool(
  "bm_press_key",
  "Presses a key (e.g. 'Enter', 'Escape', 'ArrowDown'). If you pass `ref`, it presses it on " +
    "that element; otherwise, on the current focus. Returns { ok, snapshot }.",
  {
    key: z.string().describe("key name, e.g. 'Enter'"),
    ref: z.string().optional().describe("ref of the element to press on (optional)"),
  },
  ({ key, ref }) => bmHandler(async () => ({ ok: true, ...(await explore.pressKey(key, ref)) }))(),
);

server.tool(
  "bm_wait_for",
  "Waits (best-effort, a timeout is NOT an error) for a text to appear (`text`), disappear " +
    "(`textGone`), or for some time to pass (`time`, in seconds). Returns { ok, snapshot }.",
  {
    text: z.string().optional().describe("text that should appear"),
    textGone: z.string().optional().describe("text that should disappear"),
    time: z.number().optional().describe("seconds to wait"),
  },
  ({ text, textGone, time }) =>
    bmHandler(async () => ({ ok: true, ...(await explore.waitFor({ text, textGone, time })) }))(),
);

server.tool(
  "bm_network",
  "Returns the network captured by this server (continuous CDP: survives redirects) during " +
    "exploration. For xhr/fetch it brings headers/body (secrets redacted). Useful to detect a " +
    "direct HTTP endpoint and save an http recipe instead of UI.",
  {},
  bmHandler(async () => getNetLog()),
);

server.tool(
  "bm_console",
  "Returns the console messages captured on the explored pages (type/text/location).",
  {},
  bmHandler(async () => getConsoleLog()),
);

server.tool(
  "bm_screenshot",
  "Takes a screenshot of the active page (best-effort) and returns its path on disk.",
  {},
  bmHandler(async () => {
    const path = join(paths.traces, `bm-shot-${Date.now()}.png`);
    return { path: await explore.screenshotActive(path) };
  }),
);

server.tool(
  "bm_select_option",
  "Selects option(s) in a <select> by ref. `values` are the value/label of the options. " +
    "Returns { ok, cssSelector, snapshot }.",
  {
    ref: z.string().describe("ref of the <select>"),
    values: z.array(z.string()).describe("values/labels to select"),
  },
  ({ ref, values }) => bmHandler(() => explore.selectOption(ref, values))(),
);

server.tool(
  "bm_file_upload",
  "Uploads file(s) to the <input type=file> of the given ref (works even if the input is hidden). " +
    "`paths` are absolute paths on disk. Returns { ok, cssSelector }.",
  {
    ref: z.string().describe("ref of the file input"),
    paths: z.array(z.string()).describe("absolute paths of the files to upload"),
  },
  ({ ref, paths: files }) => bmHandler(() => explore.fileUpload(ref, files))(),
);

server.tool(
  "bm_handle_dialog",
  "Configures how to handle the NEXT browser dialogs (alert/confirm/prompt). By " +
    "default they're accepted so as not to hang; pass `accept: false` to dismiss them, and `text` to " +
    "answer a prompt. Returns the last dialog seen.",
  {
    accept: z.boolean().describe("true = accept, false = dismiss"),
    text: z.string().optional().describe("response text for a prompt()"),
  },
  ({ accept, text }) => bmHandler(async () => explore.handleDialog(accept, text))(),
);

server.tool(
  "bm_tabs",
  "Manages the exploration Chrome's tabs. action='list' lists them all (index/url/title/" +
    "active); 'select' makes the one at `index` active; 'close' closes the one at `index`.",
  {
    action: z.enum(["list", "select", "close"]).describe("operation on the tabs"),
    index: z.number().optional().describe("index of the tab (for select/close)"),
  },
  ({ action, index }) => bmHandler(() => explore.tabs(action, index))(),
);

server.tool(
  "bm_navigate_back",
  "Goes back in the active page's history and returns { url, title, snapshot }.",
  {},
  bmHandler(() => explore.navigateBack()),
);

async function main(): Promise<void> {
  // configuration CLI: if there are positional arguments (`config ...`, `help`), it handles them
  // and does NOT launch the MCP server. Without arguments (as the MCP host invokes it) it keeps going.
  const argv = process.argv.slice(2);
  if (argv.length > 0) {
    await runCli(argv);
    return;
  }
  // tool-memory owns Chrome but does NOT launch it at startup: it does it lazily,
  // only when it's really needed (a run, or a discover with no result that's going to
  // lead to exploration). This way connecting the MCP / sending a "hello" opens nothing.
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function shutdown(): Promise<void> {
  await disconnectReplay();
  stopSharedChrome();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((e) => {
  process.stderr.write(`[tool-memory] fatal: ${e}\n`);
  process.exit(1);
});
