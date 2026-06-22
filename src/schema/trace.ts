import { z } from "zod";

/**
 * Trace schema (spec §10.4): the record of a real successful run from which a tool is
 * learned. The agent itself builds it with narration + network + screenshots (without
 * intercepting nor parsing the browser's internal formats).
 */

/**
 * A canonical step of the path that worked (separated from exploration noise).
 * The narration is DOCUMENTATION that the distiller reads, it's not executed — that's
 * why the schema is lax: `action` is a free label (navigate, click, parse, extract...)
 * and almost everything is optional. The idea is that `learn` never rejects a
 * reasonable narration.
 */
export const NarrationStep = z.object({
  intent: z.string().optional(),
  action: z.string(),
  url: z.string().optional(),
  selector: z.string().optional(),
  value: z.string().optional(),
});
export type NarrationStep = z.infer<typeof NarrationStep>;

export const Narration = z.object({
  // goal/site/success_signal: optional. goal is filled from learn()'s goal if missing
  // (no need to duplicate it inside the narration).
  goal: z.string().optional(),
  site: z.string().optional(),
  outcome: z.enum(["ok", "fail"]).default("ok"),
  success_signal: z.string().optional(),
  auth: z.string().optional(),
  steps: z.array(NarrationStep).min(1),
  /** DOM reader function for read tools (serialized as a string). */
  reader_fn: z.string().optional(),
  /** Candidate for a direct HTTP path, if network showed a clean endpoint. */
  api_candidate: z
    .object({
      method: z.string(),
      url: z.string(),
      jsonPath: z.string().optional(),
    })
    .nullable()
    .optional(),
});
export type Narration = z.infer<typeof Narration>;

export const TraceMeta = z.object({
  id: z.string(),
  goal: z.string(),
  outcome: z.enum(["ok", "fail"]),
  success_signal: z.string().optional(),
  site: z.string().optional(),
  ts: z.string(),
});
export type TraceMeta = z.infer<typeof TraceMeta>;

/** Payload the agent passes to learn() to persist the trace. */
export const LearnInput = z.object({
  goal: z.string(),
  narration: Narration,
  /** Raw output of browser_network_requests (optional). */
  network: z.unknown().optional(),
  /** Output of browser_console_messages (optional). */
  console: z.unknown().optional(),
});
export type LearnInput = z.infer<typeof LearnInput>;
