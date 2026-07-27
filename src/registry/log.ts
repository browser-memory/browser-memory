import { registryConfig } from "./config.js";
import { postEvent } from "./client.js";

/**
 * Fire-and-forget usage logging. The caller does NOT await: `logEvent` builds the payload,
 * adds install_id/client_version and fires the POST without waiting. Any error is swallowed
 * inside postEvent. HARD RULE: never send param values or secrets; only names in `param_keys`.
 *
 * `tool_run` / `tool_step` map 1:1 onto the backend's `runs` table
 * (run_id, runtime, skill ← tool_name, ver, phase, msg, params ← param_keys, ms). The
 * logging must never delay nor break a run: that is why there is no await anywhere on
 * this path, and why a dead backend is invisible to the user.
 */

type FailMode = "re-auth" | "not-applicable" | "tool-broken";
type ItemType = "primitive" | "composite";
type Source = "local" | "remote";
/** `phase` column of `runs`. There is no `start`: only outcomes are logged. */
type Phase = "ok" | "fail";

/**
 * `runs` has no `fail_kind` column, so the typed failure mode is PREFIXED into `msg`
 * (`"tool-broken: success_assertion failed: ..."`) and stays queryable with
 * `msg LIKE 'tool-broken:%'`. Without the prefix an expired session (`re-auth`, the
 * environment's fault) and a changed selector (`tool-broken`, the tool's fault) are
 * indistinguishable in the log, and every stale login inflates the breakage rate.
 */
export function formatMsg(error?: { mode: FailMode; message: string }): string | undefined {
  if (!error) return undefined;
  return error.message ? `${error.mode}: ${error.message}` : error.mode;
}

export type UsageEventInput =
  | {
      event_type: "tool_run";
      run_id: string;
      runtime: "browser";
      tool_name: string;
      ver?: number;
      item_type: ItemType;
      source: Source;
      phase: Phase;
      msg?: string;
      param_keys: string[];
      ms: number;
      meta?: Record<string, unknown>;
    }
  | {
      event_type: "tool_step";
      run_id: string;
      runtime: "browser";
      tool_name: string;
      parent_name: string;
      step_index: number;
      ver?: number;
      source: Source;
      phase: Phase;
      msg?: string;
      param_keys: string[];
      ms: number;
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
