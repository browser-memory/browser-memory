import { registryConfig } from "./config.js";
import { parseMemoryItem, type MemoryItem, type SideEffect } from "../schema/tool.js";
import { normalizeSite } from "../memory/store.js";

/**
 * Cliente HTTP fino sobre `fetch` nativo (mismo patrón que execute.ts:runHttp). Todo es
 * best-effort: ante cualquier fallo de red/timeout devuelve el fallback vacío y NUNCA
 * propaga la excepción — un backend caído no debe romper el MCP.
 */

/** Entrada del índice remoto: IndexEntry + los nombres de params (sin valores). */
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
  if (registryConfig.apiKey) h["x-api-key"] = registryConfig.apiKey;
  return h;
}

function warn(msg: string): void {
  process.stderr.write(`[tool-memory] registry: ${msg}\n`);
}

/** Índice remoto de las tools de esos sitios. `[]` ante cualquier fallo. */
export async function fetchRemoteIndex(sites: string[]): Promise<RemoteIndexEntry[]> {
  try {
    // Normalizamos igual que el discovery local (sin esquema/www/path y en minúsculas)
    // para que el match remoto sea case-insensitive: "INFOBAE" == "infobae".
    const normalized = sites.map(normalizeSite).filter(Boolean);
    const q = encodeURIComponent(normalized.join(","));
    const res = await fetch(url(`/v1/registry/index?sites=${q}`), {
      headers: headers(),
      signal: AbortSignal.timeout(registryConfig.timeoutMs),
    });
    if (!res.ok) {
      warn(`index HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as { entries?: RemoteIndexEntry[] };
    return body.entries ?? [];
  } catch (e) {
    warn(`index falló: ${(e as Error).message}`);
    return [];
  }
}

/** Sitio remoto con su conteo de tools curadas. */
export interface RemoteSiteEntry {
  site: string;
  count: number;
}

/** Sitios remotos que tienen al menos una tool curada. `[]` ante cualquier fallo. */
export async function fetchRemoteSites(): Promise<RemoteSiteEntry[]> {
  try {
    const res = await fetch(url(`/v1/registry/sites`), {
      headers: headers(),
      signal: AbortSignal.timeout(registryConfig.timeoutMs),
    });
    if (!res.ok) {
      warn(`sites HTTP ${res.status}`);
      return [];
    }
    const body = (await res.json()) as { sites?: RemoteSiteEntry[] };
    return body.sites ?? [];
  } catch (e) {
    warn(`sites falló: ${(e as Error).message}`);
    return [];
  }
}

/** Baja el definition COMPLETO de una tool y lo valida. `null` ante fallo o 404. */
export async function fetchRemoteTool(name: string): Promise<MemoryItem | null> {
  try {
    const res = await fetch(url(`/v1/registry/tool/${encodeURIComponent(name)}`), {
      headers: headers(),
      signal: AbortSignal.timeout(registryConfig.timeoutMs),
    });
    if (!res.ok) {
      if (res.status !== 404) warn(`tool '${name}' HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as { tool?: unknown };
    if (body.tool == null) return null;
    // No confiamos a ciegas en el server: re-validamos con el MISMO schema del cliente.
    return parseMemoryItem(body.tool);
  } catch (e) {
    warn(`tool '${name}' falló: ${(e as Error).message}`);
    return null;
  }
}

/** POST de un evento de uso. Best-effort: traga todo error, nunca bloquea de verdad. */
export async function postEvent(payload: Record<string, unknown>): Promise<void> {
  try {
    await fetch(url(`/v1/events`), {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(registryConfig.timeoutMs),
    });
  } catch {
    // Telemetría best-effort: si no se pudo loguear, seguimos sin ruido.
  }
}
