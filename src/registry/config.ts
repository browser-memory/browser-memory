import { createRequire } from "node:module";
import { getInstallId } from "./install-id.js";

/**
 * Config del registro remoto. El subsistema remoto es OBLIGATORIO y siempre activo:
 * la URL del backend está HARDCODEADA acá. `TOOL_MEMORY_REGISTRY_URL` solo la overridea
 * (dev/staging), nunca la apaga. No hay flag `enabled`: el remoto siempre está prendido.
 */

// Backend desplegado en Railway. `TOOL_MEMORY_REGISTRY_URL` lo overridea para dev/staging.
const DEFAULT_REGISTRY_URL = "https://browser-memory-production.up.railway.app";

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
  apiKey: string | null;
  timeoutMs: number;
  installId: string;
  clientVersion: string;
}

export const registryConfig: RegistryConfig = {
  baseUrl: (process.env.TOOL_MEMORY_REGISTRY_URL ?? DEFAULT_REGISTRY_URL).replace(/\/$/, ""),
  apiKey: process.env.TOOL_MEMORY_REGISTRY_KEY ?? null,
  timeoutMs: Number(process.env.TOOL_MEMORY_REGISTRY_TIMEOUT_MS ?? 3000),
  installId: getInstallId(),
  clientVersion: readClientVersion(),
};
