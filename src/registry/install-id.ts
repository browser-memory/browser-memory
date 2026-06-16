import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config.js";

/**
 * Identificador anónimo y estable de la instalación, para agrupar el uso en los logs
 * SIN PII. Se genera un UUID al azar la primera vez y se guarda en ~/.tool-memory/install-id
 * (fuera de tools/). No deriva de hostname ni de nada de la máquina.
 */
let cached: string | null = null;

export function getInstallId(): string {
  if (cached) return cached;
  const file = join(paths.root, "install-id");
  try {
    if (existsSync(file)) {
      const v = readFileSync(file, "utf8").trim();
      if (v) {
        cached = v;
        return v;
      }
    }
    const id = randomUUID();
    mkdirSync(paths.root, { recursive: true });
    writeFileSync(file, id + "\n");
    cached = id;
    return id;
  } catch {
    // Si no podemos persistir (FS de solo lectura, etc.), usamos un id efímero del proceso.
    cached = cached ?? randomUUID();
    return cached;
  }
}
