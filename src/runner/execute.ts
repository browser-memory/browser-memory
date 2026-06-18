import type { Page } from "playwright";
import { withFreshPage } from "../browser/connect.js";
import { saveTool } from "../memory/store.js";
import { isComposite } from "../schema/tool.js";
import { resolveItem, isRemoteSource } from "../registry/resolve.js";
import type {
  Tool,
  PlaywrightStep,
  SuccessAssertion,
  ResultExtractor,
} from "../schema/tool.js";

/**
 * Runner (spec §5.2 / §8): ejecuta un tool de forma determinista y devuelve DATOS.
 * No hay modelo en el medio. Verifica precondiciones de entorno a la entrada y la
 * success_assertion a la salida; clasifica las fallas en tres modos con su remedio.
 */

export type FailMode = "re-auth" | "no-aplica" | "tool-roto";

export interface RunResult {
  ok: boolean;
  result?: unknown;
  error?: { mode: FailMode; message: string };
  /** De dónde se resolvió el tool (para el logging). */
  source?: "local" | "remote";
}

const DEFAULT_TIMEOUT = 15000;
/** Espera más corta para wait_for: es best-effort, no conviene bloquear 15s en vano. */
const WAIT_FOR_TIMEOUT = 6000;
/**
 * Ventana por defecto de reintento del success_assertion (dom/text). El confirmador
 * de una acción suele ser asíncrono o transitorio (un toast que aparece tras un envío
 * por red y se va a los segundos); un único chequeo sincrónico lo pierde por carrera.
 * Si la assertion ya se cumple, el poll retorna en el primer intento (no agrega latencia
 * a las lecturas); solo el camino que falla espera hasta agotar la ventana.
 */
const DEFAULT_ASSERT_WINDOW = 4000;
const ASSERT_POLL_INTERVAL = 300;

/**
 * Filtros de transformación aplicables a un placeholder: {{q|kebab}}.
 * Cubren las transformaciones que un distiller suele querer expresar (y que antes
 * describía en prosa, sin que nadie las ejecutara). Mantener esta lista en sync con
 * la del linter (lint.ts).
 */
export const FILTERS: Record<string, (s: string) => string> = {
  kebab: (s) => s.trim().toLowerCase().replace(/\s+/g, "-"),
  lower: (s) => s.toLowerCase(),
  upper: (s) => s.toUpperCase(),
  encode: (s) => encodeURIComponent(s),
};

/**
 * Sustituye {{param}} (y {{param|filtro}}) en un string con los valores provistos.
 * Reemplazo literal + filtros declarados; NO evalúa código arbitrario.
 */
export function injectParams(
  template: string,
  params: Record<string, unknown>,
): string {
  return template.replace(
    /\{\{\s*([\w.]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g,
    (_, key: string, filter?: string) => {
      const v = params[key];
      if (v === undefined) {
        throw new Error(`Falta el parámetro requerido: ${key}`);
      }
      let s = String(v);
      if (filter) {
        const fn = FILTERS[filter];
        if (!fn) throw new Error(`Filtro desconocido en {{${key}|${filter}}}`);
        s = fn(s);
      }
      return s;
    },
  );
}

/** Heurística: ¿esta URL/página es un login? (precondición de entorno por efecto). */
function looksLikeLogin(url: string): boolean {
  return /\/(login|signin|sign-in|auth|sso)(\b|\/|\?)/i.test(url);
}

// --- ejecución de recipes --------------------------------------------------------

async function runPlaywrightStep(
  page: Page,
  step: PlaywrightStep,
  params: Record<string, unknown>,
): Promise<void> {
  const timeout = step.timeoutMs ?? DEFAULT_TIMEOUT;
  switch (step.action) {
    case "navigate":
      await page.goto(injectParams(step.url!, params), {
        waitUntil: "domcontentloaded",
        timeout,
      });
      return;
    case "assert_precondition": {
      // Precondición de entorno: el selector/expr esperado debe existir. Si la
      // página redirigió a login => re-auth; si simplemente no aparece => no-aplica.
      const expr = injectParams(step.expr ?? step.selector!, params);
      try {
        await page.waitForSelector(expr, { timeout, state: "attached" });
      } catch {
        if (looksLikeLogin(page.url())) {
          throw new TypedFail("re-auth", `sesión requerida en ${page.url()}`);
        }
        throw new TypedFail("no-aplica", `no se cumple la precondición: ${expr}`);
      }
      return;
    }
    case "click":
      await page.click(injectParams(step.selector!, params), { timeout });
      return;
    case "type":
      await page.fill(
        injectParams(step.selector!, params),
        injectParams(step.value ?? "", params),
        { timeout },
      );
      return;
    case "fill":
      await page.fill(
        injectParams(step.selector!, params),
        injectParams(step.value ?? "", params),
        { timeout },
      );
      return;
    case "press":
      await page.press(
        injectParams(step.selector!, params),
        injectParams(step.value!, params),
        { timeout },
      );
      return;
    case "wait_for": {
      // BEST-EFFORT: el wait_for es una optimización (esperar contenido dinámico), NO
      // un portón de correctitud. Si el selector no aparece, NO matamos el tool: el
      // juez real es el success_assertion. Esto evita que un selector de espera
      // demasiado específico (ej. un regex de texto que no matchea por idioma/formato)
      // tire timeout y rompa un tool que igual podía extraer el dato.
      // `attached` (no `visible`): alcanza con que esté en el DOM.
      const waitTimeout = step.timeoutMs ?? WAIT_FOR_TIMEOUT;
      try {
        await page.waitForSelector(injectParams(step.expr ?? step.selector!, params), {
          timeout: waitTimeout,
          state: "attached",
        });
      } catch {
        // seguimos: el success_assertion confirmará si el dato está o no.
      }
      return;
    }
    case "upload": {
      // Sube archivo(s) a un <input type=file> (ej. la imagen de un tweet). `value` es
      // la(s) ruta(s) local(es), separadas por '\n', y admite {{param}}. setInputFiles
      // funciona aun con el input oculto (X lo esconde detrás del botón de media).
      const paths = injectParams(step.value ?? "", params)
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
      await page.setInputFiles(injectParams(step.selector!, params), paths, {
        timeout,
      });
      return;
    }
  }
}

/**
 * ¿Hay que OMITIR este paso? Solo los marcados `optional` que referencian un {{param}}
 * no provisto: ese es el mecanismo para pasos que dependen de un input opcional (ej.
 * subir una imagen). Un paso no-opcional con un param faltante NO se saltea: deja que
 * injectParams tire el error y el run falle como corresponde.
 */
export function skipOptionalStep(
  step: PlaywrightStep,
  params: Record<string, unknown>,
): boolean {
  if (!step.optional) return false;
  for (const text of [step.url, step.selector, step.value, step.expr]) {
    if (!text) continue;
    try {
      injectParams(text, params);
    } catch {
      return true; // falta un param del paso opcional → lo salteamos
    }
  }
  return false;
}

class TypedFail extends Error {
  constructor(public mode: FailMode, message: string) {
    super(message);
  }
}

async function extractDom(
  page: Page,
  ex: ResultExtractor,
  params: Record<string, unknown>,
): Promise<unknown> {
  if (ex.type === "dom") {
    // La fn es una función JS serializada; la evaluamos en el contexto de la página.
    // Firma canónica: (root, params). Pasamos `document` como raíz y los params del
    // run serializados como literal JSON — así el extractor puede filtrar por la query
    // (params.q) sin depender de variables libres mágicas, y sin usar eval/Function en
    // la página (que el CSP de muchos sitios bloquea).
    const paramsLiteral = JSON.stringify(params ?? {});
    return page.evaluate(`(${ex.fn})(document, ${paramsLiteral})`);
  }
  return undefined;
}

/** Alternativas de texto: `contains` puede ser un string o una lista (match = cualquiera). */
function textAlternatives(a: Extract<SuccessAssertion, { type: "text" }>): string[] {
  return Array.isArray(a.contains) ? a.contains : [a.contains];
}

/** Describe en prosa qué esperaba la assertion (para el detalle de la falla). */
function describeAssertion(a: SuccessAssertion): string {
  switch (a.type) {
    case "dom":
      return `que la página tuviera el elemento/expresión \`${a.expr}\``;
    case "text":
      return `que la página contuviera el texto ${textAlternatives(a)
        .map((t) => `"${t}"`)
        .join(" o ")}`;
    case "json":
      return `que el jsonPath \`${a.jsonPath}\` tuviera valor`;
  }
}

/** Evalúa la assertion UNA vez (sin reintentos). */
async function assertionHolds(page: Page, a: SuccessAssertion): Promise<boolean> {
  switch (a.type) {
    case "dom":
      // `expr` puede ser un selector CSS (presencia = éxito) o una expresión JS
      // booleana (ej. "document.querySelector(...) !== null"). Probamos como CSS y,
      // si no parsea como selector, la evaluamos como JS en la página.
      try {
        return (await page.$(a.expr)) !== null;
      } catch {
        return Boolean(await page.evaluate(a.expr));
      }
    case "text": {
      const html = await page.content();
      return textAlternatives(a).some((t) => html.includes(t));
    }
    case "json":
      return true; // las recetas http chequean jsonPath en su propio camino
  }
}

export interface AssertionResult {
  ok: boolean;
  /** SIEMPRE explica qué se esperaba y qué se vio cuando falla (ok=false). */
  detail: string;
}

/**
 * Postcondición con ventana de reintento. Poll hasta `within_ms` (default
 * DEFAULT_ASSERT_WINDOW) para tolerar confirmadores asíncronos/transitorios. Cuando
 * falla, arma un detalle accionable: qué se esperaba, cuánto se esperó, y el estado
 * real de la página (url + título) para distinguir un tool roto de un re-auth/redirect.
 */
async function checkAssertion(
  page: Page,
  a: SuccessAssertion,
): Promise<AssertionResult> {
  if (a.type === "json") return { ok: true, detail: "" };

  const within = a.within_ms ?? DEFAULT_ASSERT_WINDOW;
  const deadline = Date.now() + within;
  for (;;) {
    if (await assertionHolds(page, a)) return { ok: true, detail: "" };
    const left = deadline - Date.now();
    if (left <= 0) break;
    await page.waitForTimeout(Math.min(ASSERT_POLL_INTERVAL, left));
  }

  // Estado real de la página, defensivo (la página puede haberse cerrado/navegado).
  let url = "";
  let title = "";
  try {
    url = page.url();
  } catch {
    /* ignore */
  }
  try {
    title = await page.title();
  } catch {
    /* ignore */
  }
  const waited = within > 0 ? ` (reintenté ${within}ms)` : "";
  const detail =
    `se esperaba ${describeAssertion(a)}, pero no se cumplió${waited}. ` +
    `Página al fallar: url=${url || "?"} título="${title}". ` +
    `Si la acción igual ocurrió, la assertion quedó corta (toast transitorio o ` +
    `wording distinto); si la página es un login, es re-auth, no tool roto.`;
  return { ok: false, detail };
}

// --- HTTP path -------------------------------------------------------------------

function getJsonPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((acc, k) => {
    if (acc && typeof acc === "object") return (acc as Record<string, unknown>)[k];
    return undefined;
  }, obj);
}

async function runHttp(
  tool: Tool,
  params: Record<string, unknown>,
): Promise<RunResult> {
  if (tool.recipe.kind !== "http") throw new Error("recipe no es http");
  const r = tool.recipe;
  const url = injectParams(r.url, params);
  const headers = Object.fromEntries(
    Object.entries(r.headers ?? {}).map(([k, v]) => [k, injectParams(v, params)]),
  );
  const body = r.body ? injectParams(r.body, params) : undefined;

  const res = await fetch(url, { method: r.method, headers, body });
  if (!res.ok) {
    if (res.status === 401 || res.status === 403) {
      return { ok: false, error: { mode: "re-auth", message: `HTTP ${res.status}` } };
    }
    return { ok: false, error: { mode: "tool-roto", message: `HTTP ${res.status}` } };
  }
  const json = await res.json();
  const result = r.jsonPath ? getJsonPath(json, r.jsonPath) : json;

  if (result === undefined || result === null) {
    return {
      ok: false,
      error: { mode: "tool-roto", message: `jsonPath vacío: ${r.jsonPath}` },
    };
  }
  return { ok: true, result };
}

// --- entrypoint ------------------------------------------------------------------

/**
 * Persiste la salud del tool. NO-OP para tools remotas: la Opción A las mantiene efímeras
 * (no deben crear el archivo local en tools/); su salud se infiere server-side de los
 * eventos `tool_run`.
 */
function bumpHealth(tool: Tool, ok: boolean, remote: boolean): void {
  if (remote) return;
  const nowIso = new Date().toISOString();
  const health = ok
    ? { last_ok: nowIso, fail_count: 0 }
    : { last_ok: tool.health.last_ok, fail_count: tool.health.fail_count + 1 };
  saveTool({ ...tool, health });
}

export async function run(
  name: string,
  params: Record<string, unknown> = {},
): Promise<RunResult> {
  let tool: Tool;
  let remote = false;
  try {
    // Resolución unificada (Opción A): disco local → cache memoria → pull remoto.
    const resolved = await resolveItem(name);
    if (isComposite(resolved.item)) {
      return {
        ok: false,
        error: { mode: "no-aplica", message: `${name} es composite, no primitiva` },
        source: isRemoteSource(resolved.source) ? "remote" : "local",
      };
    }
    tool = resolved.item;
    remote = isRemoteSource(resolved.source);
  } catch (e) {
    return {
      ok: false,
      error: { mode: "no-aplica", message: (e as Error).message },
    };
  }
  const source: "local" | "remote" = remote ? "remote" : "local";

  // Camino HTTP: no toca el navegador.
  if (tool.recipe.kind === "http") {
    const res = await runHttp(tool, params);
    bumpHealth(tool, res.ok, remote);
    return { ...res, source };
  }

  // Camino Playwright: pestaña fresca sobre el Chrome compartido (self-contained).
  try {
    const result = await withFreshPage(async (page) => {
      for (const step of tool.recipe.kind === "playwright" ? tool.recipe.steps : []) {
        if (skipOptionalStep(step, params)) continue;
        await runPlaywrightStep(page, step, params);
      }

      // success_assertion (postcondición obligatoria).
      const check = await checkAssertion(page, tool.success_assertion);
      if (!check.ok) {
        throw new TypedFail("tool-roto", `success_assertion falló: ${check.detail}`);
      }

      // result_extractor para tools de lectura.
      const data = tool.result_extractor
        ? await extractDom(page, tool.result_extractor, params)
        : { ok: true };
      return data;
    });

    bumpHealth(tool, true, remote);
    return { ok: true, result, source };
  } catch (e) {
    if (e instanceof TypedFail) {
      // Solo tool-roto cuenta como falla de salud: re-auth/no-aplica son del entorno,
      // no del tool, y no deben inflar fail_count ni disparar re-learn.
      if (e.mode === "tool-roto") bumpHealth(tool, false, remote);
      return { ok: false, error: { mode: e.mode, message: e.message }, source };
    }
    // Cualquier otra excepción de Playwright => tool-roto (selector/timeout).
    bumpHealth(tool, false, remote);
    return {
      ok: false,
      error: { mode: "tool-roto", message: (e as Error).message },
      source,
    };
  }
}
