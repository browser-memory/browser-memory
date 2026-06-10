import type { Tool } from "../schema/tool.js";

/**
 * Validación ESTÁTICA de un tool primitivo: no ejecuta nada, no toca el navegador.
 *
 * Razón de ser (§7, complemento del smoke-run): el smoke-run sólo puede correr tools
 * de lectura — un `write-irreversible` (mandar un mail, pagar) no se puede "probar"
 * sin causar el efecto. La estática cubre ese hueco: atrapa la clase de bug que más
 * duele —parámetros mal cableados— sin depender de ejecutar.
 *
 * Detecta exactamente lo que se le escapó al distiller del tool de mercadolibre:
 *  - placeholders con una sola llave ({q} en vez de {{q}}) → nunca se interpolan.
 *  - params declarados que no se usan en ningún lado.
 *  - filtros de placeholder desconocidos.
 *  - extractores que referencian un param "suelto" en vez de leerlo del arg `params`.
 */

/** Mantener en sync con FILTERS de runner/execute.ts. */
const KNOWN_FILTERS = ["kebab", "lower", "upper", "encode"];

/** Junta todos los strings interpolables de la recipe (donde van los {{param}}). */
function recipeTexts(tool: Tool): string[] {
  const texts: string[] = [];
  if (tool.recipe.kind === "playwright") {
    for (const s of tool.recipe.steps) {
      for (const v of [s.url, s.selector, s.value, s.expr]) if (v) texts.push(v);
    }
  } else {
    texts.push(tool.recipe.url, tool.recipe.body ?? "");
    for (const v of Object.values(tool.recipe.headers ?? {})) texts.push(v);
  }
  return texts.filter(Boolean);
}

/** Devuelve la lista de problemas (vacía = tool sano). */
export function lintTool(tool: Tool): string[] {
  const problems: string[] = [];
  const declared = Object.keys(tool.requires.params);
  const allText = recipeTexts(tool).join("\n");
  const fn = tool.result_extractor?.type === "dom" ? tool.result_extractor.fn : "";

  // 1. placeholders {{param}} bien formados: registralos y validá el filtro.
  const usedInRecipe = new Set<string>();
  for (const m of allText.matchAll(/\{\{\s*([\w.]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g)) {
    usedInRecipe.add(m[1]);
    if (m[2] && !KNOWN_FILTERS.includes(m[2])) {
      problems.push(
        `filtro desconocido en {{${m[1]}|${m[2]}}} (válidos: ${KNOWN_FILTERS.join(", ")})`,
      );
    }
  }

  // 2. llave simple {param} que no sea {{param}} → placeholder malformado: no se interpola.
  for (const m of allText.matchAll(/(?<!\{)\{([\w.]+)\}(?!\})/g)) {
    problems.push(
      `placeholder con una sola llave: {${m[1]}} — ¿quisiste {{${m[1]}}}? (no se interpola)`,
    );
  }

  // 3. el extractor lee un param vía el arg `params` (params.q / params['q']).
  const readsFromParams = (p: string): boolean =>
    new RegExp(`params\\s*(?:\\.\\s*${p}\\b|\\[\\s*['"]${p}['"]\\s*\\])`).test(fn);

  // 4. todo param declarado tiene que usarse en algún lado (recipe o extractor).
  for (const p of declared) {
    if (!usedInRecipe.has(p) && !readsFromParams(p)) {
      problems.push(
        `el param '${p}' está declarado pero no se usa en la recipe ni en el extractor`,
      );
    }
  }

  // 5. el extractor referencia un param "suelto" (variable libre) sin leerlo de params:
  //    señal de que el distiller esperaba recibirlo como variable, no por el 2º arg.
  for (const p of declared) {
    if (!fn) continue;
    const usesBare = new RegExp(`(?<![\\w.$])${p}\\b`).test(fn);
    if (usesBare && !readsFromParams(p)) {
      problems.push(
        `el extractor usa '${p}' suelto; los params llegan como 2º argumento — usá params.${p}`,
      );
    }
  }

  return problems;
}
