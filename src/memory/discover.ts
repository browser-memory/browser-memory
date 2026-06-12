import { listIndex, normalizeSite } from "./store.js";
import type { IndexEntry, SideEffect } from "../schema/tool.js";

/**
 * Discovery: matchea POR SITIO. La entrada es una lista de sitios (ej. ["infobae"],
 * ["airbnb", "wikipedia"]) — el nombre de marca o el dominio completo, da igual.
 * Devuelve TODAS las tools de los sitios que reconozca en memoria (incluidas
 * login/auth y demás precondiciones); el agente decide cuál correr y en qué orden.
 *
 * Si ninguno de los sitios pedidos está en memoria, devuelve VACÍO: ahí no hay nada
 * aprendido → el agente explora con playwright y captura tools nuevas (request →
 * distill → save).
 *
 * No hay ranking ni score: el match es binario por sitio. El único orden es composites
 * primero (§10.2); para el resto se preserva el orden del índice. El agente elige por
 * el `intent`.
 */

export interface Candidate {
  name: string;
  type: "primitive" | "composite";
  site: string;
  intent: string;
  params: string[];
  side_effect: SideEffect;
}

// Partes de dominio que NO identifican a un sitio (TLDs y subdominios genéricos).
const GENERIC_DOMAIN_PARTS = new Set([
  "www", "com", "org", "net", "edu", "gov", "mil", "int", "info", "biz", "co",
]);

/**
 * Tokens-nombre de un sitio: sus labels significativos, sin TLD ni subdominios
 * genéricos. Ej.: "infobae.com" → ["infobae"], "es.wikipedia.org" → ["wikipedia"],
 * "news.ycombinator.com" → ["news", "ycombinator"]. Length >= 3 descarta ccTLDs
 * y raíces de una/dos letras ("es", "ar", "x") que no identifican nada.
 */
function siteNameTokens(site: string): string[] {
  return site
    .toLowerCase()
    .split(".")
    .filter((p) => p.length >= 3 && !GENERIC_DOMAIN_PARTS.has(p));
}

/** Composites primero (§10.2); estable para el resto. */
function compositesFirst(a: IndexEntry, b: IndexEntry): number {
  return (b.type === "composite" ? 1 : 0) - (a.type === "composite" ? 1 : 0);
}

function toCandidate(e: IndexEntry): Candidate {
  return {
    name: e.name,
    type: e.type,
    site: e.site,
    intent: e.intent,
    params: [], // se completa en index.ts leyendo el item (params/requires)
    side_effect: e.side_effect,
  };
}

export function discover(sites: string[]): Candidate[] {
  const requested = (sites ?? []).map(normalizeSite).filter(Boolean);
  if (requested.length === 0) return [];

  const matched: IndexEntry[] = [];
  for (const e of listIndex()) {
    if (!e.site) continue; // composites sin site declarado no son reconocibles por sitio
    const site = normalizeSite(e.site); // defensivo: por si quedara un índice sin migrar
    const hit =
      requested.includes(site) ||
      siteNameTokens(site).some((t) => requested.includes(t));
    if (hit) matched.push(e);
  }

  return matched.sort(compositesFirst).map(toCandidate);
}
