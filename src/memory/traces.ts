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
 * Store de traces (spec §10.4). Persiste la narración + network + meta de un run
 * real exitoso, congelada para que el distiller la lea en background.
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

/** Valida y persiste una trace; devuelve su id y carpeta. */
export function persistTrace(input: LearnInput): PersistedTrace {
  const parsed: NarrationT = Narration.parse(input.narration);
  // Completamos goal/site desde el nivel de learn() si la narración no los trae.
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

/** Lee una trace ya persistida (la usa el distiller). */
export function readTrace(id: string): {
  meta: unknown;
  narration: unknown;
  network?: unknown;
} {
  const dir = join(paths.traces, id);
  if (!existsSync(dir)) throw new Error(`Trace no encontrada: ${id}`);
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
