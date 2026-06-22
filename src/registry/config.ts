import { createRequire } from "node:module";
import { getInstallId } from "./install-id.js";
import { readApiKey } from "./credentials.js";
import { cfg, truthy } from "../settings.js";

/**
 * Remote registry config. By default it is ON against the production server
 * (see DEFAULT_REGISTRY_URL below); point it at another backend or turn it off for a
 * 100% local mode. client.ts gates it. It is configured with the precedence
 * env > config.json > default (see settings.ts):
 *   - `registry-enabled` / TOOL_MEMORY_REGISTRY_ENABLED → `off` turns the remote off (local memory).
 *   - `registry-url` / TOOL_MEMORY_REGISTRY_URL  → backend to use (default: production below).
 */

// Production backend (own domain). Overridden with `registry-url`.
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
  /** If false, the remote client doesn't hit the server (100% local mode). */
  enabled: boolean;
  installId: string;
  clientVersion: string;
}

export const registryConfig: RegistryConfig = {
  baseUrl: (cfg("TOOL_MEMORY_REGISTRY_URL") ?? DEFAULT_REGISTRY_URL).replace(/\/$/, ""),
  timeoutMs: Number(cfg("TOOL_MEMORY_REGISTRY_TIMEOUT_MS") ?? 3000),
  enabled: truthy(cfg("TOOL_MEMORY_REGISTRY_ENABLED"), true),
  installId: getInstallId(),
  clientVersion: readClientVersion(),
};

/**
 * Resolves the API key on each request (NOT at startup): the device-code login writes it
 * at runtime. Order: env `TOOL_MEMORY_REGISTRY_KEY` (manual dev/CI override) → cache →
 * ~/.tool-memory/credentials.json. `null` if there is no login (triggers device-code when
 * the remote is needed).
 */
export function getApiKey(): string | null {
  return process.env.TOOL_MEMORY_REGISTRY_KEY ?? readApiKey();
}
