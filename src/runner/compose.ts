import { run, injectParams, bumpHealth, type RunResult } from "./execute.js";
import { resolveItem, isRemoteSource } from "../registry/resolve.js";
import { logEvent, formatMsg } from "../registry/log.js";
import { newRunId } from "../registry/run-id.js";
import { isComposite } from "../schema/tool.js";
import type { ChainStep, Composite } from "../schema/tool.js";

/**
 * Composite runner (spec §10.2 / §4): runs each tool in the chain in order,
 * maps out → in (the glue is a handle, stable data), and ABORTS the chain if an
 * input precondition fails, reporting at which step. Each tool is self-contained:
 * it re-establishes its context by navigating to the handle it receives.
 *
 * (E4 = composition. Self-repair / re-learn is out of scope.)
 */

export interface ComposeStepResult {
  tool: string;
  ok: boolean;
  out?: { name: string; value: unknown };
  error?: RunResult["error"];
}

export interface ComposeResult {
  ok: boolean;
  steps: ComposeStepResult[];
  /** handles accumulated at the end (params + outs). */
  handles: Record<string, unknown>;
  /** step where it aborted, if it aborted. */
  aborted_at?: { index: number; tool: string };
}

/**
 * Extracts the value of the `out` handle from a tool's result. If the result is an
 * object with a key equal to the handle's name, it uses that field; otherwise it uses
 * the whole result (scalar handle, e.g. a URL).
 */
function extractHandle(result: unknown, outName: string): unknown {
  if (result && typeof result === "object" && !Array.isArray(result)) {
    const obj = result as Record<string, unknown>;
    if (outName in obj) return obj[outName];
  }
  return result;
}

/** Resolves a step's inputs from the available handles (params + outs). */
function resolveInputs(
  stepIn: ChainStep["in"],
  handles: Record<string, unknown>,
): Record<string, unknown> {
  const resolved: Record<string, unknown> = {};
  for (const [param, template] of Object.entries(stepIn)) {
    resolved[param] = injectParams(template, handles);
  }
  return resolved;
}

export async function runComposite(
  name: string,
  params: Record<string, unknown> = {},
  /** Correlation id of the top-level call, shared by every step (see registry/run-id.ts). */
  runId: string = newRunId(),
): Promise<ComposeResult> {
  const handles: Record<string, unknown> = { ...params };
  const steps: ComposeStepResult[] = [];

  // Unified resolution (Option A): a composite can also live on the server.
  let composite: Composite;
  let remote = false;
  try {
    const resolved = await resolveItem(name);
    remote = isRemoteSource(resolved.source);
    if (!isComposite(resolved.item)) {
      return {
        ok: false,
        steps: [
          { tool: name, ok: false, error: { mode: "not-applicable", message: `${name} is not a composite` } },
        ],
        handles,
      };
    }
    composite = resolved.item;
  } catch (e) {
    return {
      ok: false,
      steps: [{ tool: name, ok: false, error: { mode: "not-applicable", message: (e as Error).message } }],
      handles,
    };
  }

  for (let i = 0; i < composite.chain.length; i++) {
    const link = composite.chain[i];

    let inputs: Record<string, unknown>;
    try {
      inputs = resolveInputs(link.in, handles);
    } catch (e) {
      // A handle that an earlier step should have produced is missing → we abort.
      steps.push({
        tool: link.tool,
        ok: false,
        error: { mode: "not-applicable", message: (e as Error).message },
      });
      return { ok: false, steps, handles, aborted_at: { index: i, tool: link.tool } };
    }

    const startedStep = Date.now();
    const res = await run(link.tool, inputs);
    // One event per chain step (requested granularity): measures which primitive fails.
    logEvent({
      event_type: "tool_step",
      run_id: runId,
      runtime: "browser",
      tool_name: link.tool,
      parent_name: name,
      step_index: i,
      ver: res.version,
      source: res.source ?? "local",
      phase: res.ok ? "ok" : "fail",
      msg: formatMsg(res.error),
      param_keys: Object.keys(inputs),
      ms: Date.now() - startedStep,
    });
    if (!res.ok) {
      // Precondition or execution failed: we abort the chain reporting where.
      // Same rule as the primitive runner: ONLY tool-broken counts against health.
      // A re-auth/not-applicable comes from the environment and must not inflate the
      // composite's fail_count (nor reset its last_ok).
      if (res.error?.mode === "tool-broken") bumpHealth(composite, false, remote);
      steps.push({ tool: link.tool, ok: false, error: res.error });
      return { ok: false, steps, handles, aborted_at: { index: i, tool: link.tool } };
    }

    const stepResult: ComposeStepResult = { tool: link.tool, ok: true };
    if (link.out) {
      const value = extractHandle(res.result, link.out);
      handles[link.out] = value;
      stepResult.out = { name: link.out, value };
    }
    steps.push(stepResult);
  }

  bumpHealth(composite, true, remote);
  return { ok: true, steps, handles };
}
