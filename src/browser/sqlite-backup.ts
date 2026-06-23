import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { cfg } from "../settings.js";

/**
 * Consistent copy of a SQLite database via SQLite's own ONLINE BACKUP, safe even while
 * another process (Chrome) holds the source file open.
 *
 * The seed/reseed (browser/chrome.ts) copy Chrome's auth DBs (Cookies / Login Data / Web Data),
 * which are SQLite files. A raw file copy (cpSync) of a live DB can catch it mid-write/checkpoint
 * and yield a torn/stale snapshot → a logged-out profile. `sqlite3 <src> ".backup '<dst>'"` opens
 * the DB read-only, takes a transactionally-consistent snapshot (committed + WAL merged), and
 * retries on locks. If sqlite3 isn't available, the caller falls back to the raw cpSync.
 */

/** Common absolute locations for the sqlite3 CLI when it isn't found by name on PATH. */
function sqlite3Candidates(): string[] {
  if (process.platform === "win32") return []; // rely on PATH; absence => cpSync fallback
  return [
    "/usr/bin/sqlite3",
    "/opt/homebrew/bin/sqlite3",
    "/usr/local/bin/sqlite3",
    "/opt/local/bin/sqlite3",
  ];
}

/**
 * sqlite3 binary used for the online backup. Override with TOOL_MEMORY_SQLITE_BIN. Returns a
 * bare name (never undefined) so execFileSync resolves it via PATH when no absolute match is
 * found; the single place that decides success/failure is the try/catch in `sqliteBackup`.
 */
export function resolveSqlite3Binary(): string {
  const override = cfg("TOOL_MEMORY_SQLITE_BIN");
  if (override) return override;
  const abs = sqlite3Candidates().find((p) => existsSync(p));
  return abs ?? (process.platform === "win32" ? "sqlite3.exe" : "sqlite3");
}

export interface SqliteBackupOptions {
  /** Inject a specific sqlite3 binary (tests use this for the real and the bogus-binary case). */
  sqliteBin?: string;
  timeoutMs?: number;
}

/**
 * Backs up the SQLite DB at `src` into `dst` using the online backup API. On success it clears any
 * stale `-wal`/`-shm`/`-journal` sidecars at `dst` (the `.backup` output is a single checkpointed
 * file; a leftover sidecar from a prior raw copy would shadow/corrupt it). Returns `false` on any
 * failure — missing source, no sqlite3 binary, non-zero exit or timeout — so the caller can fall
 * back to a raw cpSync.
 */
export function sqliteBackup(
  src: string,
  dst: string,
  opts: SqliteBackupOptions = {},
): boolean {
  if (!existsSync(src)) return false;
  const bin = opts.sqliteBin ?? resolveSqlite3Binary();
  // sqlite3's own filename quoting for `.backup` (NOT shell quoting — execFileSync runs no shell).
  const safeDst = dst.replace(/'/g, "''");
  try {
    execFileSync(bin, [src, `.backup '${safeDst}'`], {
      timeout: opts.timeoutMs ?? 10_000,
      stdio: "ignore",
    });
  } catch {
    return false;
  }
  for (const sc of ["-wal", "-shm", "-journal"]) {
    rmSync(dst + sc, { force: true });
  }
  return true;
}
