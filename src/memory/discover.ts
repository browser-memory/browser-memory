import { listIndex } from "./store.js";
import type { IndexEntry, SideEffect } from "../schema/tool.js";

/**
 * Discovery (spec §11.3): matchea el goal en lenguaje natural contra el índice por
 * dominio + overlap de keywords + fuzzy sobre intent. Sin embeddings (se suman solo
 * si el matcheo por palabras queda corto).
 */

export interface Candidate {
  name: string;
  type: "primitive" | "composite";
  score: number;
  site: string;
  intent: string;
  params: string[];
  side_effect: SideEffect;
}

const STOP = new Set([
  "el", "la", "los", "las", "un", "una", "de", "del", "en", "a", "y", "o",
  "para", "con", "que", "the", "a", "an", "of", "in", "to", "and", "or",
]);

function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "") // saca acentos
    .split(/[^a-z0-9.]+/)
    .filter((t) => t.length > 1 && !STOP.has(t));
}

/** Substring fuzzy: cuántos tokens del goal aparecen dentro del intent. */
function intentOverlap(goalTokens: string[], intent: string): number {
  const i = intent.toLowerCase();
  let hits = 0;
  for (const t of goalTokens) if (i.includes(t)) hits++;
  return goalTokens.length ? hits / goalTokens.length : 0;
}

function scoreEntry(goalTokens: string[], goalRaw: string, e: IndexEntry): number {
  const kw = new Set(e.keywords.map((k) => k.toLowerCase()));
  const kwHits = goalTokens.filter((t) => kw.has(t)).length;
  const kwScore = kw.size ? kwHits / Math.max(goalTokens.length, 1) : 0;

  // Dominio: si el goal menciona el sitio (o su raíz sin TLD), peso fuerte.
  const siteRoot = e.site.split(".")[0];
  const domainBonus =
    goalRaw.toLowerCase().includes(e.site) ||
    goalTokens.includes(siteRoot)
      ? 0.4
      : 0;

  const intentScore = intentOverlap(goalTokens, e.intent);

  // Combinación simple y legible. domainBonus es aditivo y se clampa a 1.
  const score = Math.min(1, 0.5 * kwScore + 0.3 * intentScore + domainBonus);
  return score;
}

export function discover(goal: string, limit = 5): Candidate[] {
  const goalTokens = tokenize(goal);
  const index = listIndex();

  return index
    .map((e) => ({ e, score: scoreEntry(goalTokens, goal, e) }))
    .filter(({ score }) => score > 0.1)
    // Composites primero (spec §10.2): ante igualdad, gana el composite; además un
    // pequeño boost para que un composite que matchea supere a su primitiva par.
    .sort((a, b) => {
      const sa = a.score + (a.e.type === "composite" ? 0.05 : 0);
      const sb = b.score + (b.e.type === "composite" ? 0.05 : 0);
      return sb - sa;
    })
    .slice(0, limit)
    .map(({ e, score }) => ({
      name: e.name,
      type: e.type,
      score: Number(score.toFixed(3)),
      site: e.site,
      intent: e.intent,
      params: [], // se completa en index.ts leyendo el item (params/requires)
      side_effect: e.side_effect,
    }));
}
