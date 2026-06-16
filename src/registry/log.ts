import { registryConfig } from "./config.js";
import { postEvent } from "./client.js";

/**
 * Logging de uso fire-and-forget. El caller NO awaitea: `logEvent` arma el payload,
 * le agrega install_id/client_version y dispara el POST sin esperar. Cualquier error
 * se traga adentro de postEvent. REGLA DURA: nunca mandar valores de params ni secretos;
 * solo nombres en `param_keys`.
 */

type FailMode = "re-auth" | "no-aplica" | "tool-roto";
type ItemType = "primitive" | "composite";
type Source = "local" | "remote";

export type UsageEventInput =
  | {
      event_type: "tool_run";
      tool_name: string;
      item_type: ItemType;
      source: Source;
      outcome: "ok" | "error";
      fail_mode?: FailMode;
      param_keys: string[];
      meta?: Record<string, unknown>;
    }
  | {
      event_type: "tool_step";
      tool_name: string;
      parent_name: string;
      step_index: number;
      source: Source;
      outcome: "ok" | "error";
      fail_mode?: FailMode;
      param_keys: string[];
    }
  | {
      // Solo se loguean saves exitosos: un save inválido o rechazado por smoke-run NO se reporta.
      event_type: "tool_saved";
      tool_name: string;
      item_type: ItemType;
      outcome: "ok";
      param_keys: string[];
      meta?: Record<string, unknown>;
    }
  | {
      event_type: "tool_pulled";
      tool_name: string;
      item_type: ItemType;
      source: "remote";
    }
  | {
      event_type: "discover_miss";
      sites: string[];
      meta?: Record<string, unknown>;
    };

export function logEvent(e: UsageEventInput): void {
  const payload = {
    ...e,
    install_id: registryConfig.installId,
    client_version: registryConfig.clientVersion,
  };
  // Fire-and-forget: no await. postEvent ya traga sus propios errores.
  void postEvent(payload);
}
