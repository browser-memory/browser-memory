import { registryConfig } from "./config.js";
import { writeApiKey } from "./credentials.js";

/**
 * Login device-code (estilo `gh auth login`): cuando el remoto responde 401 y no hay key,
 * arrancamos un device flow contra el server y BLOQUEAMOS la llamada MCP haciendo polling
 * hasta que el usuario autorice (o se agote el tiempo, ~5 min por defecto). Al recibir la
 * key la persistimos con writeApiKey() y la próxima request remota ya sale firmada.
 *
 * Los mensajes al usuario van por STDERR (stdout es el protocolo MCP stdio).
 */

/** Tope de espera del polling. El server expira el device_code aparte (suele ser mayor). */
const POLL_MAX_MS = Number(process.env.TOOL_MEMORY_LOGIN_TIMEOUT_MS ?? 300_000);

interface DeviceStart {
  device_code: string;
  user_code?: string;
  verification_url: string;
  interval?: number;
  expires_in?: number;
}

/** Resultado de un poll: la key, "pending" (seguir esperando) o null (expiró/inválido). */
type PollResult = string | "pending" | null;

function warn(msg: string): void {
  process.stderr.write(`[tool-memory] login: ${msg}\n`);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// Un solo login a la vez: discover y run pueden toparse con 401 casi simultáneamente y no
// queremos abrir dos device flows. El segundo se cuelga del mismo Promise.
let inFlight: Promise<boolean> | null = null;

/**
 * Dispara (o reusa) el device flow. Devuelve true si quedó una key persistida, false si no
 * (timeout, expiró, o el server no respondió). Best-effort: nunca lanza.
 */
export function login(): Promise<boolean> {
  if (inFlight) return inFlight;
  inFlight = doLogin().finally(() => {
    inFlight = null;
  });
  return inFlight;
}

async function doLogin(): Promise<boolean> {
  const start = await startDevice();
  if (!start) return false;

  process.stderr.write(
    `\n[tool-memory] Para usar las tools remotas, autorizá este dispositivo:\n` +
      `  → ${start.verification_url}\n` +
      (start.user_code ? `  código: ${start.user_code}\n` : "") +
      `Esperando autorización (hasta ${Math.round(POLL_MAX_MS / 1000)}s)...\n\n`,
  );

  const intervalMs = Math.max(1, start.interval ?? 5) * 1000;
  const deadline = Date.now() + POLL_MAX_MS;
  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const r = await pollDevice(start.device_code);
    if (r === "pending") continue;
    if (r === null) {
      warn("device_code expirado o inválido");
      return false;
    }
    writeApiKey(r);
    process.stderr.write(`[tool-memory] dispositivo autorizado ✓\n`);
    return true;
  }
  warn("tiempo de espera agotado");
  return false;
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
 * Cualquier otro caso (incluido error de red transitorio) → "pending": seguimos intentando.
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
    if (!res.ok) return "pending"; // 5xx u otro transitorio: reintentamos
    const body = (await res.json()) as { status?: string; api_key?: string };
    if (body.api_key) return body.api_key;
    return "pending";
  } catch {
    // Error de red transitorio: no abortamos el login, seguimos esperando.
    return "pending";
  }
}
