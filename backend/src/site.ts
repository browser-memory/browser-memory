/**
 * Match por sitio, replicando el criterio del cliente (src/memory/store.ts:normalizeSite
 * y src/memory/discover.ts:siteNameTokens) para que el discover remoto y el local
 * reconozcan los mismos sitios. Copia consciente: mantener en sync.
 */

export function normalizeSite(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

const GENERIC_DOMAIN_PARTS = new Set([
  "www", "com", "org", "net", "edu", "gov", "mil", "int", "info", "biz", "co",
]);

function siteNameTokens(site: string): string[] {
  return site
    .toLowerCase()
    .split(".")
    .filter((p) => p.length >= 3 && !GENERIC_DOMAIN_PARTS.has(p));
}

/** ¿El `site` de una tool matchea alguno de los sitios pedidos (ya normalizados)? */
export function siteMatches(toolSite: string | null, requested: string[]): boolean {
  if (!toolSite) return false;
  const site = normalizeSite(toolSite);
  return (
    requested.includes(site) ||
    siteNameTokens(site).some((t) => requested.includes(t))
  );
}
