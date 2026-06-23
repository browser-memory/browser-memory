import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the data dir before importing anything that anchors ROOT (sqlite-backup -> settings).
process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-sqlbk-"));

const { sqliteBackup } = await import("../src/browser/sqlite-backup.ts");

/** First working sqlite3 binary, or null if none is installed (suite skips). */
function findSqlite3(): string | null {
  for (const bin of ["sqlite3", "/usr/bin/sqlite3", "/opt/homebrew/bin/sqlite3"]) {
    try {
      execFileSync(bin, ["--version"], { stdio: "ignore" });
      return bin;
    } catch {
      /* try next */
    }
  }
  return null;
}
const SQLITE = findSqlite3();
const skip = SQLITE ? false : "sqlite3 not installed";

function makeDb(path: string, rows: number): void {
  const sql =
    "CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT);" +
    Array.from({ length: rows }, (_, i) => `INSERT INTO t(v) VALUES('r${i}');`).join("");
  execFileSync(SQLITE!, [path, sql], { stdio: "ignore" });
}
function rowCount(path: string): number {
  return Number(
    execFileSync(SQLITE!, [path, "SELECT count(*) FROM t;"], { encoding: "utf8" }).trim(),
  );
}
function integrityOk(path: string): boolean {
  return (
    execFileSync(SQLITE!, [path, "PRAGMA integrity_check;"], { encoding: "utf8" }).trim() === "ok"
  );
}

test("backup of a populated DB yields a valid, complete copy", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-sqlbk-case-"));
  // Source under a dir WITH A SPACE to prove array-arg handling (no shell quoting).
  const srcDir = join(dir, "With Space");
  mkdirSync(srcDir, { recursive: true });
  const src = join(srcDir, "Cookies");
  const dstDir = join(dir, "dst");
  mkdirSync(dstDir, { recursive: true });
  const dst = join(dstDir, "Cookies");
  makeDb(src, 5);
  // Stale sidecar at dst (as a prior cpSync would leave) must be cleared on success.
  writeFileSync(dst + "-wal", "stale");

  const ok = sqliteBackup(src, dst, { sqliteBin: SQLITE! });

  assert.equal(ok, true);
  assert.ok(existsSync(dst));
  assert.ok(!existsSync(dst + "-wal"), "stale -wal sidecar must be removed");
  assert.ok(integrityOk(dst));
  assert.equal(rowCount(dst), 5);
});

test("fallback: bogus binary => returns false, does not write dst", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-sqlbk-fb-"));
  const src = join(dir, "Cookies");
  const dst = join(dir, "out-Cookies");
  makeDb(src, 3);

  const ok = sqliteBackup(src, dst, { sqliteBin: "/no/such/sqlite3-bogus" });

  assert.equal(ok, false);
  assert.ok(!existsSync(dst), "helper writes nothing on failure; the caller does the cpSync");
  // Document the caller's contract: a raw cpSync still produces a copy as the fallback.
  cpSync(src, dst);
  assert.ok(existsSync(dst));
});

test("missing source => returns false without invoking sqlite3", { skip }, () => {
  const dir = mkdtempSync(join(tmpdir(), "tm-sqlbk-miss-"));
  assert.equal(sqliteBackup(join(dir, "nope"), join(dir, "dst"), { sqliteBin: SQLITE! }), false);
});
