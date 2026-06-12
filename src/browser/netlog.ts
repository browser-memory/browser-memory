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
 * Para `xhr`/`fetch` (las llamadas a APIs: GraphQL, JSON, form-urlencoded) guardamos
 * ADEMÁS headers de request, body de request y body de response. Eso es lo que el
 * distiller necesita para reconstruir un **recipe HTTP directo** y replayarlo sin
 * navegador (más rápido y determinista). Para el resto de recursos (document, image,
 * css, font, script...) seguimos guardando solo method/url/status/tipo: sus cuerpos son
 * ruido pesado.
 *
 * SECRETOS: nunca se persisten. Antes de guardar, (1) los headers cuyo nombre huele a
 * credencial (cookie, authorization, *-token, *-key, *-auth...) se reemplazan por
 * "<redacted>" conservando la KEY (el distiller ve que existía sin ver el valor), y
 * (2) los bodies JSON/form se recorren redactando valores de campos sensibles
 * (password, token, secret, otp, cvv...). El resto del body —la query de búsqueda, las
 * variables de GraphQL— se conserva tal cual: no es secreto y es justo lo que hay que
 * parametrizar. La sesión sigue viviendo en el perfil de Chrome, no en la trace.
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
  /** content-type (sin parámetros) de la response. Solo xhr/fetch. */
  mime?: string;
  /** Headers de request con secretos redactados. Solo xhr/fetch. */
  reqHeaders?: Record<string, string>;
  /** Body de request (postData), capado y con secretos redactados. Solo xhr/fetch. */
  reqBody?: string;
  /** Body de response (json/text/form), capado y con secretos redactados. Solo xhr/fetch. */
  resBody?: string;
}

/** Tope de entradas para no crecer sin límite en páginas muy pesadas. */
const CAP = 4000;

/** Topes de tamaño por cuerpo (caracteres). Local y gitignored, pero no infinito. */
const REQ_BODY_CAP = 64_000;
const RES_BODY_CAP = 512_000;

/** Nombre de header que huele a credencial → se redacta el valor, se conserva la key. */
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

/** Clave de un campo (en body JSON/form) cuyo VALOR es sensible. */
const SECRET_KEY =
  /pass(word|wd)?|token|secret|otp|^pin$|cvv|card.?number|auth|session|api[-_]?key|credential/i;

export function sanitizeHeaders(h: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) {
    out[k] = isSecretHeader(k) ? "<redacted>" : v;
  }
  return out;
}

/** Redacta recursivamente valores de claves sensibles en un objeto/array JSON. */
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
 * Sanitiza un body antes de persistirlo: si es JSON o form-urlencoded, redacta los
 * valores de campos sensibles; si no lo puede parsear, lo deja como vino (capado).
 */
export function scrubBody(body: string, mime: string): string {
  const t = body.trimStart();
  if (/json|graphql/i.test(mime) || t.startsWith("{") || t.startsWith("[")) {
    try {
      return JSON.stringify(scrubJson(JSON.parse(body)));
    } catch {
      /* no era JSON válido */
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
      /* no era form-urlencoded */
    }
  }
  return body;
}

/** ¿Vale la pena guardar el cuerpo de esta response? (APIs de datos, no binarios.) */
function capturableMime(mime: string): boolean {
  return /json|graphql|x-www-form-urlencoded|xml|text\/plain/i.test(mime);
}

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

/** Solo las llamadas a APIs justifican guardar headers/body (no document/image/css...). */
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
      /* response sin cuerpo accesible (redirect, 204, ya descartado) */
    }
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
