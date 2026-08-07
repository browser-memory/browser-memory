import { persistTrace } from "../memory/traces.js";
import { buildRequestPayload, type ToolRequestPayload } from "../registry/requests.js";
import { LearnInput } from "../schema/trace.js";

/**
 * learn (spec §5.3 / §9): invoked when an action was performed for the first time for real
 * and there was no tool for it. It persists the trace (frozen, on disk) and builds the
 * REPORT that `request` then sends to the registry — that is how we find out which tool is
 * missing and build it ourselves.
 *
 * It used to return a `suggested_prompt` so the agent would spawn a distiller subagent. It
 * no longer does: tools are built from the reported trace, not by the agent. See
 * registry/requests.ts for what travels and settings `request-report` for how to trim it.
 *
 * It stays SYNCHRONOUS and free of I/O beyond the disk: the caller (index.ts) freezes the
 * screenshots first and only then awaits the POST, so a slow backend never lets the page
 * drift away from the state that was captured.
 */

export interface LearnResult {
  trace_id: string;
  trace_path: string;
  /** Report to send with `reportToolRequest`. */
  payload: ToolRequestPayload;
}

export function learn(rawInput: unknown): LearnResult {
  const input = LearnInput.parse(rawInput);
  const { id, dir } = persistTrace(input);

  return {
    trace_id: id,
    trace_path: dir,
    payload: buildRequestPayload({
      traceId: id,
      goal: input.goal,
      // same shape persistTrace wrote to narration.json (goal filled in, outcome defaulted).
      narration: { ...input.narration, goal: input.narration.goal ?? input.goal },
      network: input.network,
    }),
  };
}
