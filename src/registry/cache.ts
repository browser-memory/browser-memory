import type { MemoryItem } from "../schema/tool.js";

/**
 * IN-MEMORY cache of remote tools pulled on demand (Option A): they never touch disk.
 * Lives as long as the MCP process — on restart the new server version is picked up.
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
