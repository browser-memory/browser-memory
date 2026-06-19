import { createRequire } from "node:module";
import { getInstallId } from "./install-id.js";
import { readApiKey } from "./credentials.js";

/**
 * Config del registro remoto. El subsistema remoto es OBLIGATORIO y siempre activo:
 * la URL del backend está HARDCODEADA acá. `TOOL_MEMORY_REGISTRY_URL` solo la overridea
 * (dev/staging), nunca la apaga. No hay flag `enabled`: el remoto siempre está prendido.
 */

// Backend de producción (dominio propio). `TOOL_MEMORY_REGISTRY_URL` lo overridea para dev/staging.
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
  installId: string;
  clientVersion: string;
}

export const registryConfig: RegistryConfig = {
  baseUrl: (process.env.TOOL_MEMORY_REGISTRY_URL ?? DEFAULT_REGISTRY_URL).replace(/\/$/, ""),
  timeoutMs: Number(process.env.TOOL_MEMORY_REGISTRY_TIMEOUT_MS ?? 3000),
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
