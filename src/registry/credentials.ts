import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { paths } from "../config.js";

/**
 * Persistence of the remote registry API key in ~/.tool-memory/credentials.json.
 * One key per user, issued by the device-code login (src/registry/device-auth.ts).
 * Same pattern as install-id.ts: in-memory cache + lazy read + fallback if the FS is
 * read-only (the key stays only in the process). Do NOT confuse with paths.creds, which
 * stores SITE secrets. The key is never written to logs.
 */
interface CredsFile {
  api_key: string;
  issued_at?: string;
}

let cached: string | null = null;

/** Reads the cached key or the one on disk. `null` if there is no previous login. */
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
    // Corrupt/unreadable file: we treat it as "no key".
  }
  return null;
}

/** Persists the key (and caches it). Best-effort: if the FS is read-only, it stays in memory. */
export function writeApiKey(key: string): void {
  cached = key;
  try {
    mkdirSync(paths.root, { recursive: true });
    const body: CredsFile = { api_key: key, issued_at: new Date().toISOString() };
    writeFileSync(paths.auth, JSON.stringify(body, null, 2) + "\n");
  } catch {
    // Couldn't persist: the key lives only in this process.
  }
}

/** Clears the in-memory cache (for tests; does not delete the file). */
export function clearApiKeyCache(): void {
  cached = null;
}
