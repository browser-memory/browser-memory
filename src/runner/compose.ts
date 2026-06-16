import { run, injectParams, type RunResult } from "./execute.js";
import { resolveItem } from "../registry/resolve.js";
import { logEvent } from "../registry/log.js";
import { isComposite } from "../schema/tool.js";
import type { ChainStep, Composite } from "../schema/tool.js";

/**
 * Runner de composites (spec §10.2 / §4): corre cada tool de la cadena en orden,
 * mapea out → in (el pegamento es un handle, dato estable), y ABORTA la cadena si
 * una precondición de entrada falla, reportando en qué paso. Cada tool es
 * self-contained: re-establece su contexto navegando al handle que recibe.
 *
 * (E4 = composición. La auto-reparación / re-learn queda fuera de alcance.)
 */

export interface ComposeStepResult {
  tool: string;
  ok: boolean;
  out?: { name: string; value: unknown };
  error?: RunResult["error"];
}

export interface ComposeResult {
  ok: boolean;
  steps: ComposeStepResult[];
  /** handles acumulados al final (params + outs). */
  handles: Record<string, unknown>;
  /** paso donde abortó, si abortó. */
  aborted_at?: { index: number; tool: string };
}

/**
 * Extrae el valor del handle `out` desde el resultado de un tool. Si el resultado
 * es un objeto con una clave igual al nombre del handle, usa ese campo; si no, usa
 * el resultado entero (handle escalar, ej. una URL).
 */
function extractHandle(result: unknown, outName: string): unknown {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    if (outName in obj) return obj[outName];
  }
  return result;
}

/** Resuelve los inputs de un paso desde los handles disponibles (params + outs). */
function resolveInputs(
  stepIn: ChainStep["in"],
  handles: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [param, template] of Object.entries(stepIn)) {
    resolved[param] = injectParams(template, handles);
  }
  return resolved;
}

export async function runComposite(
  name: string,
  params: Record<string, unknown> = {},
): Promise<ComposeResult> {
  const handles: Record<string, unknown> = { ...params };
  const steps: ComposeStepResult[] = [];

  // Resolución unificada (Opción A): un composite también puede vivir en el server.
  let composite: Composite;
  try {
    const resolved = await resolveItem(name);
    if (!isComposite(resolved.item)) {
      return {
        ok: false,
        steps: [
          { tool: name, ok: false, error: { mode: "no-aplica", message: `${name} no es composite` } },
        ],
        handles,
      };
    }
    composite = resolved.item;
  } catch (e) {
    return {
      ok: false,
      steps: [{ tool: name, ok: false, error: { mode: "no-aplica", message: (e as Error).message } }],
      handles,
    };
  }

  for (let i = 0; i < composite.chain.length; i++) {
    const link = composite.chain[i];

    let inputs: Record<string, unknown>;
    try {
      inputs = resolveInputs(link.in, handles);
    } catch (e) {
      // Falta un handle que un paso anterior debió producir → abortamos.
      steps.push({
        tool: link.tool,
        ok: false,
        error: { mode: "no-aplica", message: (e as Error).message },
      });
      return { ok: false, steps, handles, aborted_at: { index: i, tool: link.tool } };
    }

    const res = await run(link.tool, inputs);
    // Un evento por paso de la cadena (granularidad pedida): mide qué primitiva falla.
    logEvent({
      event_type: "tool_step",
      tool_name: link.tool,
      parent_name: name,
      step_index: i,
      source: res.source ?? "local",
      outcome: res.ok ? "ok" : "error",
      fail_mode: res.error?.mode,
      param_keys: Object.keys(inputs),
    });
    if (!res.ok) {
      // Precondición o ejecución falló: abortamos la cadena reportando dónde.
      steps.push({ tool: link.tool, ok: false, error: res.error });
      return { ok: false, steps, handles, aborted_at: { index: i, tool: link.tool } };
    }

    const stepResult: ComposeStepResult = { tool: link.tool, ok: true };
    if (link.out) {
      const value = extractHandle(res.result, link.out);
      handles[link.out] = value;
      stepResult.out = { name: link.out, value };
    }
    steps.push(stepResult);
  }

  return { ok: true, steps, handles };
}
