import { loadItem } from "../memory/store.js";
import { isComposite, type MemoryItem } from "../schema/tool.js";
import { getCached, setCached } from "./cache.js";
import { fetchRemoteTool } from "./client.js";
import { logEvent } from "./log.js";

/**
 * Unified resolution of an item (Option A). The SERVER is the source of truth (curated
 * offering): it wins over a local copy of the same name. Order:
 *   1. memory cache  → source "remote-cache" (already pulled in this process; doesn't re-hit the server)
 *   2. remote pull   → source "remote-pull"  (pulls, VALIDATES, caches in memory; NEVER to disk)
 *   3. local disk    → source "local"        (fallback: only if the server doesn't have it)
 * If it's nowhere, it throws with the SAME message as store.loadItem to preserve the
 * runner's `not-applicable` contract.
 *
 * HARD GATE: if the server responds 401/403/429, fetchRemoteTool THROWS and that propagates
 * without falling back to local — without a valid session nothing is served (not even the local
 * copy). The disk fallback only happens when the server responded 404 (doesn't have it) or was
 * DOWN (5xx/timeout → null), preserving offline resilience for whoever already has a key.
 *
 * Cost of "the server wins": a server tool is pulled on each run (the cache only lives as
 * long as the process). A LOCAL-only tool does a GET that returns 404 (silent) and falls
 * back to disk. That's the price of having the server as authority and the ephemeral recipe
 * (not on disk).
 */

export type ResolveSource = "local" | "remote-cache" | "remote-pull";

export interface Resolved {
  item: MemoryItem;
  source: ResolveSource;
}

/** Did the item come from the server (cache or pull)? For logging (source: local|remote). */
export function isRemoteSource(s: ResolveSource): boolean {
  return s !== "local";
}

export async function resolveItem(name: string): Promise<Resolved> {
  // 1. In-memory cache (already pulled from the server in this process).
  const cached = getCached(name);
  if (cached) return { item: cached, source: "remote-cache" };

  // 2. Remote pull: the server wins. Pulls + validates + caches. Only here is tool_pulled emitted.
  //    HARD GATE: a 401/429 (RegistryAuth/RateLimitError) PROPAGATES right here, without falling
  //    back to local — without a valid session nothing is served. The 5xx/timeout don't throw
  //    (fetchRemoteTool degrades them to null), so the local fallback below gives resilience when
  //    the server is DOWN.
  const pulled = await fetchRemoteTool(name);
  if (pulled) {
    setCached(name, pulled);
    logEvent({
      event_type: "tool_pulled",
      tool_name: name,
      item_type: isComposite(pulled) ? "composite" : "primitive",
      source: "remote",
    });
    return { item: pulled, source: "remote-pull" };
  }

  // 3. Fallback to local disk (only if the server responded 404 or was down, NOT if it gated).
  try {
    return { item: loadItem(name), source: "local" };
  } catch {
    // not present locally.
  }

  throw new Error(`Item not found in memory: ${name}`);
}
