import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { join } from "node:path";
import { paths } from "../config.js";
import {
  Narration,
  TraceMeta,
  type LearnInput,
  type Narration as NarrationT,
} from "../schema/trace.js";

/**
 * Trace store (spec §10.4). Persists the narration + network + meta of a real
 * successful run, frozen so the distiller can read it in the background.
 */

function nextTraceId(): string {
  if (!existsSync(paths.traces)) return "trace-001";
  const nums = readdirSync(paths.traces)
    .map((d) => /^trace-(\d+)$/.exec(d)?.[1])
    .filter((n): n is string => !!n)
    .map(Number);
  const next = (nums.length ? Math.max(...nums) : 0) + 1;
  return `trace-${String(next).padStart(3, "0")}`;
}

export interface PersistedTrace {
  id: string;
  dir: string;
}

/** Validates and persists a trace; returns its id and folder. */
export function persistTrace(input: LearnInput): PersistedTrace {
  const parsed: NarrationT = Narration.parse(input.narration);
  // We fill goal/site from the learn() level if the narration doesn't carry them.
  const narration: NarrationT = {
    ...parsed,
    goal: parsed.goal ?? input.goal,
  };
  const id = nextTraceId();
  const dir = join(paths.traces, id);
  mkdirSync(join(dir, "screenshots"), { recursive: true });

  const meta = TraceMeta.parse({
    id,
    goal: input.goal,
    outcome: narration.outcome,
    success_signal: narration.success_signal,
    site: narration.site,
    ts: new Date().toISOString(),
  });

  writeFileSync(join(dir, "meta.json"), JSON.stringify(meta, null, 2) + "\n");
  writeFileSync(
    join(dir, "narration.json"),
    JSON.stringify(narration, null, 2) + "\n",
  );
  if (input.network !== undefined) {
    writeFileSync(
      join(dir, "network.json"),
      JSON.stringify(input.network, null, 2) + "\n",
    );
  }
  if (input.console !== undefined) {
    writeFileSync(
      join(dir, "console.json"),
      JSON.stringify(input.console, null, 2) + "\n",
    );
  }

  return { id, dir };
}

/** Reads an already-persisted trace (used by the distiller). */
export function readTrace(id: string): {
  meta: unknown;
  narration: unknown;
  network?: unknown;
} {
  const dir = join(paths.traces, id);
  if (!existsSync(dir)) throw new Error(`Trace not found: ${id}`);
  const read = (f: string) =>
    existsSync(join(dir, f))
      ? JSON.parse(readFileSync(join(dir, f), "utf8"))
      : undefined;
  return {
    meta: read("meta.json"),
    narration: read("narration.json"),
    network: read("network.json"),
  };
}
