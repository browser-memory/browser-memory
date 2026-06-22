import type { Tool } from "../schema/tool.js";

/**
 * STATIC validation of a primitive tool: it doesn't execute anything, doesn't touch the browser.
 *
 * Reason for being (§7, complement of the smoke-run): the smoke-run can only run read
 * tools — a `write-irreversible` (sending an email, paying) can't be "tested"
 * without causing the effect. The static check covers that gap: it catches the most
 * painful class of bug —badly wired params— without depending on execution.
 *
 * It detects exactly what slipped past the distiller in the mercadolibre tool:
 *  - placeholders with a single brace ({q} instead of {{q}}) → never interpolated.
 *  - declared params that aren't used anywhere.
 *  - unknown placeholder filters.
 *  - extractors that reference a "bare" param instead of reading it from the `params` arg.
 */

/** Keep in sync with FILTERS in runner/execute.ts. */
const KNOWN_FILTERS = ["kebab", "lower", "upper", "encode"];

/** Gathers all the interpolable strings of the recipe (where the {{param}} go). */
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

/**
 * Gathers the strings the runner passes to Playwright as a SELECTOR (not as a value):
 * the `selector` of click/type/fill/press, the `expr`/`selector` of wait_for/
 * assert_precondition, and the `expr` of a dom-type success_assertion (goes to `page.$`).
 */
function selectorStrings(tool: Tool): string[] {
  const sels: string[] = [];
  if (tool.recipe.kind === "playwright") {
    for (const s of tool.recipe.steps) {
      if (s.action === "wait_for" || s.action === "assert_precondition") {
        const v = s.expr ?? s.selector;
        if (v) sels.push(v);
      } else if (s.selector) {
        sels.push(s.selector);
      }
    }
  }
  if (tool.success_assertion.type === "dom") sels.push(tool.success_assertion.expr);
  return sels;
}

/**
 * Accessibility snapshot notation (role + accessible name): `button "Enviar"`,
 * `textbox "Asunto"`. It's NOT CSS — `page.click` passes it to the CSS parser, the quote
 * breaks it and the tool comes out `tool-broken` on the first run (no smoke net for writes).
 * Heuristic: an initial word followed by a quoted string. It doesn't match real
 * CSS (`div[role="button"]`, `[aria-label="x"]`, `.clase`, `#id`): there the quote goes
 * inside `[...]`, never attached to a bare token at the start.
 */
const SNAPSHOT_REF = /^\s*[a-zA-Z][\w-]*\s+["']/;

/** Returns the list of problems (empty = healthy tool). */
export function lintTool(tool: Tool): string[] {
  const problems: string[] = [];
  const declared = Object.keys(tool.requires.params);
  const allText = recipeTexts(tool).join("\n");
  const fn = tool.result_extractor?.type === "dom" ? tool.result_extractor.fn : "";

  // 1. well-formed {{param}} placeholders: register them and validate the filter.
  const usedInRecipe = new Set<string>();
  for (const m of allText.matchAll(/\{\{\s*([\w.]+)\s*(?:\|\s*(\w+)\s*)?\}\}/g)) {
    usedInRecipe.add(m[1]);
    if (m[2] && !KNOWN_FILTERS.includes(m[2])) {
      problems.push(
        `unknown filter in {{${m[1]}|${m[2]}}} (valid: ${KNOWN_FILTERS.join(", ")})`,
      );
    }
  }

  // 2. single brace {param} that isn't {{param}} → malformed placeholder: not interpolated.
  for (const m of allText.matchAll(/(?<!\{)\{([\w.]+)\}(?!\})/g)) {
    problems.push(
      `single-brace placeholder: {${m[1]}} — did you mean {{${m[1]}}}? (not interpolated)`,
    );
  }

  // 3. the extractor reads a param via the `params` arg (params.q / params['q']).
  const readsFromParams = (p: string): boolean =>
    new RegExp(`params\\s*(?:\\.\\s*${p}\\b|\\[\\s*['"]${p}['"]\\s*\\])`).test(fn);

  // 4. every declared param has to be used somewhere (recipe or extractor).
  for (const p of declared) {
    if (!usedInRecipe.has(p) && !readsFromParams(p)) {
      problems.push(
        `the param '${p}' is declared but isn't used in the recipe or the extractor`,
      );
    }
  }

  // 5. the extractor references a "bare" param (free variable) without reading it from params:
  //    a sign the distiller expected to receive it as a variable, not via the 2nd arg.
  for (const p of declared) {
    if (!fn) continue;
    const usesBare = new RegExp(`(?<![\\w.$])${p}\\b`).test(fn);
    if (usesBare && !readsFromParams(p)) {
      problems.push(
        `the extractor uses '${p}' bare; params arrive as the 2nd argument — use params.${p}`,
      );
    }
  }

  // 6. selectors in snapshot notation (role + name) instead of CSS: they break
  //    Playwright's CSS parser on the first run. The smoke-run doesn't cover writes.
  for (const sel of selectorStrings(tool)) {
    if (SNAPSHOT_REF.test(sel)) {
      problems.push(
        `selector in snapshot notation, not CSS: \`${sel}\` — convert it to a ` +
          `real CSS selector (aria-label, class, attribute), e.g. \`[aria-label="..."]\``,
      );
    }
  }

  return problems;
}
