import { spawn, execFileSync, type ChildProcess } from "node:child_process";
import { mkdirSync, existsSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { chromium } from "playwright";
import { cdpPort, cdpEndpoint, paths, remoteCdpUrl, resolveChromeBinary } from "../config.js";

/**
 * Owner of the lifecycle of this server's dedicated Chrome (spec §4).
 *
 * Launches ONE Chrome with a DEDICATED, PERSISTENT profile and an INTERNAL remote-debugging
 * port. Both the replay runner (via connectOverCDP) and the exploration tools
 * (browser/explore.ts) attach to the SAME Chrome, so they see the same state: tabs, DOM, session.
 *
 * The profile is the Playwright `launchPersistentContext` model: empty the FIRST time, then
 * reused AS-IS on every later launch and across Claude sessions. It lives on disk at
 * `<home>/chrome-profile` (see config.ts). We NEVER copy from the user's real Chrome, so it
 * never starts with stale cookies and a login you do here (LinkedIn, etc.) survives — nothing
 * clobbers it. It's a dedicated Chrome: it doesn't touch the user's browser nor depend on any
 * other browser server.
 *
 * Idempotent startup: if there's already a Chrome listening on the port, it reuses it instead
 * of relaunching (avoids the profile lock).
 */

let child: ChildProcess | undefined;
/** true when we launched Chrome detached via `open` (no child handle: we kill it by CDP port). */
let launchedInBackground = false;

/**
 * If `exePath` lives inside a macOS `.app` bundle, returns the bundle path (so we can launch
 * it with `open -g` and keep it in the background). Returns undefined otherwise.
 * e.g. ".../Google Chrome.app/Contents/MacOS/Google Chrome" → ".../Google Chrome.app".
 */
function macAppBundle(exePath: string): string | undefined {
  const i = exePath.indexOf(".app/");
  return i === -1 ? undefined : exePath.slice(0, i + ".app".length);
}

/** Marker (inside the profile dir) that says THIS no-seed version owns this profile. */
const MANAGED_MARKER = ".bm-managed";

/**
 * One-time UPGRADE cleanup. Older versions SEEDED this dedicated profile from the user's real
 * Chrome and RESEEDED it on every launch, so a user who upgrades is left with a profile full of
 * stale cookies (and the now-removed reseed would have clobbered any fresh login). Those versions
 * never wrote our marker.
 *
 * So the rule: if a profile already exists here but has NO marker, it can only have come from a
 * seeding version → wipe it ONCE for a clean start (the user logs in by hand and it then persists).
 * After that the marker is present and we never touch the profile again. A fresh install (no
 * profile yet) just gets the marker, nothing is wiped. The wipe is gated on a `Default` dir
 * existing, so even if writing the marker ever fails we never wipe a profile we just created.
 * Best-effort: a locked/read-only dir never blocks startup (worst case we keep the old profile).
 */
export function migrateLegacyProfile(): void {
  const marker = join(paths.chromeProfile, MANAGED_MARKER);
  try {
    if (existsSync(marker)) return; // already ours: never wipe.
    if (existsSync(join(paths.chromeProfile, "Default"))) {
      rmSync(paths.chromeProfile, { recursive: true, force: true });
      process.stderr.write(
        "[tool-memory] Reset the dedicated Chrome profile once (it came from an older version " +
          "that copied your real Chrome). Log in by hand; the session persists from now on.\n",
      );
    }
    mkdirSync(paths.chromeProfile, { recursive: true });
    writeFileSync(marker, new Date().toISOString() + "\n");
  } catch {
    // best-effort: never block startup on a locked/read-only profile dir.
  }
}

/**
 * Leaves the profile ready to start WITHOUT restoring last run's tabs and without the
 * "Chrome didn't shut down properly" bubble: deletes the session/tab files and forces
 * "open new tab" + clean exit in the preferences. Keeps the data (cookies/login); it only
 * removes the tab noise. No-op the first time (there's no Default/Preferences yet).
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
  // Remote CDP: the browser already exists on the other side and nobody here owns its
  // lifecycle. Nothing to launch, nothing to wait for — report the endpoint and let the
  // caller attach. `reused: true` is the literal truth: we did not start that browser.
  if (remoteCdpUrl) return { cdpEndpoint: remoteCdpUrl, reused: true };

  if (await cdpAlive()) {
    return { cdpEndpoint, reused: true };
  }

  // One-time: wipe a profile left by an older seeding version (no-op afterwards).
  migrateLegacyProfile();
  mkdirSync(paths.chromeProfile, { recursive: true });
  // Reuse the persistent dedicated profile as-is; only strip the tab-restore noise.
  disableSessionRestore();

  // System Google Chrome if present, else Playwright's bundled chromium. The chromium is
  // NOT there when we run from the .mcpb bundle (packed with --ignore-scripts, so Playwright
  // never downloaded a browser) — say what to do instead of failing deep inside Playwright.
  const exe = resolveChromeBinary() ?? chromium.executablePath();
  if (!existsSync(exe)) {
    throw new Error(
      "No browser to launch: Google Chrome is not installed and no bundled Chromium is " +
        "available. Install Google Chrome (https://google.com/chrome), or point " +
        "TOOL_MEMORY_CHROME_BIN at an existing Chrome/Chromium binary.",
    );
  }
  const args = [
    `--remote-debugging-port=${cdpPort}`,
    `--user-data-dir=${paths.chromeProfile}`,
    "--no-first-run",
    "--no-default-browser-check",
    // A stable initial tab to attach to.
    "about:blank",
  ];

  const appBundle = process.platform === "darwin" ? macAppBundle(exe) : undefined;
  if (appBundle) {
    // macOS: launch in the BACKGROUND so the window never steals focus. `open -g` keeps
    // Chrome from coming to the foreground; `-n` forces a fresh instance bound to OUR
    // dedicated profile (it doesn't attach to the user's running Chrome). `open` returns
    // right away and the Chrome it starts is detached from us, so we can't keep a child
    // handle: we remember we launched it and kill it by its CDP port on stop.
    spawn("open", ["-g", "-n", "-a", appBundle, "--args", ...args], { stdio: "ignore" });
    launchedInBackground = true;
  } else {
    // Linux/Windows (or a binary not inside a .app bundle): spawn it directly and keep the
    // child handle to kill it on stop.
    child = spawn(exe, args, { stdio: "ignore", detached: false });
    child.on("exit", () => {
      child = undefined;
    });
  }

  await waitForCdp();
  return { cdpEndpoint, reused: false };
}

/**
 * Kills the Chrome WE launched in the background via `open` (so we have no child handle):
 * find the process LISTENING on our CDP port and kill it. `-sTCP:LISTEN` matches only the
 * Chrome browser process, never our own CDP websocket clients (which are ESTABLISHED), and
 * the port is dedicated to us, so this never touches the user's real Chrome. Best-effort.
 */
function killChromeOnCdpPort(): void {
  try {
    const out = execFileSync("lsof", ["-ti", `tcp:${cdpPort}`, "-sTCP:LISTEN"], {
      encoding: "utf8",
    }).trim();
    for (const pid of out.split(/\s+/).filter(Boolean)) {
      try {
        process.kill(Number(pid));
      } catch {
        /* already gone */
      }
    }
  } catch {
    /* lsof missing or nothing listening: best-effort */
  }
}

/** Closes Chrome only if we launched it ourselves. */
export function stopSharedChrome(): void {
  if (child && !child.killed) {
    child.kill();
    child = undefined;
  } else if (launchedInBackground) {
    killChromeOnCdpPort();
  }
  launchedInBackground = false;
}
