import type { MemoryItem } from "../schema/tool.js";

/**
 * Cache en MEMORIA de las tools remotas bajadas por demanda (Opción A): nunca tocan disco.
 * Vive lo que dure el proceso MCP — al reiniciar se recoge la versión nueva del server.
 */
const cache = new Map<string, MemoryItem>();

export function getCached(name: string): MemoryItem | undefined {
  return cache.get(name);
}

export function setCached(name: string, item: MemoryItem): void {
  cache.set(name, item);
}

export function clearCache(): void {
  cache.clear();
}
