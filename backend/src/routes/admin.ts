import { Router } from "express";
import { supabase } from "../supabase.js";
import { adminAuth } from "../middleware/adminAuth.js";
import { ToolishSchema } from "../schema.js";

/**
 * Endpoints admin (protegidos por x-admin-key). Complementan al Supabase Table Editor:
 * el Table Editor es la vía cómoda para curar a mano; estos endpoints son la vía
 * programática. El trigger SQL recalcula las columnas de búsqueda desde `definition`.
 */
export const adminRouter = Router();
adminRouter.use(adminAuth);

// Lista TODAS las tools (incluidas las deshabilitadas) para administración.
adminRouter.get("/tools", async (_req, res) => {
  const { data, error } = await supabase
    .from("tools")
    .select("name, site, type, intent, side_effect, enabled, version, updated_at")
    .order("updated_at", { ascending: false });
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ tools: data ?? [] });
});

// Crea o reemplaza (upsert por name) una tool curada.
adminRouter.post("/tools", async (req, res) => {
  const parsed = ToolishSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "tool inválida", detail: parsed.error.issues });
    return;
  }
  const tool = parsed.data;
  const { data, error } = await supabase
    .from("tools")
    // El trigger sobreescribe name/site/type/... desde definition; pasamos name para el onConflict.
    .upsert({ name: tool.name, definition: tool }, { onConflict: "name" })
    .select("name, type, version")
    .single();
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ saved: data });
});

// Edición parcial: enabled (despublicar) y/o definition (reemplazo de la receta).
adminRouter.patch("/tools/:name", async (req, res) => {
  const patch: Record<string, unknown> = {};
  if (typeof req.body?.enabled === "boolean") patch.enabled = req.body.enabled;
  if (req.body?.definition !== undefined) {
    const parsed = ToolishSchema.safeParse(req.body.definition);
    if (!parsed.success) {
      res.status(400).json({ error: "definition inválida", detail: parsed.error.issues });
      return;
    }
    patch.definition = parsed.data;
  }
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ error: "nada para actualizar (enviá enabled y/o definition)" });
    return;
  }
  const { data, error } = await supabase
    .from("tools")
    .update(patch)
    .eq("name", req.params.name)
    .select("name, type, version, enabled")
    .maybeSingle();
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  if (!data) {
    res.status(404).json({ error: "tool no encontrada" });
    return;
  }
  res.json({ updated: data });
});

// Borrado: por default soft (enabled=false). ?hard=true borra de verdad.
adminRouter.delete("/tools/:name", async (req, res) => {
  const hard = String(req.query.hard ?? "") === "true";
  const q = hard
    ? supabase.from("tools").delete().eq("name", req.params.name)
    : supabase.from("tools").update({ enabled: false }).eq("name", req.params.name);
  const { error } = await q;
  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  res.json({ removed: req.params.name, hard });
});
