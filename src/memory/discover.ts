import { listIndex, normalizeSite, removeItem } from "./store.js";
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
  /** De dónde salió: memoria local del usuario o el registro remoto. */
  source?: "local" | "remote";
}

// Partes de dominio que NO identifican a un sitio (TLDs y subdominios genéricos).
const GENERIC_DOMAIN_PARTS = new Set([
  "www", "com", "org", "net", "edu", "gov", "mil", "int", "info", "biz", "co",
]);

/**
 * Labels significativos de un sitio: sin esquema/www/path (normalizeSite) y sin partes
 * genéricas de dominio (TLDs, www, co...). Ej.: "infobae.com" → ["infobae"],
 * "es.wikipedia.org" → ["es", "wikipedia"], "news.ycombinator.com" → ["news",
 * "ycombinator"]. NO filtra por largo: así "x.com" → ["x"] y matchea con "x" (dominios
 * de una letra como Twitter/X). El costo es aceptar ccTLDs cortos como token ("es",
 * "io"), ruido marginal frente a soportar marcas de una letra.
 */
function siteCoreTokens(site: string): string[] {
  return normalizeSite(site)
    .split(".")
    .filter((p) => p && !GENERIC_DOMAIN_PARTS.has(p));
}

/** Composites primero (§10.2); estable para el resto. */
function compositesFirst(a: IndexEntry, b: IndexEntry): number {
  return (b.type === "composite" ? 1 : 0) - (a.type === "composite" ? 1 : 0);
}

export function toCandidate(e: IndexEntry): Candidate {
  return {
    name: e.name,
    type: e.type,
    site: e.site,
    intent: e.intent,
    params: [], // se completa en index.ts leyendo el item (params/requires)
    side_effect: e.side_effect,
    source: "local",
  };
}

/** Composites primero, estable (mismo criterio que el discover local). Reutilizable. */
export function sortCompositesFirst(list: Candidate[]): Candidate[] {
  return list.sort(
    (a, b) => (b.type === "composite" ? 1 : 0) - (a.type === "composite" ? 1 : 0),
  );
}

/** Resultado de olvidar un sitio: qué se borró de la memoria local. */
export interface ForgetResult {
  site: string;
  deleted: string[];
}

/**
 * Borra de la memoria LOCAL todas las tools del sitio pedido (mismo matching por
 * dominio/marca que `discover`). Es DIRECTO e IRREVERSIBLE: cada `removeItem` borra el
 * archivo y reindexa. No toca el registro remoto (la oferta curada es compartida y se
 * cura aparte). Si nada matchea, `deleted` viene vacío.
 */
export function forgetSite(site: string): ForgetResult {
  const deleted = discover([site]).map((c) => c.name);
  for (const name of deleted) removeItem(name);
  return { site: normalizeSite(site), deleted };
}

/** Un sitio con al menos una tool y cuántas tiene (de una fuente). */
export interface SiteSummary {
  site: string;
  count: number;
}

/**
 * Sitios que tienen al menos una tool en memoria LOCAL, con el conteo. Agrega el índice
 * por `site` normalizado (sin esquema/www/path). Composites sin `site` no se cuentan
 * (no son reconocibles por sitio). Lo usa la tool `list_sites` para responder "qué
 * sitios soportamos".
 */
export function listSites(): SiteSummary[] {
  const counts = new Map<string, number>();
  for (const e of listIndex()) {
    if (!e.site) continue;
    const site = normalizeSite(e.site);
    if (!site) continue;
    counts.set(site, (counts.get(site) ?? 0) + 1);
  }
  return [...counts.entries()].map(([site, count]) => ({ site, count }));
}

/** Un sitio soportado y de dónde salen sus tools (local, remoto o ambos). */
export interface SiteListing {
  site: string;
  source: "local" | "remote" | "both";
  tools: { local: number; remote: number };
}

/**
 * Mergea los sitios locales y remotos en una sola lista deduplicada por sitio. Marca el
 * origen (local / remote / both) y reporta el conteo de cada lado por separado (no los
 * suma: una misma tool puede estar en los dos). Ordena alfabético. Puro y testeable.
 */
export function mergeSites(local: SiteSummary[], remote: SiteSummary[]): SiteListing[] {
  const map = new Map<string, SiteListing>();
  const upsert = (rawSite: string, n: number, which: "local" | "remote"): void => {
    const site = normalizeSite(rawSite);
    if (!site) return;
    let entry = map.get(site);
    if (!entry) {
      entry = { site, source: which, tools: { local: 0, remote: 0 } };
      map.set(site, entry);
    }
    entry.tools[which] += n;
    entry.source =
      entry.tools.local > 0 && entry.tools.remote > 0
        ? "both"
        : entry.tools.local > 0
          ? "local"
          : "remote";
  };
  for (const s of local) upsert(s.site, s.count, "local");
  for (const s of remote) upsert(s.site, s.count, "remote");
  return [...map.values()].sort((a, b) => a.site.localeCompare(b.site));
}

/**
 * Compila el criterio de match POR SITIO de una request (lista de sitios pedidos) en un
 * predicado reusable. Reduce AMBOS lados al "core": el término pedido y el site comparado.
 * Así "x.com", "www.x.com" y "x" colapsan al token "x" y matchean entre sí. Es la ÚNICA
 * fuente de verdad del match por sitio: la comparten el discover local (sobre el índice en
 * disco) y la resolución de sitios remotos (`matchRemoteSites`). Si no se pidió ningún
 * sitio el predicado es siempre falso.
 */
export function siteMatcher(sites: string[]): (rawSite: string) => boolean {
  const requestedFull = new Set((sites ?? []).map(normalizeSite).filter(Boolean));
  const requestedTokens = new Set((sites ?? []).flatMap(siteCoreTokens));
  if (requestedFull.size === 0) return () => false;
  return (rawSite: string): boolean => {
    const site = normalizeSite(rawSite);
    if (!site) return false;
    return (
      requestedFull.has(site) ||
      siteCoreTokens(site).some((t) => requestedTokens.has(t))
    );
  };
}

/**
 * Dado el término pedido y una lista de sitios CANDIDATOS (ej. los sitios del registro
 * remoto, vía `fetchRemoteSites`), devuelve qué sitios candidatos matchean — MISMO criterio
 * que el discover local: dominio completo normalizado o intersección de tokens core
 * ("x" ↔ "x.com"). El server remoto filtra por sitio EXACTO (no tokeniza), así que esto le
 * traduce el término pedido a los nombres de sitio reales antes de pedir el índice. Devuelve
 * sitios normalizados y deduplicados.
 */
export function matchRemoteSites(sites: string[], candidates: string[]): string[] {
  const matches = siteMatcher(sites);
  const out = new Set<string>();
  for (const c of candidates) if (matches(c)) out.add(normalizeSite(c));
  return [...out];
}

export function discover(sites: string[]): Candidate[] {
  const matches = siteMatcher(sites);
  const matched = listIndex().filter((e) => e.site && matches(e.site));
  return matched.sort(compositesFirst).map(toCandidate);
}
