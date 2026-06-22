import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  existsSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { paths } from "../config.js";
import {
  parseMemoryItem,
  toIndexEntry,
  isComposite,
  type Tool,
  type Composite,
  type MemoryItem,
  type IndexEntry,
} from "../schema/tool.js";
import { lintTool } from "./lint.js";

/**
 * On-disk memory (spec §10): tools/<name>.json + index.json. Stores primitives and
 * composites in the same tree. Readable and versionable files, no database.
 */

function ensureDirs(): void {
  mkdirSync(paths.tools, { recursive: true });
  mkdirSync(paths.traces, { recursive: true });
}

function itemPath(name: string): string {
  return join(paths.tools, `${name}.json`);
}

/**
 * Normalizes a `site` to a comparable domain: lowercase, without scheme (http/https),
 * without `www.` and without path. E.g.: "https://www.Infobae.com/x" → "infobae.com". Both
 * the save (this module) and the discovery over the requested term apply it.
 */
export function normalizeSite(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

/**
 * Saves an item, ALWAYS validating it before persisting. Two gates, both static
 * (they don't touch the browser):
 *  1. schema (parseMemoryItem) — the shape.
 *  2. lint (primitives only) — the param wiring: well-formed placeholders, used params,
 *     extractor that reads from `params`. It's the only net for tools that can't be
 *     smoke-run (write-irreversible). The read smoke-run lives in the `save` handler.
 */
export function saveItem(raw: unknown): MemoryItem {
  ensureDirs();
  const item = parseMemoryItem(raw);
  if (isComposite(item)) {
    // Discovery is per-site: a composite without `site` would be undiscoverable. If the
    // distiller didn't set it, we derive it from the site of the first tool in its chain
    // (primitives are saved before the composite).
    if (!item.site) item.site = deriveCompositeSite(item);
  } else {
    const problems = lintTool(item);
    if (problems.length) {
      throw new Error(
        `lint rejected '${item.name}':\n- ${problems.join("\n- ")}`,
      );
    }
  }
  // Site always normalized on disk (without scheme/www/path) so the exact-domain
  // match of discovery works.
  if (item.site) item.site = normalizeSite(item.site);
  writeFileSync(itemPath(item.name), JSON.stringify(item, null, 2) + "\n");
  reindex();
  return item;
}

/** Site of a composite = that of the first tool in its chain that's already in memory. */
function deriveCompositeSite(c: Composite): string | undefined {
  for (const step of c.chain) {
    try {
      const t = loadItem(step.tool);
      if (t.site) return t.site;
    } catch {
      // the referenced tool isn't in memory yet; we try the next step.
    }
  }
  return undefined;
}

/** Deletes an item from memory (used to revert a save that didn't pass the smoke-run). */
export function removeItem(name: string): void {
  const p = itemPath(name);
  if (existsSync(p)) rmSync(p);
  reindex();
}

/** Backwards-compatible alias: saves a primitive. */
export function saveTool(raw: unknown): Tool {
  const item = saveItem(raw);
  if (isComposite(item)) {
    throw new Error(`${item.name} is a composite, use saveItem/saveComposite`);
  }
  return item;
}

export function loadItem(name: string): MemoryItem {
  const p = itemPath(name);
  if (!existsSync(p)) {
    throw new Error(`Item not found in memory: ${name}`);
  }
  return parseMemoryItem(JSON.parse(readFileSync(p, "utf8")));
}

/** Loads a primitive; throws if the item is a composite. */
export function loadTool(name: string): Tool {
  const item = loadItem(name);
  if (isComposite(item)) throw new Error(`${name} is a composite, not a primitive`);
  return item;
}

export function loadComposite(name: string): Composite {
  const item = loadItem(name);
  if (!isComposite(item)) throw new Error(`${name} is not a composite`);
  return item;
}

export function listItems(): MemoryItem[] {
  if (!existsSync(paths.tools)) return [];
  return readdirSync(paths.tools)
    .filter((f) => f.endsWith(".json"))
    .map((f) => parseMemoryItem(JSON.parse(readFileSync(join(paths.tools, f), "utf8"))));
}

/** Rebuilds index.json from the items on disk. */
export function reindex(): IndexEntry[] {
  ensureDirs();
  const entries = listItems().map(toIndexEntry);
  writeFileSync(paths.index, JSON.stringify(entries, null, 2) + "\n");
  return entries;
}

export function listIndex(): IndexEntry[] {
  if (!existsSync(paths.index)) return reindex();
  return JSON.parse(readFileSync(paths.index, "utf8")) as IndexEntry[];
}
