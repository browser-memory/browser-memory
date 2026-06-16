import { Router } from "express";
import { supabase } from "../supabase.js";
import { siteMatches, normalizeSite } from "../site.js";

/**
 * Endpoints públicos que consume el cliente MCP:
 *  - GET /sites             → sitios distintos que tienen al menos una tool (con conteo)
 *  - GET /index?sites=a,b   → índice (sin recipe) de las tools de esos sitios
 *  - GET /tool/:name        → el definition COMPLETO de una tool (para bajar a memoria)
 * (la ingesta de eventos vive en routes/events.ts, montada en /v1/events)
 */
export const registryRouter = Router();

registryRouter.get("/sites", async (_req, res) => {
  const { data, error } = await supabase
    .from("tools")
    .select("site")
    .eq("enabled", true);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Agregamos por sitio normalizado (mismo criterio que el cliente local).
  const counts = new Map<string, number>();
  for (const t of data ?? []) {
    if (!t.site) continue;
    const site = normalizeSite(t.site);
    if (!site) continue;
    counts.set(site, (counts.get(site) ?? 0) + 1);
  }
  const sites = [...counts.entries()]
    .map(([site, count]) => ({ site, count }))
    .sort((a, b) => a.site.localeCompare(b.site));

  res.json({ sites });
});

/** Nombres de params de una tool, sin valores (para enriquecer el discover). */
function paramNames(def: any): string[] {
  if (!def) return [];
  if (def.type === "composite") return Object.keys(def.params ?? {});
  return Object.keys(def.requires?.params ?? {});
}

registryRouter.get("/index", async (req, res) => {
  const raw = String(req.query.sites ?? "").trim();
  const requested = raw
    .split(",")
    .map((s) => normalizeSite(s))
    .filter(Boolean);
  if (requested.length === 0) {
    res.json({ entries: [] });
    return;
  }

  const { data, error } = await supabase
    .from("tools")
    .select("name, site, type, intent, keywords, side_effect, definition")
    .eq("enabled", true);

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }

  // Filtramos por sitio con el MISMO criterio que el discover local (tokens de dominio).
  const entries = (data ?? [])
    .filter((t) => siteMatches(t.site, requested))
    .map((t) => ({
      name: t.name,
      site: t.site ?? "",
      type: t.type,
      intent: t.intent,
      keywords: t.keywords ?? [],
      side_effect: t.side_effect,
      params: paramNames(t.definition),
    }));

  res.json({ entries });
});

registryRouter.get("/tool/:name", async (req, res) => {
  const { data, error } = await supabase
    .from("tools")
    .select("definition")
    .eq("name", req.params.name)
    .eq("enabled", true)
    .maybeSingle();

  if (error) {
    res.status(500).json({ error: error.message });
    return;
  }
  if (!data) {
    res.status(404).json({ error: "tool no encontrada" });
    return;
  }
  res.json({ tool: data.definition });
});
