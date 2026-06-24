import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the data dir before importing anything that anchors ROOT (config -> settings).
process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-migrate-"));

const { migrateLegacyProfile } = await import("../src/browser/chrome.ts");
const { paths } = await import("../src/config.ts");

const marker = join(paths.chromeProfile, ".bm-managed");
const def = join(paths.chromeProfile, "Default");
const cookies = join(def, "Cookies");

/** Start each case from a clean slate (the home is shared across tests). */
function reset(): void {
  rmSync(paths.chromeProfile, { recursive: true, force: true });
}

test("fresh install: no profile => nothing wiped, marker written", () => {
  reset();
  migrateLegacyProfile();
  assert.ok(existsSync(marker), "marker is written");
  assert.ok(!existsSync(def), "no Default is fabricated");
});

test("legacy profile (Default but no marker) is wiped once and marked", () => {
  reset();
  mkdirSync(def, { recursive: true });
  writeFileSync(cookies, "seeded-stale-cookies");

  migrateLegacyProfile();

  assert.ok(!existsSync(cookies), "stale seeded data is gone");
  assert.ok(existsSync(marker), "marker is written so it never wipes again");
});

test("a marked profile is left untouched (fresh login survives)", () => {
  reset();
  mkdirSync(def, { recursive: true });
  writeFileSync(cookies, "fresh-login");
  writeFileSync(marker, "2026-01-01T00:00:00.000Z\n");

  migrateLegacyProfile();

  assert.equal(readFileSync(cookies, "utf8"), "fresh-login", "managed profile is never wiped");
});
