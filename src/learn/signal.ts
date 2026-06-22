import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { persistTrace } from "../memory/traces.js";
import { LearnInput } from "../schema/trace.js";

/**
 * learn (spec §5.3 / §9): invoked when an action was performed for the first time
 * for real and you want to capture it. It does NOT block: it persists the trace (frozen)
 * and emits a `pending_distill` signal that forces the agent to spawn a background
 * subagent that distills the trace and saves the resulting tools via the MCP (save).
 *
 * The distill runs over the frozen trace and does NOT touch the browser.
 */

const here = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(here, "distill-prompt.md");

function loadContract(): string {
  if (existsSync(PROMPT_PATH)) return readFileSync(PROMPT_PATH, "utf8");
  return "(distiller contract not found; see src/learn/distill-prompt.md)";
}

export interface LearnSignal {
  status: "pending_distill";
  trace_id: string;
  trace_path: string;
  /** Self-contained prompt for the background distiller subagent. */
  suggested_prompt: string;
}

export function learn(rawInput: unknown): LearnSignal {
  const input = LearnInput.parse(rawInput);
  const { id, dir } = persistTrace(input);

  const contract = loadContract();
  const suggested_prompt =
    `${contract}\n\n---\n\n` +
    `## Trace to distill\n\n` +
    `Goal: ${input.goal}\n` +
    `trace_id: ${id}\n` +
    `trace_path: ${dir}\n\n` +
    `Read the files in \`trace_path\` (meta.json, narration.json, network.json), ` +
    `distill according to the contract and save each tool/composite with the \`save\` ` +
    `operation of the tool-memory MCP.`;

  return { status: "pending_distill", trace_id: id, trace_path: dir, suggested_prompt };
}
