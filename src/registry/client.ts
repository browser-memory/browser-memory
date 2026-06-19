import { registryConfig, getApiKey } from "./config.js";
import { parseMemoryItem, type MemoryItem, type SideEffect } from "../schema/tool.js";
import { normalizeSite } from "../memory/store.js";

/**
 * Cliente HTTP fino sobre `fetch` nativo (mismo patrón que execute.ts:runHttp). Best-effort
 * para fallos de ENTORNO (red/timeout/5xx): devuelve el fallback vacío sin propagar — un
 * backend caído no debe romper el MCP. Pero distingue dos respuestas del gating que SÍ se
 * propagan (errores tipados), porque el usuario tiene que enterarse:
 *   401/403 → RegistryAuthError      (falta/invalida la key → disparar login device-code)
 *   429     → RegistryRateLimitError (límite alcanzado → avisar; seguir con tools locales)
 */

/** La key falta, es inválida o fue revocada (HTTP 401/403). */
export class RegistryAuthError extends Error {
  constructor(public status: number) {
    super(`registry auth HTTP ${status}`);
    this.name = "RegistryAuthError";
  }
}

/** Se alcanzó el límite de uso (HTTP 429). `retryAfterSeconds` viene del header Retry-After. */
export class RegistryRateLimitError extends Error {
  constructor(public retryAfterSeconds: number | null) {
    super("registry rate limited (HTTP 429)");
    this.name = "RegistryRateLimitError";
  }
}

/**
 * Traduce los códigos de gating a errores tipados (lanza). El resto (incluido 404 y otros
 * !ok) NO lo toca: lo maneja cada función como best-effort. Se llama justo después del
 * fetch, antes de leer el body.
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

/** ¿Es un error de gating que debe propagarse (vs best-effort)? */
function isGatingError(e: unknown): boolean {
  return e instanceof RegistryAuthError || e instanceof RegistryRateLimitError;
}

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
  const key = getApiKey();
  if (key) h["x-api-key"] = key;
  return h;
}

function warn(msg: string): void {
  process.stderr.write(`[tool-memory] registry: ${msg}\n`);
}

/** Índice remoto de las tools de esos sitios. `[]` ante cualquier fallo. */
export async function fetchRemoteIndex(sites: string[]): Promise<RemoteIndexEntry[]> {
  if (!registryConfig.enabled) return [];
  try {
    // Normalizamos igual que el discovery local (sin esquema/www/path y en minúsculas)
    // para que el match remoto sea case-insensitive: "INFOBAE" == "infobae".
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
    warn(`sites falló: ${(e as Error).message}`);
    return [];
  }
}

/** Baja el definition COMPLETO de una tool y lo valida. `null` ante fallo o 404. */
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
    // No confiamos a ciegas en el server: re-validamos con el MISMO schema del cliente.
    return parseMemoryItem(body.tool);
  } catch (e) {
    if (isGatingError(e)) throw e;
    warn(`tool '${name}' falló: ${(e as Error).message}`);
    return null;
  }
}

/** POST de un evento de uso. Best-effort: traga todo error, nunca bloquea de verdad. */
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
    // Telemetría best-effort: si no se pudo loguear, seguimos sin ruido.
  }
}
