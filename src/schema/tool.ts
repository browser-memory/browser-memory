import { z } from "zod";

/**
 * Tool schema (spec §10.1) and Index schema (§10.3).
 *
 * A Tool is the central unit: a modular, parameterized, reusable web action.
 * It holds an executable recipe, its preconditions (requires) and a MANDATORY success
 * assertion (the safety net that replaces proactive verification).
 *
 * In the MVP we only model primitives (type: "primitive").
 */

export const SideEffect = z.enum([
  "read",
  "write-reversible",
  "write-irreversible",
]);
export type SideEffect = z.infer<typeof SideEffect>;

// --- Recipe: the executable part -------------------------------------------------

/** A Playwright step. `value`/`url`/`expr` accept {{param}} placeholders. */
export const PlaywrightStep = z.object({
  action: z.enum([
    "navigate",
    "assert_precondition",
    "click",
    "type",
    "fill",
    "press",
    "wait_for",
    "upload",
  ]),
  url: z.string().optional(),
  selector: z.string().optional(),
  value: z.string().optional(),
  /** For assert_precondition / wait_for: selector or expression to wait for. */
  expr: z.string().optional(),
  /** One-off timeout in ms (reasonable default in the runner). */
  timeoutMs: z.number().int().positive().optional(),
  /**
   * If true, the step is SKIPPED when some {{param}} it references was not provided.
   * Useful for steps that depend on an OPTIONAL param (e.g. uploading an image to a
   * tweet): with the param present the step runs, without it it's skipped without
   * breaking the tool.
   */
  optional: z.boolean().optional(),
});
export type PlaywrightStep = z.infer<typeof PlaywrightStep>;

export const PlaywrightRecipe = z.object({
  kind: z.literal("playwright"),
  steps: z.array(PlaywrightStep).min(1),
});

export const HttpRecipe = z.object({
  kind: z.literal("http"),
  method: z.enum(["GET", "POST", "PUT", "PATCH", "DELETE"]),
  url: z.string(),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  /** JSON path to the data within the response (e.g. "data.results"). */
  jsonPath: z.string().optional(),
});

/**
 * An in-page `fetch` replayed from the site's own origin.
 *
 * The middle ground between the two above, and usually the best of the three. `http`
 * calls the endpoint from Node, so it carries NO cookies and dies on anything that
 * needs a session; `playwright` drives the UI, which works but is slow and fragile.
 * Here the request runs INSIDE the tab, same-origin, so the browser attaches the
 * session by itself — and because the worker tab for that origin usually already is on
 * the site (browser/worker-tabs.ts), replaying costs one `evaluate` and no navigation.
 *
 * `fn` is a serialized async function called as `(params)` in the page, exactly like a
 * dom extractor: it must read its inputs from `params.<name>` and must not rely on
 * eval/Function (blocked by many sites' CSP). It returns the data.
 */
export const FetchReplayRecipe = z.object({
  kind: z.literal("fetch-replay"),
  /** Origin the fetch must run from, e.g. "https://www.linkedin.com". */
  origin: z.string(),
  /** Serialized async fn, called as (params) inside the page. Returns the data. */
  fn: z.string(),
  /** Page to land on when the tab isn't on `origin` yet. Defaults to `origin`. */
  url: z.string().optional(),
});

export const Recipe = z.discriminatedUnion("kind", [
  PlaywrightRecipe,
  HttpRecipe,
  FetchReplayRecipe,
]);
export type Recipe = z.infer<typeof Recipe>;

// --- Preconditions / postcondition -----------------------------------------------

export const Requires = z.object({
  /** Data preconditions: params/handles. Map name → descriptive type. */
  params: z.record(z.string()).default({}),
  /** Environment preconditions: ambient state verified by effect (§7). */
  env: z.record(z.string()).default({}),
});

/** Reads data from the DOM (evaluate) or from the http response JSON (jsonPath). */
export const ResultExtractor = z.union([
  z.object({ type: z.literal("dom"), fn: z.string() }),
  z.object({ type: z.literal("json"), jsonPath: z.string() }),
]);
export type ResultExtractor = z.infer<typeof ResultExtractor>;

/**
 * Cheap, deterministic check that confirms success. MANDATORY (§7).
 *
 * `within_ms` (dom/text): retry window. Many confirmers are asynchronous or transient
 * (Gmail's "Message sent" toast appears after the network submit and disappears within
 * seconds); a single synchronous check right after the click loses them to a race. With
 * `within_ms` the runner retries until it holds or the window is exhausted. Reasonable
 * default in the runner; raise it for slow confirmers.
 *
 * `text.contains` accepts a string or a LIST of alternatives (match = any): hardens
 * against wording/language variants ("Message sent" / "Your message has been sent" /
 * "Mensaje enviado").
 */
export const SuccessAssertion = z.union([
  z.object({
    type: z.literal("dom"),
    expr: z.string(),
    within_ms: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal("text"),
    contains: z.union([z.string(), z.array(z.string()).min(1)]),
    within_ms: z.number().int().positive().optional(),
  }),
  z.object({ type: z.literal("json"), jsonPath: z.string() }),
]);
export type SuccessAssertion = z.infer<typeof SuccessAssertion>;

// --- Primitive tool --------------------------------------------------------------

export const ToolSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive().default(1),
  site: z.string().min(1),
  intent: z.string().min(1),
  keywords: z.array(z.string()).default([]),
  type: z.literal("primitive"),
  side_effect: SideEffect,
  requires: Requires,
  provides: z.object({ result: z.record(z.string()) }).optional(),
  recipe: Recipe,
  /** Step from which the action is irreversible (write-irreversible). */
  commit_step_index: z.number().int().nonnegative().optional(),
  result_extractor: ResultExtractor.optional(),
  success_assertion: SuccessAssertion, // mandatory
  auth: z
    .object({ needs: z.string(), via: z.string() })
    .nullable()
    .optional(),
  provenance: z
    .object({
      learned_at: z.string().nullable().optional(),
      from_trace: z.string().nullable().optional(),
      source_url: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  health: z
    .object({
      last_ok: z.string().nullable().default(null),
      fail_count: z.number().int().nonnegative().default(0),
    })
    .default({ last_ok: null, fail_count: 0 }),
});
export type Tool = z.infer<typeof ToolSchema>;

// --- Composite (spec §10.2) ------------------------------------------------------

/**
 * A chain step: runs `tool`, maps its inputs from params/handles (`in`), and
 * optionally saves its result as a handle (`out`) that later steps consume. The glue
 * is stable data (a handle), not live browser state.
 */
export const ChainStep = z.object({
  tool: z.string(),
  in: z.record(z.string()).default({}),
  out: z.string().optional(),
});
export type ChainStep = z.infer<typeof ChainStep>;

export const CompositeSchema = z.object({
  name: z.string().min(1),
  version: z.number().int().positive().default(1),
  type: z.literal("composite"),
  site: z.string().optional(),
  intent: z.string().min(1),
  keywords: z.array(z.string()).default([]),
  params: z.record(z.string()).default({}),
  chain: z.array(ChainStep).min(1),
  provenance: z
    .object({
      learned_at: z.string().nullable().optional(),
      from_trace: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  health: z
    .object({
      last_ok: z.string().nullable().default(null),
      fail_count: z.number().int().nonnegative().default(0),
    })
    .default({ last_ok: null, fail_count: 0 }),
});
export type Composite = z.infer<typeof CompositeSchema>;

/** Any memory item: primitive or composite. */
export type MemoryItem = Tool | Composite;

// --- Index -----------------------------------------------------------------------

export const IndexEntry = z.object({
  name: z.string(),
  site: z.string(),
  type: z.enum(["primitive", "composite"]),
  intent: z.string(),
  keywords: z.array(z.string()),
  /** the item's side_effect; for composites it's the most severe of its chain (or read). */
  side_effect: SideEffect,
});
export type IndexEntry = z.infer<typeof IndexEntry>;

/** Validates and normalizes a raw object into a Tool. Throws ZodError if invalid. */
export function parseTool(raw: unknown): Tool {
  return ToolSchema.parse(raw);
}

export function parseComposite(raw: unknown): Composite {
  return CompositeSchema.parse(raw);
}

/** Detects the type and validates with the correct schema. */
export function parseMemoryItem(raw: unknown): MemoryItem {
  const type = (raw as { type?: string })?.type;
  return type === "composite" ? parseComposite(raw) : parseTool(raw);
}

export function isComposite(item: MemoryItem): item is Composite {
  return item.type === "composite";
}

export function toIndexEntry(item: MemoryItem): IndexEntry {
  if (isComposite(item)) {
    return {
      name: item.name,
      site: item.site ?? "",
      type: "composite",
      intent: item.intent,
      keywords: item.keywords,
      side_effect: "read", // the composite runner computes the real one at execution time
    };
  }
  return {
    name: item.name,
    site: item.site,
    type: item.type,
    intent: item.intent,
    keywords: item.keywords,
    side_effect: item.side_effect,
  };
}
