import { registryConfig } from "./config.js";
import { postEvent } from "./client.js";

/**
 * Fire-and-forget usage logging. The caller does NOT await: `logEvent` builds the payload,
 * adds install_id/client_version and fires the POST without waiting. Any error is swallowed
 * inside postEvent. HARD RULE: never send param values or secrets; only names in `param_keys`.
 */

type FailMode = "re-auth" | "not-applicable" | "tool-broken";
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
      // Only successful saves are logged: an invalid save or one rejected by smoke-run is NOT reported.
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
  // Fire-and-forget: no await. postEvent already swallows its own errors.
  void postEvent(payload);
}
