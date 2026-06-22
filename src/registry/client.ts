import { registryConfig, getApiKey } from "./config.js";
import { parseMemoryItem, type MemoryItem, type SideEffect } from "../schema/tool.js";
import { normalizeSite } from "../memory/store.js";

/**
 * Thin HTTP client over native `fetch` (same pattern as execute.ts:runHttp). Best-effort
 * for ENVIRONMENT failures (network/timeout/5xx): returns the empty fallback without
 * propagating — a backend that is down must not break the MCP. But it distinguishes two
 * gating responses that DO propagate (typed errors), because the user must find out:
 *   401/403 → RegistryAuthError      (missing/invalid key → trigger device-code login)
 *   429     → RegistryRateLimitError (limit reached → warn; continue with local tools)
 */

/** The key is missing, invalid or was revoked (HTTP 401/403). */
export class RegistryAuthError extends Error {
  constructor(public status: number) {
    super(`registry auth HTTP ${status}`);
    this.name = "RegistryAuthError";
  }
}

/** The usage limit was reached (HTTP 429). `retryAfterSeconds` comes from the Retry-After header. */
export class RegistryRateLimitError extends Error {
  constructor(public retryAfterSeconds: number | null) {
    super("registry rate limited (HTTP 429)");
    this.name = "RegistryRateLimitError";
  }
}

/**
 * Translates the gating codes into typed errors (throws). The rest (including 404 and other
 * !ok) it does NOT touch: each function handles it as best-effort. Called right after the
 * fetch, before reading the body.
 */
export function classify(res: Response): void {
  if (res.status === 401 || res.status === 403) {
    throw new RegistryAuthError(res.status);
  }
  if (res.status === 429) {
    const ra = res.headers.get("retry-after");
    const seconds = ra != null && ra.trim() !== "" ? Number(ra) : NaN;
    throw new RegistryRateLimitError(Number.isFinite(seconds) ? seconds : null);
  }
}

/** Is it a gating error that must propagate (vs best-effort)? */
function isGatingError(e: unknown): boolean {
  return e instanceof RegistryAuthError || e instanceof RegistryRateLimitError;
}

/** Remote index entry: IndexEntry + the param names (no values). */
export interface RemoteIndexEntry {
  name: string;
  site: string;
  type: "primitive" | "composite";
  intent: string;
  keywords: string[];
  side_effect: SideEffect;
  params: string[];
}

function url(path: string): string {
  return `${registryConfig.baseUrl}${path}`;
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  const key = getApiKey();
  if (key) h["x-api-key"] = key;
  return h;
}

function warn(msg: string): void {
  process.stderr.write(`[tool-memory] registry: ${msg}\n`);
}

/** Remote index of the tools for those sites. `[]` on any failure. */
export async function fetchRemoteIndex(sites: string[]): Promise<RemoteIndexEntry[]> {
  if (!registryConfig.enabled) return [];
  try {
    // Normalize the same way as local discovery (no scheme/www/path and lowercased)
    // so the remote match is case-insensitive: "INFOBAE" == "infobae".
    const normalized = sites.map(normalizeSite).filter(Boolean);
    const q = encodeURIComponent(normalized.join(","));
    const res = await fetch(url(`/v1/registry/index?sites=${q}`), {
      headers: headers(),
      signal: AbortSignal.timeout(registryConfig.timeoutMs),
    });
    classify(res);
    if (!res.ok) {
      warn(`index HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as { entries?: RemoteIndexEntry[] };
    return body.entries ?? [];
  } catch (e) {
    if (isGatingError(e)) throw e;
    warn(`index failed: ${(e as Error).message}`);
    return [];
  }
}

/** Remote site with its count of curated tools. */
export interface RemoteSiteEntry {
  site: string;
  count: number;
}

/** Remote sites that have at least one curated tool. `[]` on any failure. */
export async function fetchRemoteSites(): Promise<RemoteSiteEntry[]> {
  if (!registryConfig.enabled) return [];
  try {
    const res = await fetch(url(`/v1/registry/sites`), {
      headers: headers(),
      signal: AbortSignal.timeout(registryConfig.timeoutMs),
    });
    classify(res);
    if (!res.ok) {
      warn(`sites HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as { sites?: RemoteSiteEntry[] };
    return body.sites ?? [];
  } catch (e) {
    if (isGatingError(e)) throw e;
    warn(`sites failed: ${(e as Error).message}`);
    return [];
  }
}

/** Pulls the FULL definition of a tool and validates it. `null` on failure or 404. */
export async function fetchRemoteTool(name: string): Promise<MemoryItem | null> {
  if (!registryConfig.enabled) return null;
  try {
    const res = await fetch(url(`/v1/registry/tool/${encodeURIComponent(name)}`), {
      headers: headers(),
      signal: AbortSignal.timeout(registryConfig.timeoutMs),
    });
    classify(res);
    if (!res.ok) {
      if (res.status !== 404) warn(`tool '${name}' HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { tool?: unknown };
    if (body.tool == null) return null;
    // We don't blindly trust the server: re-validate with the SAME client schema.
    return parseMemoryItem(body.tool);
  } catch (e) {
    if (isGatingError(e)) throw e;
    warn(`tool '${name}' failed: ${(e as Error).message}`);
    return null;
  }
}

/** POST of a usage event. Best-effort: swallows every error, never really blocks. */
export async function postEvent(payload: Record<string, unknown>): Promise<void> {
  if (!registryConfig.enabled) return;
  try {
    await fetch(url(`/v1/events`), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(registryConfig.timeoutMs),
    });
  } catch {
    // Best-effort telemetry: if it couldn't be logged, we continue without noise.
  }
}
