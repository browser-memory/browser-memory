import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../config.js";

/**
 * Anonymous, stable identifier of the installation, to group usage in the logs
 * WITHOUT PII. A random UUID is generated the first time and stored in ~/.tool-memory/install-id
 * (outside tools/). It is not derived from hostname or anything about the machine.
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
    // If we can't persist (read-only FS, etc.), we use an ephemeral process id.
    cached = cached ?? randomUUID();
    return cached;
  }
}
