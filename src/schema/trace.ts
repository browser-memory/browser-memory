import { z } from "zod";

/**
 * Esquema de la Trace (spec §10.4): el registro de un run real exitoso del que se
 * aprende un tool. La arma el propio agente con narración + network + screenshots
 * (sin interceptar ni parsear formatos internos del navegador).
 */

/**
 * Un paso canónico del camino que funcionó (separado del ruido de exploración).
 * La narración es DOCUMENTACIÓN que lee el distiller, no se ejecuta — por eso el
 * schema es laxo: `action` es un label libre (navigate, click, parse, extract...) y
 * casi todo es opcional. La idea es que `learn` nunca rechace una narración razonable.
 */
export const NarrationStep = z.object({
  intent: z.string().optional(),
  action: z.string(),
  url: z.string().optional(),
  selector: z.string().optional(),
  value: z.string().optional(),
});
export type NarrationStep = z.infer<typeof NarrationStep>;

export const Narration = z.object({
  // goal/site/success_signal: opcionales. goal se completa desde el goal de learn()
  // si falta (no hace falta duplicarlo dentro de la narración).
  goal: z.string().optional(),
  site: z.string().optional(),
  outcome: z.enum(["ok", "fail"]).default("ok"),
  success_signal: z.string().optional(),
  auth: z.string().optional(),
  steps: z.array(NarrationStep).min(1),
  /** Función lectora del DOM para tools de lectura (serializada como string). */
  reader_fn: z.string().optional(),
  /** Candidato a camino HTTP directo, si network mostró un endpoint limpio. */
  api_candidate: z
    .object({
      method: z.string(),
      url: z.string(),
      jsonPath: z.string().optional(),
    })
    .nullable()
    .optional(),
});
export type Narration = z.infer<typeof Narration>;

export const TraceMeta = z.object({
  id: z.string(),
  goal: z.string(),
  outcome: z.enum(["ok", "fail"]),
  success_signal: z.string().optional(),
  site: z.string().optional(),
  ts: z.string(),
});
export type TraceMeta = z.infer<typeof TraceMeta>;

/** Payload que el agente pasa a learn() para persistir la trace. */
export const LearnInput = z.object({
  goal: z.string(),
  narration: Narration,
  /** Salida cruda de browser_network_requests (opcional). */
  network: z.unknown().optional(),
  /** Salida de browser_console_messages (opcional). */
  console: z.unknown().optional(),
});
export type LearnInput = z.infer<typeof LearnInput>;
