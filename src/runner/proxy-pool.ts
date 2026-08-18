import { ProxyAgent, type Dispatcher } from "undici";

/**
 * A rotating pool of egress proxies for the `http-fn` runner.
 *
 * WHY this exists: an `http-fn` tool runs entirely in Node (no browser), so unlike a
 * `fetch-replay` — which inherits the one browser's single exit IP — it can send every
 * call out through a different address. Sites that rate-limit or ban by IP (Coto, La
 * Anónima, and any VTEX store that starts blocking) become scrapeable in parallel: N
 * searches, N IPs, no shared quota.
 *
 * The pool is read from the env, comma/newline/space separated, so IPs can be swapped
 * without a deploy:
 *   BMEM_PROXIES="http://user:pass@host1:port, http://user:pass@host2:port"
 *
 * Each distinct proxy URL gets ONE cached ProxyAgent (a Dispatcher). `nextDispatcher()`
 * hands them out round-robin; a single `http-fn` call keeps the same dispatcher for all
 * of its own requests (the fn's internal fan-out shares one IP, which is what a
 * cookie/session-bound flow like Jumbo's region needs), and the NEXT call gets the next
 * IP. Returns null when no proxies are configured, so the runner falls back to a direct
 * connection and the tool still works — just off a single IP.
 */

function parseList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(/[\s,]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

let PROXIES: string[] | null = null;
const agents = new Map<string, ProxyAgent>();
let cursor = 0;

/** Reads BMEM_PROXIES lazily and memoizes it (call `resetProxyPool()` in tests). */
function proxies(): string[] {
  if (PROXIES === null) PROXIES = parseList(process.env.BMEM_PROXIES);
  return PROXIES;
}

export function hasProxies(): boolean {
  return proxies().length > 0;
}

export function proxyCount(): number {
  return proxies().length;
}

/**
 * Next proxy in round-robin order, as an undici Dispatcher ready for `fetch(url, {
 * dispatcher })`. Returns { dispatcher, url } so the caller can log which IP a run took,
 * or null when the pool is empty (→ direct connection).
 */
export function nextDispatcher(): { dispatcher: Dispatcher; url: string } | null {
  const list = proxies();
  if (!list.length) return null;
  const url = list[cursor % list.length];
  cursor = (cursor + 1) % list.length;
  let agent = agents.get(url);
  if (!agent) {
    agent = new ProxyAgent(url);
    agents.set(url, agent);
  }
  return { dispatcher: agent, url };
}

/** Test seam: forget the memoized list and cached agents. */
export function resetProxyPool(): void {
  PROXIES = null;
  cursor = 0;
  for (const a of agents.values()) void a.close().catch(() => {});
  agents.clear();
}
