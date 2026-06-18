import { z } from "zod";

/**
 * Esquema del Tool (spec §10.1) y del Índice (§10.3).
 *
 * Un Tool es la unidad central: una acción web modular, parametrizada y reutilizable.
 * Contiene una receta ejecutable, sus precondiciones (requires) y una aserción de
 * éxito OBLIGATORIA (la red de seguridad que reemplaza la verificación proactiva).
 *
 * En el MVP solo modelamos primitivas (type: "primitive").
 */

export const SideEffect = z.enum([
  "read",
  "write-reversible",
  "write-irreversible",
]);
export type SideEffect = z.infer<typeof SideEffect>;

// --- Recipe: la parte ejecutable -------------------------------------------------

/** Un paso Playwright. `value`/`url`/`expr` admiten placeholders {{param}}. */
export const PlaywrightStep = z.object({
  action: z.enum([
    "navigate",
    "assert_precondition",
    "click",
    "type",
    "fill",
    "press",
    "wait_for",
    "upload",
  ]),
  url: z.string().optional(),
  selector: z.string().optional(),
  value: z.string().optional(),
  /** Para assert_precondition / wait_for: selector o expresión a esperar. */
  expr: z.string().optional(),
  /** Timeout puntual en ms (default razonable en el runner). */
  timeoutMs: z.number().int().positive().optional(),
  /**
   * Si true, el paso se OMITE cuando algún {{param}} que referencia no fue provisto.
   * Sirve para pasos que dependen de un param OPCIONAL (ej. subir una imagen a un
   * tweet): con el param presente el paso corre, sin él se saltea sin romper el tool.
   */
  optional: z.boolean().optional(),
});
export type PlaywrightStep = z.infer<typeof PlaywrightStep>;

export const PlaywrightRecipe = z.object({
  kind: z.literal("playwright"),
  steps: z.array(PlaywrightStep).min(1),
});

export const HttpRecipe = z.object({
  kind: z.literal("http"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string(),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  /** Ruta JSON al dato dentro de la respuesta (ej. "data.results"). */
  jsonPath: z.string().optional(),
});

export const Recipe = z.discriminatedUnion("kind", [
  PlaywrightRecipe,
  HttpRecipe,
]);
export type Recipe = z.infer<typeof Recipe>;

// --- Precondiciones / postcondición ---------------------------------------------

export const Requires = z.object({
  /** Precondiciones de datos: params/handles. Mapa nombre → tipo descriptivo. */
  params: z.record(z.string()).default({}),
  /** Precondiciones de entorno: estado ambiente verificado por efecto (§7). */
  env: z.record(z.string()).default({}),
});

/** Lee datos del DOM (evaluate) o del JSON de la respuesta http (jsonPath). */
export const ResultExtractor = z.union([
  z.object({ type: z.literal("dom"), fn: z.string() }),
  z.object({ type: z.literal("json"), jsonPath: z.string() }),
]);
export type ResultExtractor = z.infer<typeof ResultExtractor>;

/**
 * Chequeo determinista y barato que confirma el éxito. OBLIGATORIO (§7).
 *
 * `within_ms` (dom/text): ventana de reintento. Muchos confirmadores son asíncronos
 * o transitorios (el toast "Mensaje enviado" de Gmail aparece tras el envío por red y
 * desaparece a los segundos); un único chequeo sincrónico justo tras el click los
 * pierde por carrera. Con `within_ms` el runner reintenta hasta cumplir o agotar la
 * ventana. Default razonable en el runner; subilo para confirmadores lentos.
 *
 * `text.contains` admite un string o una LISTA de alternativas (match = cualquiera):
 * robustece contra variantes de wording/idioma ("Mensaje enviado" / "Se envió el
 * mensaje" / "Message sent").
 */
export const SuccessAssertion = z.union([
  z.object({
    type: z.literal("dom"),
    expr: z.string(),
    within_ms: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("text"),
    contains: z.union([z.string(), z.array(z.string()).min(1)]),
    within_ms: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal("json"), jsonPath: z.string() }),
]);
export type SuccessAssertion = z.infer<typeof SuccessAssertion>;

// --- Tool primitivo --------------------------------------------------------------

export const ToolSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive().default(1),
  site: z.string().min(1),
  intent: z.string().min(1),
  keywords: z.array(z.string()).default([]),
  type: z.literal("primitive"),
  side_effect: SideEffect,
  requires: Requires,
  provides: z.object({ result: z.record(z.string()) }).optional(),
  recipe: Recipe,
  /** Paso a partir del cual la acción es irreversible (write-irreversible). */
  commit_step_index: z.number().int().nonnegative().optional(),
  result_extractor: ResultExtractor.optional(),
  success_assertion: SuccessAssertion, // obligatoria
  auth: z
    .object({ needs: z.string(), via: z.string() })
    .nullable()
    .optional(),
  provenance: z
    .object({
      learned_at: z.string().nullable().optional(),
      from_trace: z.string().nullable().optional(),
      source_url: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  health: z
    .object({
      last_ok: z.string().nullable().default(null),
      fail_count: z.number().int().nonnegative().default(0),
    })
    .default({ last_ok: null, fail_count: 0 }),
});
export type Tool = z.infer<typeof ToolSchema>;

// --- Composite (spec §10.2) ------------------------------------------------------

/**
 * Un paso de la cadena: corre `tool`, mapea sus inputs desde params/handles (`in`),
 * y opcionalmente guarda su resultado como un handle (`out`) que pasos siguientes
 * consumen. El pegamento es dato estable (un handle), no estado vivo del navegador.
 */
export const ChainStep = z.object({
  tool: z.string(),
  in: z.record(z.string()).default({}),
  out: z.string().optional(),
});
export type ChainStep = z.infer<typeof ChainStep>;

export const CompositeSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive().default(1),
  type: z.literal("composite"),
  site: z.string().optional(),
  intent: z.string().min(1),
  keywords: z.array(z.string()).default([]),
  params: z.record(z.string()).default({}),
  chain: z.array(ChainStep).min(1),
  provenance: z
    .object({
      learned_at: z.string().nullable().optional(),
      from_trace: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  health: z
    .object({
      last_ok: z.string().nullable().default(null),
      fail_count: z.number().int().nonnegative().default(0),
    })
    .default({ last_ok: null, fail_count: 0 }),
});
export type Composite = z.infer<typeof CompositeSchema>;

/** Cualquier item de memoria: primitiva o composite. */
export type MemoryItem = Tool | Composite;

// --- Índice ----------------------------------------------------------------------

export const IndexEntry = z.object({
  name: z.string(),
  site: z.string(),
  type: z.enum(["primitive", "composite"]),
  intent: z.string(),
  keywords: z.array(z.string()),
  /** side_effect del item; para composites es el más severo de su cadena (o read). */
  side_effect: SideEffect,
});
export type IndexEntry = z.infer<typeof IndexEntry>;

/** Valida y normaliza un objeto crudo a Tool. Lanza ZodError si es inválido. */
export function parseTool(raw: unknown): Tool {
  return ToolSchema.parse(raw);
}

export function parseComposite(raw: unknown): Composite {
  return CompositeSchema.parse(raw);
}

/** Detecta el tipo y valida con el schema correcto. */
export function parseMemoryItem(raw: unknown): MemoryItem {
  const type = (raw as { type?: string })?.type;
  return type === "composite" ? parseComposite(raw) : parseTool(raw);
}

export function isComposite(item: MemoryItem): item is Composite {
  return item.type === "composite";
}

export function toIndexEntry(item: MemoryItem): IndexEntry {
  if (isComposite(item)) {
    return {
      name: item.name,
      site: item.site ?? "",
      type: "composite",
      intent: item.intent,
      keywords: item.keywords,
      side_effect: "read", // el runner de composites calcula el real al ejecutar
    };
  }
  return {
    name: item.name,
    site: item.site,
    type: item.type,
    intent: item.intent,
    keywords: item.keywords,
    side_effect: item.side_effect,
  };
}
