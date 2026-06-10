import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { persistTrace } from "../memory/traces.js";
import { LearnInput } from "../schema/trace.js";

/**
 * learn (spec §5.3 / §9): se invoca cuando una acción se hizo por primera vez de
 * verdad y se quiere capturarla. NO bloquea: persiste la trace (congelada) y emite
 * una señal `pending_distill` que obliga al agente a spawnear un subagente en
 * background que destila la trace y guarda los tools resultantes vía el MCP (save).
 *
 * El distill corre sobre la trace congelada y NO toca el navegador.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(here, "distill-prompt.md");

function loadContract(): string {
  if (existsSync(PROMPT_PATH)) return readFileSync(PROMPT_PATH, "utf8");
  return "(contrato del distiller no encontrado; ver src/learn/distill-prompt.md)";
}

export interface LearnSignal {
  status: "pending_distill";
  trace_id: string;
  trace_path: string;
  /** Prompt autocontenido para el subagente distiller en background. */
  suggested_prompt: string;
}

export function learn(rawInput: unknown): LearnSignal {
  const input = LearnInput.parse(rawInput);
  const { id, dir } = persistTrace(input);

  const contract = loadContract();
  const suggested_prompt =
    `${contract}\n\n---\n\n` +
    `## Trace a destilar\n\n` +
    `Objetivo: ${input.goal}\n` +
    `trace_id: ${id}\n` +
    `trace_path: ${dir}\n\n` +
    `Leé los archivos de \`trace_path\` (meta.json, narration.json, network.json), ` +
    `destilá según el contrato y guardá cada tool/composite con la operación \`save\` ` +
    `del MCP tool-memory.`;

  return { status: "pending_distill", trace_id: id, trace_path: dir, suggested_prompt };
}
