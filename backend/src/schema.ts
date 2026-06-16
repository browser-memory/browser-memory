import { z } from "zod";

/**
 * Validación LIVIANA y DUPLICADA del shape de tools/eventos.
 *
 * Es una copia consciente de src/schema/tool.ts del cliente (no compartimos código todavía
 * porque son proyectos npm separados; ver "deuda consciente" en el plan). Mantener en sync:
 * si cambia el esquema del Tool en el cliente, actualizar acá. No replicamos el lint de
 * cableado de params: eso es responsabilidad del cliente al guardar.
 */

const SideEffect = z.enum(["read", "write-reversible", "write-irreversible"]);

// Subset suficiente para validar que un Tool/Composite tiene la forma esperada antes
// de persistirlo. No reproducimos cada campo de la recipe: validamos lo estructural.
const PrimitiveToolish = z
  .object({
    name: z.string().min(1),
    version: z.number().int().positive().optional(),
    site: z.string().min(1),
    intent: z.string().min(1),
    keywords: z.array(z.string()).optional(),
    type: z.literal("primitive"),
    side_effect: SideEffect,
    requires: z.object({}).passthrough().optional(),
    recipe: z.object({ kind: z.enum(["playwright", "http"]) }).passthrough(),
    success_assertion: z.object({}).passthrough(),
  })
  .passthrough();

const CompositeToolish = z
  .object({
    name: z.string().min(1),
    version: z.number().int().positive().optional(),
    site: z.string().optional(),
    intent: z.string().min(1),
    keywords: z.array(z.string()).optional(),
    type: z.literal("composite"),
    params: z.record(z.string()).optional(),
    chain: z.array(z.object({}).passthrough()).min(1),
  })
  .passthrough();

export const ToolishSchema = z.union([PrimitiveToolish, CompositeToolish]);
export type Toolish = z.infer<typeof ToolishSchema>;

// ── Eventos de uso ────────────────────────────────────────────────────────────
// Lista blanca de campos: cualquier cosa fuera de esto se descarta (defensa contra
// que un cliente mande valores de params por error).
export const EventSchema = z
  .object({
    event_type: z.enum([
      "tool_run",
      "tool_step",
      "tool_saved",
      "tool_pulled",
      "discover_miss",
    ]),
    tool_name: z.string().optional(),
    parent_name: z.string().optional(),
    step_index: z.number().int().optional(),
    sites: z.array(z.string()).optional(),
    source: z.enum(["local", "remote"]).optional(),
    outcome: z.enum(["ok", "error"]).optional(),
    fail_mode: z.enum(["re-auth", "no-aplica", "tool-roto"]).optional(),
    param_keys: z.array(z.string()).optional(),
    item_type: z.enum(["primitive", "composite"]).optional(),
    install_id: z.string().optional(),
    client_version: z.string().optional(),
    meta: z.record(z.unknown()).optional(),
  })
  .strip(); // descarta claves desconocidas en vez de fallar
export type EventInput = z.infer<typeof EventSchema>;
