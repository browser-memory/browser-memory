import { homedir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";
import { cfg } from "./settings.js";

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

/** CDP endpoint of the dedicated Chrome; the replay runner and exploration tools attach to it. */
export const cdpEndpoint = `http://127.0.0.1:${cdpPort}`;

/** First existing candidate from a list (or undefined). */
function firstExisting(candidates: string[]): string | undefined {
  return candidates.find((p) => p && existsSync(p));
}

/**
 * Chrome binary to launch, by platform. We prefer the system Google Chrome (more like a real
 * browser, less bot detection); if absent, we fall back to the chromium bundled with Playwright.
 * Either way it runs against our DEDICATED profile, never the user's real one. Override with
 * TOOL_MEMORY_CHROME_BIN.
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
