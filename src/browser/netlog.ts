import type { BrowserContext, Request, Response } from "playwright";
import { getSharedContext } from "./connect.js";

/**
 * Grabador de red sobre el Chrome compartido (vía CDP).
 *
 * PROBLEMA que resuelve: `browser_network_requests` de playwright-mcp reporta una lista
 * EN MEMORIA que se RESETEA en cada navegación/redirect. Si el agente saca el snapshot
 * después de un redirect, los XHR de antes ya no están → el distiller nunca los ve.
 *
 * SOLUCIÓN: tool-memory ya está atachado al MISMO Chrome por CDP. Acá escuchamos los
 * eventos de red a nivel CONTEXTO de forma continua: el stream de eventos NO se borra
 * con un redirect. El buffer acumula desde que arranca la exploración (discover vacío)
 * hasta que `request` lo congela en la trace. Así tenemos TODOS los networks, no el
 * último snapshot.
 *
 * NO guardamos headers ni bodies: solo method/url/status/tipo. Así nunca filtramos
 * secretos (tokens viven en headers/postData) y el distiller igual ve el endpoint —
 * el `operationName` de GraphQL, p.ej., viaja en la URL.
 */

export interface NetEntry {
  n: number;
  method: string;
  url: string;
  status?: number;
  /** resourceType de playwright: xhr, fetch, document, image, stylesheet... */
  type: string;
  failed?: boolean;
  /** Anotación opcional que aporta el agente al mergear su snapshot. */
  role?: string;
  source?: "cdp" | "agent" | "cdp+agent";
}

/** Tope de entradas para no crecer sin límite en páginas muy pesadas. */
const CAP = 4000;

let buffer: NetEntry[] = [];
let seq = 0;
let attached = false;
/** Correlaciona la response con su request para completar el status. */
const byReq = new WeakMap<Request, NetEntry>();

/** Solo tráfico de red real (http/ws); descartamos data:/blob:/about:. */
function interesting(url: string): boolean {
  return (
    url.startsWith("http://") ||
    url.startsWith("https://") ||
    url.startsWith("ws://") ||
    url.startsWith("wss://")
  );
}

function attachTo(ctx: BrowserContext): void {
  ctx.on("request", (req: Request) => {
    const url = req.url();
    if (!interesting(url) || buffer.length >= CAP) return;
    const entry: NetEntry = {
      n: (seq += 1),
      method: req.method(),
      url,
      type: req.resourceType(),
      source: "cdp",
    };
    byReq.set(req, entry);
    buffer.push(entry);
  });
  ctx.on("response", (res: Response) => {
    const entry = byReq.get(res.request());
    if (entry) entry.status = res.status();
  });
  ctx.on("requestfailed", (req: Request) => {
    const entry = byReq.get(req);
    if (entry) entry.failed = true;
  });
}

/**
 * Asegura que el grabador esté atachado y grabando. Lo llama CADA `discover`. NO limpia
 * el buffer: acumula a lo largo de toda la tarea, así varios discover (ej. multi-sitio:
 * discover(["kayak"]) y después discover(["google"])) SUMAN en vez de pisarse. El buffer
 * se vacía recién cuando un `request` congela el episodio en una trace (ver clearNetLog).
 * Idempotente: los listeners se ponen una sola vez.
 */
export async function startNetLog(): Promise<void> {
  if (attached) return;
  try {
    attachTo(await getSharedContext());
    attached = true;
  } catch (e) {
    process.stderr.write(
      `[tool-memory] no pude iniciar el grabador de red: ${(e as Error).message}\n`,
    );
  }
}

/** Snapshot del buffer acumulado hasta ahora. */
export function getNetLog(): NetEntry[] {
  return buffer.slice();
}

/**
 * Vacía el buffer. Lo llama `request` DESPUÉS de congelar la trace: cierra el episodio de
 * aprendizaje para que la próxima tarea arranque limpia. No se llama en discover (eso
 * perdería lo acumulado de un discover anterior de la MISMA tarea).
 */
export function clearNetLog(): void {
  buffer = [];
  seq = 0;
}

function keyOf(e: { method?: string; url?: string }): string {
  return `${(e.method ?? "GET").toUpperCase()} ${e.url ?? ""}`;
}

/** El agente histórico mandaba el network como string JSON; normalizamos a array. */
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
 * Une la captura COMPLETA del server (CDP, sobrevive redirects) con el snapshot que pasó
 * el agente (que puede traer anotaciones útiles de `role`). Dedupe por method+url: la
 * captura del server es la base y las anotaciones del agente se preservan. Devuelve un
 * array JSON limpio (de paso arregla el doble-encoding de cuando el agente mandaba string).
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
