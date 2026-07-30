import { listIndex, normalizeSite, removeItem } from "./store.js";
import type { IndexEntry, SideEffect } from "../schema/tool.js";

/**
 * Discovery: matches BY SITE. The input is a list of sites (e.g. ["infobae"],
 * ["airbnb", "wikipedia"]) — the brand name or the full domain, either works.
 * Returns ALL the tools of the sites it recognizes in memory (including
 * login/auth and other preconditions); the agent decides which to run and in what order.
 *
 * If none of the requested sites is in memory, returns EMPTY: there's nothing
 * learned there → the agent explores with playwright and captures new tools (request →
 * distill → save).
 *
 * There's no ranking or score: the match is binary per site. The only ordering is composites
 * first (§10.2); for the rest the index order is preserved. The agent chooses by
 * the `intent`.
 */

export interface Candidate {
  name: string;
  type: "primitive" | "composite";
  site: string;
  intent: string;
  params: string[];
  side_effect: SideEffect;
  /** Where it came from: the user's local memory or the remote registry. */
  source?: "local" | "remote";
}

// Domain parts that do NOT identify a site (TLDs and generic subdomains).
const GENERIC_DOMAIN_PARTS = new Set([
  "www", "com", "org", "net", "edu", "gov", "mil", "int", "info", "biz", "co",
]);

/**
 * Significant labels of a site: without scheme/www/path (normalizeSite) and without generic
 * domain parts (TLDs, www, co...). E.g.: "infobae.com" → ["infobae"],
 * "es.wikipedia.org" → ["es", "wikipedia"], "news.ycombinator.com" → ["news",
 * "ycombinator"]. Also drops the TRAILING ccTLD, so "amazon.com.mx" → ["amazon"]. Does NOT
 * filter by length beyond that: so "x.com" → ["x"] and matches "x" (one-letter domains like
 * Twitter/X).
 *
 * The trailing ccTLD has to go or it becomes a token that bridges unrelated brands: while
 * "mx" was significant, `discover(["amazon.com.mx"])` also returned airbnb.mx and
 * walmart.com.mx — asking about Amazon handed back Airbnb's tools. Only the LAST label is
 * dropped, and only when there is more than one: "es.wikipedia.org" must keep "es" as a
 * significant subdomain, and a bare "x" or "mx" IS the brand the caller typed.
 *
 * Same-brand cross-country matching survives on purpose ("walmart.com" ↔ "walmart.com.mx",
 * "airbnb.com" ↔ "airbnb.mx"): that goes through the brand token, and it's what makes a site
 * published under one ccTLD findable from another.
 */
function siteCoreTokens(site: string): string[] {
  const labels = normalizeSite(site)
    .split(".")
    .filter(Boolean);
  const last = labels.length - 1;
  return labels.filter(
    (p, i) => !GENERIC_DOMAIN_PARTS.has(p) && !(labels.length > 1 && i === last && p.length === 2),
  );
}

/** Composites first (§10.2); stable for the rest. */
function compositesFirst(a: IndexEntry, b: IndexEntry): number {
  return (b.type === "composite" ? 1 : 0) - (a.type === "composite" ? 1 : 0);
}

export function toCandidate(e: IndexEntry): Candidate {
  return {
    name: e.name,
    type: e.type,
    site: e.site,
    intent: e.intent,
    params: [], // filled in index.ts by reading the item (params/requires)
    side_effect: e.side_effect,
    source: "local",
  };
}

/** Composites first, stable (same criterion as the local discover). Reusable. */
export function sortCompositesFirst(list: Candidate[]): Candidate[] {
  return list.sort(
    (a, b) => (b.type === "composite" ? 1 : 0) - (a.type === "composite" ? 1 : 0),
  );
}

/** Result of forgetting a site: what was deleted from local memory. */
export interface ForgetResult {
  site: string;
  deleted: string[];
}

/**
 * Deletes from LOCAL memory all the tools of the requested site (same matching by
 * domain/brand as `discover`). It's DIRECT and IRREVERSIBLE: each `removeItem` deletes the
 * file and reindexes. It doesn't touch the remote registry (the curated offering is shared and
 * curated separately). If nothing matches, `deleted` comes back empty.
 */
export function forgetSite(site: string): ForgetResult {
  const deleted = discover([site]).map((c) => c.name);
  for (const name of deleted) removeItem(name);
  return { site: normalizeSite(site), deleted };
}

/** A site with at least one tool and how many it has (from one source). */
export interface SiteSummary {
  site: string;
  count: number;
}

/**
 * Sites that have at least one tool in LOCAL memory, with the count. Aggregates the index
 * by normalized `site` (without scheme/www/path). Composites without `site` are not counted
 * (they're not recognizable by site). The `list_sites` tool uses it to answer "which
 * sites do we support".
 */
export function listSites(): SiteSummary[] {
  const counts = new Map<string, number>();
  for (const e of listIndex()) {
    if (!e.site) continue;
    const site = normalizeSite(e.site);
    if (!site) continue;
    counts.set(site, (counts.get(site) ?? 0) + 1);
  }
  return [...counts.entries()].map(([site, count]) => ({ site, count }));
}

/** A supported site and where its tools come from (local, remote or both). */
export interface SiteListing {
  site: string;
  source: "local" | "remote" | "both";
  tools: { local: number; remote: number };
}

/**
 * Merges the local and remote sites into a single list deduplicated by site. Marks the
 * origin (local / remote / both) and reports each side's count separately (it doesn't
 * sum them: the same tool can be in both). Sorts alphabetically. Pure and testable.
 */
export function mergeSites(local: SiteSummary[], remote: SiteSummary[]): SiteListing[] {
  const map = new Map<string, SiteListing>();
  const upsert = (rawSite: string, n: number, which: "local" | "remote"): void => {
    const site = normalizeSite(rawSite);
    if (!site) return;
    let entry = map.get(site);
    if (!entry) {
      entry = { site, source: which, tools: { local: 0, remote: 0 } };
      map.set(site, entry);
    }
    entry.tools[which] += n;
    entry.source =
      entry.tools.local > 0 && entry.tools.remote > 0
        ? "both"
        : entry.tools.local > 0
          ? "local"
          : "remote";
  };
  for (const s of local) upsert(s.site, s.count, "local");
  for (const s of remote) upsert(s.site, s.count, "remote");
  return [...map.values()].sort((a, b) => a.site.localeCompare(b.site));
}

/**
 * Compiles a request's match-BY-SITE criterion (list of requested sites) into a
 * reusable predicate. Reduces BOTH sides to the "core": the requested term and the compared site.
 * So "x.com", "www.x.com" and "x" collapse to the token "x" and match each other. It's the ONLY
 * source of truth for the per-site match: it's shared by the local discover (over the on-disk
 * index) and the resolution of remote sites (`matchRemoteSites`). If no site was
 * requested, the predicate is always false.
 */
export function siteMatcher(sites: string[]): (rawSite: string) => boolean {
  const requestedFull = new Set((sites ?? []).map(normalizeSite).filter(Boolean));
  const requestedTokens = new Set((sites ?? []).flatMap(siteCoreTokens));
  if (requestedFull.size === 0) return () => false;
  return (rawSite: string): boolean => {
    const site = normalizeSite(rawSite);
    if (!site) return false;
    return (
      requestedFull.has(site) ||
      siteCoreTokens(site).some((t) => requestedTokens.has(t))
    );
  };
}

/**
 * Given the requested term and a list of CANDIDATE sites (e.g. the remote registry's
 * sites, via `fetchRemoteSites`), returns which candidate sites match — SAME criterion
 * as the local discover: full normalized domain or intersection of core tokens
 * ("x" ↔ "x.com"). The remote server filters by EXACT site (it doesn't tokenize), so this
 * translates the requested term into the real site names before requesting the index. Returns
 * normalized and deduplicated sites.
 */
export function matchRemoteSites(sites: string[], candidates: string[]): string[] {
  const matches = siteMatcher(sites);
  const out = new Set<string>();
  for (const c of candidates) if (matches(c)) out.add(normalizeSite(c));
  return [...out];
}

export function discover(sites: string[]): Candidate[] {
  const matches = siteMatcher(sites);
  const matched = listIndex().filter((e) => e.site && matches(e.site));
  return matched.sort(compositesFirst).map(toCandidate);
}
