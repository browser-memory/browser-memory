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
 * Memoria en disco (spec §10): tools/<name>.json + index.json. Guarda primitivas y
 * composites en el mismo árbol. Archivos legibles y versionables, sin base de datos.
 */

function ensureDirs(): void {
  mkdirSync(paths.tools, { recursive: true });
  mkdirSync(paths.traces, { recursive: true });
}

function itemPath(name: string): string {
  return join(paths.tools, `${name}.json`);
}

/**
 * Guarda un item validándolo SIEMPRE antes de persistir. Dos puertas, ambas estáticas
 * (no tocan el navegador):
 *  1. esquema (parseMemoryItem) — la forma.
 *  2. lint (solo primitivas) — el cableado de params: placeholders bien formados, params
 *     usados, extractor que lee de `params`. Es la única red para tools que no se pueden
 *     smoke-runear (write-irreversible). El smoke-run de lectura vive en el handler `save`.
 */
export function saveItem(raw: unknown): MemoryItem {
  ensureDirs();
  const item = parseMemoryItem(raw);
  if (!isComposite(item)) {
    const problems = lintTool(item);
    if (problems.length) {
      throw new Error(
        `lint rechazó '${item.name}':\n- ${problems.join("\n- ")}`,
      );
    }
  }
  writeFileSync(itemPath(item.name), JSON.stringify(item, null, 2) + "\n");
  reindex();
  return item;
}

/** Borra un item de la memoria (usado para revertir un save que no pasó el smoke-run). */
export function removeItem(name: string): void {
  const p = itemPath(name);
  if (existsSync(p)) rmSync(p);
  reindex();
}

/** Alias retro-compatible: guarda una primitiva. */
export function saveTool(raw: unknown): Tool {
  const item = saveItem(raw);
  if (isComposite(item)) {
    throw new Error(`${item.name} es composite, usá saveItem/saveComposite`);
  }
  return item;
}

export function loadItem(name: string): MemoryItem {
  const p = itemPath(name);
  if (!existsSync(p)) {
    throw new Error(`Item no encontrado en memoria: ${name}`);
  }
  return parseMemoryItem(JSON.parse(readFileSync(p, "utf8")));
}

/** Carga una primitiva; lanza si el item es un composite. */
export function loadTool(name: string): Tool {
  const item = loadItem(name);
  if (isComposite(item)) throw new Error(`${name} es composite, no primitiva`);
  return item;
}

export function loadComposite(name: string): Composite {
  const item = loadItem(name);
  if (!isComposite(item)) throw new Error(`${name} no es composite`);
  return item;
}

export function listItems(): MemoryItem[] {
  if (!existsSync(paths.tools)) return [];
  return readdirSync(paths.tools)
    .filter((f) => f.endsWith(".json"))
    .map((f) => parseMemoryItem(JSON.parse(readFileSync(join(paths.tools, f), "utf8"))));
}

/** Reconstruye index.json a partir de los items en disco. */
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
