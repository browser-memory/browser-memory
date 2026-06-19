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
 * Login device-code NO BLOQUEANTE (estilo `gh auth login`, pero sin colgar la llamada).
 * Cuando el remoto responde 401:
 *   - 1er intento: arrancamos un device flow, GUARDAMOS el device_code en disco
 *     (~/.tool-memory/pending-device.json) y devolvemos el link para que el usuario
 *     autorice. La tool termina ya — no hay polling bloqueante.
 *   - Intentos siguientes (tras autorizar): hacemos UN solo poll con el device_code
 *     guardado; si ya está autorizado, persistimos la api_key y seguimos.
 *
 * El device_code va a disco para sobrevivir reinicios del MCP server entre que el usuario
 * loguea y reintenta. La key final la escribe credentials.ts; este módulo nunca la loguea.
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

/** Resultado de un poll: la api_key, "pending" (seguir esperando) o null (expiró/inválido). */
type PollResult = string | "pending" | null;

/**
 * Resultado de un intento de login. `authorized` → ya hay key, reintentá el request.
 * `pending` → mostrale el link al usuario. `unavailable` → el server no respondió.
 */
export type DeviceLoginOutcome =
  | { status: "authorized" }
  | { status: "pending"; verificationUrl: string; userCode?: string }
  | { status: "unavailable" };

function warn(msg: string): void {
  process.stderr.write(`[tool-memory] login: ${msg}\n`);
}

// ---- Persistencia del device-code pendiente (best-effort, mismo patrón que credentials) ----

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
    // No se pudo persistir: el flujo igual funciona si el server no reinicia.
  }
}

function clearPending(): void {
  try {
    if (existsSync(paths.pendingDevice)) rmSync(paths.pendingDevice);
  } catch {
    // best-effort
  }
}

// ---- Orquestación ----

// Un intento a la vez: discover y run pueden toparse con 401 casi simultáneos y no queremos
// arrancar dos device flows. El segundo se cuelga del mismo Promise.
let inFlight: Promise<DeviceLoginOutcome> | null = null;

/**
 * Intenta avanzar el login SIN bloquear. Reusa un device-code pendiente (poll único) o
 * arranca uno nuevo. Best-effort: nunca lanza.
 */
export function attemptDeviceLogin(): Promise<DeviceLoginOutcome> {
  if (inFlight) return inFlight;
  inFlight = doAttempt().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doAttempt(): Promise<DeviceLoginOutcome> {
  // 1. ¿Hay un device flow pendiente y vigente? Polleamos UNA vez por si ya autorizó.
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
      // el server lo dio por expirado/inválido: arrancamos uno nuevo abajo.
      clearPending();
    } else {
      // r es la api_key (cualquier string que no sea el literal "pending").
      writeApiKey(r);
      clearPending();
      return { status: "authorized" };
    }
  }

  // 2. Arrancar un device flow nuevo y persistirlo.
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

/** POST /v1/auth/device/start. `null` si el server no respondió bien. */
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
      warn("device/start: respuesta incompleta");
      return null;
    }
    return body;
  } catch (e) {
    warn(`device/start falló: ${(e as Error).message}`);
    return null;
  }
}

/**
 * POST /v1/auth/device/poll una vez. 400 → null (expiró/inválido). 200 con api_key → la key.
 * Cualquier otro caso (incluido error de red transitorio) → "pending": no abortamos.
 * Exportada para tests (inyectando globalThis.fetch).
 */
export async function pollDevice(deviceCode: string): Promise<PollResult> {
  try {
    const res = await fetch(`${registryConfig.baseUrl}/v1/auth/device/poll`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_code: deviceCode }),
      signal: AbortSignal.timeout(registryConfig.timeoutMs),
    });
    if (res.status === 400) return null; // expired_token / inválido
    if (!res.ok) return "pending"; // 5xx u otro transitorio: reintentamos en la próxima
    const body = (await res.json()) as { status?: string; api_key?: string };
    if (body.api_key) return body.api_key;
    return "pending";
  } catch {
    return "pending";
  }
}
