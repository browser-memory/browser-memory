import { Router } from "express";
import { supabase } from "../supabase.js";
import { EventSchema } from "../schema.js";

/**
 * Ingesta de eventos de uso (logging). Montado en /v1/events.
 * El esquema descarta claves desconocidas (.strip): nunca entran valores de params.
 */
export const eventsRouter = Router();

eventsRouter.post("/", async (req, res) => {
  const parsed = EventSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "evento inválido", detail: parsed.error.issues });
    return;
  }
  const { error } = await supabase.from("events").insert(parsed.data);
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.status(202).json({ ok: true });
});
