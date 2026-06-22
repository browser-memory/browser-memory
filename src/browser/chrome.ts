import { spawn, type ChildProcess } from "node:child_process";
import {
  mkdirSync,
  existsSync,
  cpSync,
  rmSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join, basename } from "node:path";
import { chromium } from "playwright";
import {
  cdpPort,
  cdpEndpoint,
  paths,
  resolveChromeBinary,
  realChromeUserDataDir,
  resolveSeedProfile,
  reseedEnabled,
} from "../config.js";

/**
 * Owner of the lifecycle of this server's dedicated Chrome (spec §4).
 *
 * Launches ONE Chrome instance with a persistent dedicated profile and an INTERNAL
 * remote-debugging port. Both the replay runner (via connectOverCDP) and the exploration
 * tools (browser/explore.ts) attach to the SAME Chrome, so they see the same state: tabs,
 * DOM, and session. It's a dedicated Chrome: it doesn't touch the user's browser nor
 * depend on any other browser server.
 *
 * Idempotent startup: if there's already a Chrome listening on the port, it reuses it
 * instead of relaunching (avoids the profile lock).
 */

let child: ChildProcess | undefined;

/** Cache subdirectories we do NOT copy when seeding (they are most of the weight). */
const CACHE_DIRS = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "DawnCache",
  "DawnGraphiteCache",
  "DawnWebGPUCache",
  "GraphiteDawnCache",
  "Application Cache",
  "Media Cache",
  "CacheStorage",
  "ScriptCache",
  "Service Worker",
]);

/**
 * Seeds the dedicated profile from the user's real Chrome — ONLY the first time (if there's
 * no Default yet). Copies the sessions/accounts (Cookies, Login Data, Local Storage, etc.)
 * skipping the caches, and `Local State` so cookie encryption is consistent. Best-effort: if
 * there's no real profile, we start empty and the user logs in by hand once.
 */
function seedProfileIfEmpty(): void {
  const dstDefault = join(paths.chromeProfile, "Default");
  if (existsSync(dstDefault)) return; // already seeded / already in use: don't touch.

  const srcRoot = realChromeUserDataDir();
  if (!srcRoot) return; // no detectable real Chrome: starts empty.
  const profile = resolveSeedProfile(srcRoot); // most-used profile, not always "Default".
  const srcProfile = join(srcRoot, profile);
  if (!existsSync(srcProfile)) return;

  mkdirSync(paths.chromeProfile, { recursive: true });
  // The chosen profile (e.g. "Profile 2") is ALWAYS copied to the "Default" of the dedicated
  // dir, which is the one Chrome uses when starting with --user-data-dir without --profile-directory.
  cpSync(srcProfile, dstDefault, {
    recursive: true,
    filter: (src) => !CACHE_DIRS.has(basename(src)),
  });
  const localState = join(srcRoot, "Local State");
  if (existsSync(localState)) {
    cpSync(localState, join(paths.chromeProfile, "Local State"));
  }
  disableSessionRestore();
  process.stderr.write(
    `[tool-memory] Profile "${profile}" seeded from ${srcRoot} (logged-in accounts, no caches).\n`,
  );
}

/**
 * Base SQLite files for session/auth that we refresh on every re-seed. For each base we
 * also copy its sidecars (-wal, -shm, -journal): with the real Chrome OPEN, freshly written
 * cookies live in the -wal still unflushed, so copying only the main file would give a stale
 * snapshot. Copying the three together preserves the state.
 */
const AUTH_BASES = ["Cookies", "Login Data", "Web Data"];
const SQLITE_SIDECARS = ["", "-wal", "-shm", "-journal"];
const AUTH_FILES = AUTH_BASES.flatMap((b) => SQLITE_SIDECARS.map((s) => b + s));
/** Session/auth directories (modern cookies live in Network/). */
const AUTH_DIRS = ["Network", "Local Storage", "Session Storage"];

/**
 * Refreshes ONLY the session/auth files from the real Chrome (not the whole profile).
 * Meant to run on every launch if reseedEnabled: it carries over new logins quickly and
 * without wearing the disk. Best-effort: if there's no seeded profile yet, it leaves it to
 * seedProfileIfEmpty; if the real Chrome is open, it copies the latest on-disk state (which
 * may be slightly behind, but doesn't break).
 */
function reseedAuth(): void {
  const srcRoot = realChromeUserDataDir();
  if (!srcRoot) return;
  const profile = resolveSeedProfile(srcRoot); // same profile as the initial seed.
  const srcProfile = join(srcRoot, profile);
  const dstDefault = join(paths.chromeProfile, "Default");
  if (!existsSync(srcProfile) || !existsSync(dstDefault)) return;

  for (const f of AUTH_FILES) {
    const src = join(srcProfile, f);
    const dst = join(dstDefault, f);
    if (existsSync(src)) cpSync(src, dst);
    else rmSync(dst, { force: true }); // if the real one no longer has the sidecar, don't keep the old
  }
  for (const d of AUTH_DIRS) {
    const src = join(srcProfile, d);
    if (!existsSync(src)) continue;
    const dst = join(dstDefault, d);
    rmSync(dst, { recursive: true, force: true }); // avoids mixing old/new leveldb
    cpSync(src, dst, { recursive: true, filter: (p) => !CACHE_DIRS.has(basename(p)) });
  }
  const localState = join(srcRoot, "Local State");
  if (existsSync(localState)) {
    cpSync(localState, join(paths.chromeProfile, "Local State")); // encryption consistency
  }
  disableSessionRestore();
  process.stderr.write(
    `[tool-memory] Auth re-seeded (profile "${profile}") from ${srcRoot}.\n`,
  );
}

/**
 * Leaves the profile ready to start WITHOUT restoring the user's old tabs: deletes the
 * session files and forces "open new tab" + clean exit in the preferences. Keeps the data
 * (cookies/login); it only avoids the tab noise.
 */
function disableSessionRestore(): void {
  const def = join(paths.chromeProfile, "Default");
  for (const f of ["Current Session", "Current Tabs", "Last Session", "Last Tabs"]) {
    rmSync(join(def, f), { force: true });
  }
  rmSync(join(def, "Sessions"), { recursive: true, force: true });

  const prefsPath = join(def, "Preferences");
  if (!existsSync(prefsPath)) return;
  try {
    const prefs = JSON.parse(readFileSync(prefsPath, "utf8")) as Record<string, any>;
    prefs.session = { ...(prefs.session ?? {}), restore_on_startup: 5 };
    delete prefs.session.startup_urls;
    prefs.profile = { ...(prefs.profile ?? {}), exit_type: "Normal", exited_cleanly: true };
    writeFileSync(prefsPath, JSON.stringify(prefs));
  } catch {
    // unreadable Preferences: not fatal, Chrome regenerates it.
  }
}

/** Is there already a Chrome listening on the CDP endpoint? */
async function cdpAlive(): Promise<boolean> {
  try {
    const res = await fetch(`${cdpEndpoint}/json/version`, {
      signal: AbortSignal.timeout(800),
    });
    return res.ok;
  } catch {
    return false;
  }
}

/** Waits until the CDP endpoint responds (or the timeout runs out). */
async function waitForCdp(timeoutMs = 15000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await cdpAlive()) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `Chrome did not bring up the CDP endpoint at ${cdpEndpoint} after ${timeoutMs}ms`,
  );
}

export interface SharedChrome {
  cdpEndpoint: string;
  /** true if it was already running and we reuse it (we don't kill it on close). */
  reused: boolean;
}

export async function launchSharedChrome(): Promise<SharedChrome> {
  if (await cdpAlive()) {
    return { cdpEndpoint, reused: true };
  }

  // First time: we seed the profile with the accounts from the user's real Chrome.
  seedProfileIfEmpty();
  // Each launch (once per session, lazy): we refresh auth if enabled.
  if (reseedEnabled) reseedAuth();

  mkdirSync(paths.chromeProfile, { recursive: true });

  const bin = resolveChromeBinary();
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${paths.chromeProfile}`,
    "--no-first-run",
    "--no-default-browser-check",
    // A stable initial tab to attach to.
    "about:blank",
  ];

  if (bin) {
    child = spawn(bin, args, { stdio: "ignore", detached: false });
  } else {
    // No system Chrome: we use Playwright's chromium as the binary.
    child = spawn(chromium.executablePath(), args, {
      stdio: "ignore",
      detached: false,
    });
  }

  child.on("exit", () => {
    child = undefined;
  });

  await waitForCdp();
  return { cdpEndpoint, reused: false };
}

/** Closes Chrome only if we launched it ourselves. */
export function stopSharedChrome(): void {
  if (child && !child.killed) {
    child.kill();
    child = undefined;
  }
}
