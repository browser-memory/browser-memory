import { loadItem } from "../memory/store.js";
import { isComposite, type MemoryItem } from "../schema/tool.js";
import { getCached, setCached } from "./cache.js";
import {
  fetchRemoteTool,
  RegistryAuthError,
  RegistryRateLimitError,
} from "./client.js";
import { logEvent } from "./log.js";

/**
 * Resolución unificada de un item (Opción A). El SERVER es la fuente de verdad (oferta
 * curada): gana sobre una copia local del mismo name. Orden:
 *   1. cache memoria → source "remote-cache" (ya bajada en este proceso; no re-pega al server)
 *   2. pull remoto   → source "remote-pull"  (baja, VALIDA, cachea en memoria; NUNCA a disco)
 *   3. disco local   → source "local"        (fallback: solo si el server no la tiene)
 * Si no está en ningún lado, lanza con el MISMO mensaje que store.loadItem para preservar
 * el contrato `no-aplica` del runner.
 *
 * Costo de "gana el server": una tool de server se baja en cada run (la cache solo vive lo
 * que dura el proceso). Una tool SOLO local hace un GET que da 404 (silencioso) y cae al
 * disco. Es el precio de tener el server como autoridad y la receta efímera (no en disco).
 */

export type ResolveSource = "local" | "remote-cache" | "remote-pull";

export interface Resolved {
  item: MemoryItem;
  source: ResolveSource;
}

/** ¿El item vino del server (cache o pull)? Para logging (source: local|remote). */
export function isRemoteSource(s: ResolveSource): boolean {
  return s !== "local";
}

export async function resolveItem(name: string): Promise<Resolved> {
  // 1. Cache en memoria (ya pulleada del server en este proceso).
  const cached = getCached(name);
  if (cached) return { item: cached, source: "remote-cache" };

  // 2. Pull remoto: el server gana. Baja + valida + cachea. Solo acá se emite tool_pulled.
  //    Un 401/429 (gating) NO debe tapar una copia local: lo recordamos y probamos local
  //    primero; solo lo propagamos si la tool es EXCLUSIVAMENTE remota (no hay fallback).
  let gatingError: RegistryAuthError | RegistryRateLimitError | null = null;
  try {
    const pulled = await fetchRemoteTool(name);
    if (pulled) {
      setCached(name, pulled);
      logEvent({
        event_type: "tool_pulled",
        tool_name: name,
        item_type: isComposite(pulled) ? "composite" : "primitive",
        source: "remote",
      });
      return { item: pulled, source: "remote-pull" };
    }
  } catch (e) {
    if (e instanceof RegistryAuthError || e instanceof RegistryRateLimitError) {
      gatingError = e;
    } else {
      throw e;
    }
  }

  // 3. Fallback a disco local (anda aunque el server gatee o esté caído).
  try {
    return { item: loadItem(name), source: "local" };
  } catch {
    // no está local.
  }

  // 4. Ni remoto (por gating) ni local: propagamos el gating para que el handler dispare
  //    login (401) o avise el límite (429). Si no hubo gating, es un "no existe" normal.
  if (gatingError) throw gatingError;
  throw new Error(`Item no encontrado en memoria: ${name}`);
}
