import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { paths } from "../config.js";
import { registryConfig } from "./config.js";
import { writeApiKey } from "./credentials.js";

/**
 * NON-BLOCKING device-code login (`gh auth login` style, but without hanging the call).
 * When the remote responds 401:
 *   - 1st attempt: we start a device flow, SAVE the device_code to disk
 *     (~/.tool-memory/pending-device.json) and return the link for the user to
 *     authorize. The tool finishes right away — there is no blocking polling.
 *   - Subsequent attempts (after authorizing): we do ONE single poll with the saved
 *     device_code; if it is already authorized, we persist the api_key and continue.
 *
 * The device_code goes to disk to survive MCP server restarts between the user logging
 * in and retrying. The final key is written by credentials.ts; this module never logs it.
 */

interface PendingDevice {
  device_code: string;
  user_code?: string;
  verification_url: string;
  expires_at: string; // ISO
}

interface DeviceStart {
  device_code: string;
  user_code?: string;
  verification_url: string;
  interval?: number;
  expires_in?: number;
}

/** Result of a poll: the api_key, "pending" (keep waiting) or null (expired/invalid). */
type PollResult = string | "pending" | null;

/**
 * Result of a login attempt. `authorized` → there is already a key, retry the request.
 * `pending` → show the link to the user. `unavailable` → the server did not respond.
 */
export type DeviceLoginOutcome =
  | { status: "authorized" }
  | { status: "pending"; verificationUrl: string; userCode?: string }
  | { status: "unavailable" };

function warn(msg: string): void {
  process.stderr.write(`[tool-memory] login: ${msg}\n`);
}

// ---- Persistence of the pending device-code (best-effort, same pattern as credentials) ----

function readPending(): PendingDevice | null {
  try {
    if (!existsSync(paths.pendingDevice)) return null;
    const p = JSON.parse(readFileSync(paths.pendingDevice, "utf8")) as PendingDevice;
    if (!p?.device_code) return null;
    if (p.expires_at && Date.parse(p.expires_at) <= Date.now()) {
      clearPending();
      return null;
    }
    return p;
  } catch {
    return null;
  }
}

function writePending(p: PendingDevice): void {
  try {
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(paths.pendingDevice, JSON.stringify(p, null, 2) + "\n");
  } catch {
    // Couldn't persist: the flow still works if the server doesn't restart.
  }
}

function clearPending(): void {
  try {
    if (existsSync(paths.pendingDevice)) rmSync(paths.pendingDevice);
  } catch {
    // best-effort
  }
}

// ---- Orchestration ----

// One attempt at a time: discover and run can hit 401 almost simultaneously and we don't
// want to start two device flows. The second hangs off the same Promise.
let inFlight: Promise<DeviceLoginOutcome> | null = null;

/**
 * Tries to advance the login WITHOUT blocking. Reuses a pending device-code (single poll) or
 * starts a new one. Best-effort: never throws.
 */
export function attemptDeviceLogin(): Promise<DeviceLoginOutcome> {
  if (inFlight) return inFlight;
  inFlight = doAttempt().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doAttempt(): Promise<DeviceLoginOutcome> {
  // 1. Is there a pending and still-valid device flow? We poll ONCE in case it already authorized.
  const pending = readPending();
  if (pending) {
    const r = await pollDevice(pending.device_code);
    if (r === "pending") {
      return {
        status: "pending",
        verificationUrl: pending.verification_url,
        userCode: pending.user_code,
      };
    }
    if (r === null) {
      // the server considered it expired/invalid: we start a new one below.
      clearPending();
    } else {
      // r is the api_key (any string that isn't the literal "pending").
      writeApiKey(r);
      clearPending();
      return { status: "authorized" };
    }
  }

  // 2. Start a new device flow and persist it.
  const start = await startDevice();
  if (!start) return { status: "unavailable" };
  writePending({
    device_code: start.device_code,
    user_code: start.user_code,
    verification_url: start.verification_url,
    expires_at: new Date(Date.now() + (start.expires_in ?? 900) * 1000).toISOString(),
  });
  return {
    status: "pending",
    verificationUrl: start.verification_url,
    userCode: start.user_code,
  };
}

/** POST /v1/auth/device/start. `null` if the server didn't respond properly. */
async function startDevice(): Promise<DeviceStart | null> {
  try {
    const res = await fetch(`${registryConfig.baseUrl}/v1/auth/device/start`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        install_id: registryConfig.installId,
        client_version: registryConfig.clientVersion,
      }),
      signal: AbortSignal.timeout(registryConfig.timeoutMs),
    });
    if (!res.ok) {
      warn(`device/start HTTP ${res.status}`);
      return null;
    }
    const body = (await res.json()) as DeviceStart;
    if (!body?.device_code || !body?.verification_url) {
      warn("device/start: incomplete response");
      return null;
    }
    return body;
  } catch (e) {
    warn(`device/start failed: ${(e as Error).message}`);
    return null;
  }
}

/**
 * POST /v1/auth/device/poll once. 400 → null (expired/invalid). 200 with api_key → the key.
 * Any other case (including a transient network error) → "pending": we don't abort.
 * Exported for tests (injecting globalThis.fetch).
 */
export async function pollDevice(deviceCode: string): Promise<PollResult> {
  try {
    const res = await fetch(`${registryConfig.baseUrl}/v1/auth/device/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
      signal: AbortSignal.timeout(registryConfig.timeoutMs),
    });
    if (res.status === 400) return null; // expired_token / invalid
    if (!res.ok) return "pending"; // 5xx or another transient: we retry on the next one
    const body = (await res.json()) as { status?: string; api_key?: string };
    if (body.api_key) return body.api_key;
    return "pending";
  } catch {
    return "pending";
  }
}
