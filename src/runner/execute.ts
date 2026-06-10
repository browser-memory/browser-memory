import type { Page } from "playwright";
import { withFreshPage } from "../browser/connect.js";
import { loadTool, saveTool } from "../memory/store.js";
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
}

const DEFAULT_TIMEOUT = 15000;
/** Espera más corta para wait_for: es best-effort, no conviene bloquear 15s en vano. */
const WAIT_FOR_TIMEOUT = 6000;

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
  }
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

async function checkAssertion(
  page: Page,
  a: SuccessAssertion,
): Promise<boolean> {
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
    case "text":
      return (await page.content()).includes(a.contains);
    case "json":
      return true; // las recetas http chequean jsonPath en su propio camino
  }
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

function bumpHealth(tool: Tool, ok: boolean): void {
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
  try {
    tool = loadTool(name);
  } catch (e) {
    return {
      ok: false,
      error: { mode: "no-aplica", message: (e as Error).message },
    };
  }

  // Camino HTTP: no toca el navegador.
  if (tool.recipe.kind === "http") {
    const res = await runHttp(tool, params);
    bumpHealth(tool, res.ok);
    return res;
  }

  // Camino Playwright: pestaña fresca sobre el Chrome compartido (self-contained).
  try {
    const result = await withFreshPage(async (page) => {
      for (const step of tool.recipe.kind === "playwright" ? tool.recipe.steps : []) {
        await runPlaywrightStep(page, step, params);
      }

      // success_assertion (postcondición obligatoria).
      const ok = await checkAssertion(page, tool.success_assertion);
      if (!ok) {
        throw new TypedFail("tool-roto", "success_assertion falló");
      }

      // result_extractor para tools de lectura.
      const data = tool.result_extractor
        ? await extractDom(page, tool.result_extractor, params)
        : { ok: true };
      return data;
    });

    bumpHealth(tool, true);
    return { ok: true, result };
  } catch (e) {
    if (e instanceof TypedFail) {
      // Solo tool-roto cuenta como falla de salud: re-auth/no-aplica son del entorno,
      // no del tool, y no deben inflar fail_count ni disparar re-learn.
      if (e.mode === "tool-roto") bumpHealth(tool, false);
      return { ok: false, error: { mode: e.mode, message: e.message } };
    }
    // Cualquier otra excepción de Playwright => tool-roto (selector/timeout).
    bumpHealth(tool, false);
    return {
      ok: false,
      error: { mode: "tool-roto", message: (e as Error).message },
    };
  }
}
