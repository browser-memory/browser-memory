import { createRequire } from "node:module";
import { getInstallId } from "./install-id.js";
import { readApiKey } from "./credentials.js";
import { cfg, truthy } from "../settings.js";

/**
 * Config del registro remoto. Por defecto está APAGADO: memoria 100% local, sin pulls ni
 * telemetría (lo gatea client.ts). Se configura con la precedencia env > config.json >
 * default (ver settings.ts):
 *   - `registry-enabled` / TOOL_MEMORY_REGISTRY_ENABLED → en `on` prende el remoto.
 *   - `registry-url` / TOOL_MEMORY_REGISTRY_URL  → backend a usar (default: producción abajo).
 */

// Backend de producción (dominio propio). Se overridea con `registry-url`.
const DEFAULT_REGISTRY_URL = "https://api.browser-memory.com";

const require = createRequire(import.meta.url);
function readClientVersion(): string {
  try {
    return (require("../../package.json") as { version?: string }).version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export interface RegistryConfig {
  baseUrl: string;
  timeoutMs: number;
  /** Si está en false, el cliente remoto no pega al server (modo 100% local). */
  enabled: boolean;
  installId: string;
  clientVersion: string;
}

export const registryConfig: RegistryConfig = {
  baseUrl: (cfg("TOOL_MEMORY_REGISTRY_URL") ?? DEFAULT_REGISTRY_URL).replace(/\/$/, ""),
  timeoutMs: Number(cfg("TOOL_MEMORY_REGISTRY_TIMEOUT_MS") ?? 3000),
  enabled: truthy(cfg("TOOL_MEMORY_REGISTRY_ENABLED"), false),
  installId: getInstallId(),
  clientVersion: readClientVersion(),
};

/**
 * Resuelve la API key en cada request (NO al startup): el device-code login la escribe
 * en runtime. Orden: env `TOOL_MEMORY_REGISTRY_KEY` (override manual dev/CI) → cache →
 * ~/.tool-memory/credentials.json. `null` si no hay login (dispara device-code cuando hace
 * falta el remoto).
 */
export function getApiKey(): string | null {
  return process.env.TOOL_MEMORY_REGISTRY_KEY ?? readApiKey();
}
