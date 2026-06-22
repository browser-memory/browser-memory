import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { cfg, truthy } from "./settings.js";

/**
 * Global paths and system parameters.
 *
 * The memory is global (not per-project): a tool from a site works in any
 * context. It lives in ~/.tool-memory/ unless overridden by env (useful for tests).
 *
 * All config is resolved with `cfg()` (env var > config.json > default; see settings.ts),
 * including `ROOT` (the DATA dir). The config.json itself is anchored to env-or-default (not
 * to this `home`), so setting `home` relocates the data without moving the config.json itself.
 */
const ROOT = cfg("TOOL_MEMORY_HOME") ?? join(homedir(), ".tool-memory");

export const paths = {
  root: ROOT,
  tools: join(ROOT, "tools"),
  index: join(ROOT, "index.json"),
  traces: join(ROOT, "traces"),
  // creds: SITE secrets (login for each website), never versioned.
  creds: join(ROOT, "creds.local.json"),
  // auth: the remote registry API key (one per user), written by the device-code login.
  auth: join(ROOT, "credentials.json"),
  // pendingDevice: device-code in progress (between the 1st 401 and authorization), ephemeral.
  pendingDevice: join(ROOT, "pending-device.json"),
  chromeProfile: join(ROOT, "chrome-profile"),
};

/** Remote-debugging port of the shared Chrome. */
export const cdpPort = Number(cfg("TOOL_MEMORY_CDP_PORT") ?? 9333);

/**
 * Every time Chrome is LAUNCHED (once per session, lazy) we refresh the session files
 * (cookies/login/storage) from the user's real Chrome. This way you carry over
 * new logins without re-copying the whole profile. On by default so any user
 * brings up their browser with up-to-date sessions without configuring anything; turn it off with
 * TOOL_MEMORY_RESEED=0. For 100% fresh cookies it's best to have the real Chrome closed.
 */
export const reseedEnabled = truthy(cfg("TOOL_MEMORY_RESEED"), true);

/** CDP endpoint of the dedicated Chrome; the replay runner and exploration tools attach to it. */
export const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;

/** First existing candidate from a list (or undefined). */
function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((p) => p && existsSync(p));
}

/**
 * Chrome binary to launch, by platform. We prefer the system Google Chrome
 * (the user's real profile for manual auth the first time); if absent, we fall back to the
 * chromium bundled with Playwright. Override with TOOL_MEMORY_CHROME_BIN.
 */
export function resolveChromeBinary(): string | undefined {
  const override = cfg("TOOL_MEMORY_CHROME_BIN");
  if (override) return override;
  const home = homedir();
  let candidates: string[] = [];
  if (process.platform === "darwin") {
    candidates = [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      join(home, "Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
    ];
  } else if (process.platform === "win32") {
    const pf = process.env["ProgramFiles"] ?? "C:\\Program Files";
    const pf86 = process.env["ProgramFiles(x86)"] ?? "C:\\Program Files (x86)";
    const local = process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    candidates = [
      join(pf, "Google", "Chrome", "Application", "chrome.exe"),
      join(pf86, "Google", "Chrome", "Application", "chrome.exe"),
      join(local, "Google", "Chrome", "Application", "chrome.exe"),
    ];
  } else {
    // linux and other unix
    candidates = [
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/opt/google/chrome/chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/snap/bin/chromium",
    ];
  }
  // undefined => let Playwright use its bundled chromium.
  return firstExisting(candidates);
}

/**
 * The REAL user-data-dir of the user's Chrome (where their logged-in accounts live), by
 * platform. It's the source of the "seed": we copy the active profile here to start with
 * sessions already signed in, without touching the real dir (Chrome 136+ blocks CDP on the
 * user-data-dir by default, which is why we use a copy in our own dir).
 * Override with TOOL_MEMORY_SEED_FROM. Returns undefined if not found.
 */
export function realChromeUserDataDir(): string | undefined {
  const override = cfg("TOOL_MEMORY_SEED_FROM");
  if (override) return override;
  const home = homedir();
  let candidates: string[] = [];
  if (process.platform === "darwin") {
    candidates = [
      join(home, "Library", "Application Support", "Google", "Chrome"),
      join(home, "Library", "Application Support", "Chromium"),
    ];
  } else if (process.platform === "win32") {
    const local = process.env["LOCALAPPDATA"] ?? join(home, "AppData", "Local");
    candidates = [
      join(local, "Google", "Chrome", "User Data"),
      join(local, "Chromium", "User Data"),
    ];
  } else {
    candidates = [
      join(home, ".config", "google-chrome"),
      join(home, ".config", "chromium"),
    ];
  }
  // Works if it has ANY profile inside (Local State lists the real profiles).
  return candidates.find((root) => existsSync(join(root, "Local State")));
}

/**
 * Name of the profile directory to seed (e.g. "Default", "Profile 2"). Auto-detects
 * the MOST used one by reading `Local State` (`profile.last_used`), so a user with several
 * profiles starts with the one they actually use, without configuring anything. Falls back to "Default" if there's
 * no info. Explicit override with TOOL_MEMORY_PROFILE.
 */
export function resolveSeedProfile(srcRoot: string): string {
  const override = cfg("TOOL_MEMORY_PROFILE");
  if (override && existsSync(join(srcRoot, override))) return override;
  try {
    const localState = JSON.parse(
      readFileSync(join(srcRoot, "Local State"), "utf8"),
    ) as { profile?: { last_used?: string; last_active_profiles?: string[] } };
    const candidate =
      localState.profile?.last_used ??
      localState.profile?.last_active_profiles?.[0];
    if (candidate && existsSync(join(srcRoot, candidate))) return candidate;
  } catch {
    // Local State absent/unreadable: we fall back to Default.
  }
  return "Default";
}
