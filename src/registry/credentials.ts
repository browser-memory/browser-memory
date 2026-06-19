import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "../config.js";

/**
 * Persistencia de la API key del registry remoto en ~/.tool-memory/credentials.json.
 * Una key por usuario, emitida por el device-code login (src/registry/device-auth.ts).
 * Mismo patrón que install-id.ts: cache en memoria + lazy read + fallback si el FS es
 * read-only (la key queda solo en el proceso). NO confundir con paths.creds, que guarda
 * secretos de SITIOS. La key nunca se escribe en logs.
 */
interface CredsFile {
  api_key: string;
  issued_at?: string;
}

let cached: string | null = null;

/** Lee la key cacheada o del disco. `null` si no hay login previo. */
export function readApiKey(): string | null {
  if (cached) return cached;
  try {
    if (existsSync(paths.auth)) {
      const raw = JSON.parse(readFileSync(paths.auth, "utf8")) as CredsFile;
      if (raw?.api_key) {
        cached = raw.api_key;
        return cached;
      }
    }
  } catch {
    // Archivo corrupto/ilegible: lo tratamos como "sin key".
  }
  return null;
}

/** Persiste la key (y la cachea). Best-effort: si el FS es read-only, queda en memoria. */
export function writeApiKey(key: string): void {
  cached = key;
  try {
    mkdirSync(paths.root, { recursive: true });
    const body: CredsFile = { api_key: key, issued_at: new Date().toISOString() };
    writeFileSync(paths.auth, JSON.stringify(body, null, 2) + "\n");
  } catch {
    // No se pudo persistir: la key vive solo en este proceso.
  }
}

/** Limpia la cache en memoria (para tests; no borra el archivo). */
export function clearApiKeyCache(): void {
  cached = null;
}
