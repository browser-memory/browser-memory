/**
 * E2E del canal REMOTO contra el backend real (Railway). Ejercita auth + discovery + pull
 * + gating, SIN tocar el navegador (no corre recetas: eso ya lo cubre `npm run smoke`).
 *
 *   TOOL_MEMORY_REGISTRY_URL=https://<tu-railway> \
 *   TOOL_MEMORY_REGISTRY_KEY=<key de /app> \
 *   npm run e2e:remote
 *
 * OJO con la cuota: el rate-limit del server es CUMULATIVO por usuario (no se resetea).
 * Cada corrida gasta ~2 usos (1 index + 1 tool). El check de auth con key inválida NO
 * gasta cuota (el server corta en 401 antes del contador).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Aislamos la memoria local (no queremos que un tool local tape el pull remoto).
process.env.TOOL_MEMORY_HOME = mkdtempSync(join(tmpdir(), "tm-e2e-remote-"));

const { fetchRemoteSites, fetchRemoteIndex, RegistryAuthError } = await import(
  "../src/registry/client.js"
);
const { resolveItem, isRemoteSource } = await import("../src/registry/resolve.js");
const { registryConfig } = await import("../src/registry/config.js");

function log(...a: unknown[]): void {
  console.log(...a);
}
function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`✗ ${msg}`);
}

async function main(): Promise<void> {
  assert(process.env.TOOL_MEMORY_REGISTRY_KEY, "falta TOOL_MEMORY_REGISTRY_KEY");
  log(`== E2E remoto contra ${registryConfig.baseUrl} ==\n`);

  // 1. AUTH OK: con key válida, /sites responde sin lanzar (200). /sites no gasta cuota.
  log("[1] auth con key válida (GET /v1/registry/sites)...");
  const sites = await fetchRemoteSites();
  assert(Array.isArray(sites), "fetchRemoteSites debió devolver un array (auth ok)");
  log(`    ✓ ${sites.length} sitio(s) remoto(s): ${sites.map((s) => s.site).join(", ") || "(vacío)"}\n`);

  // 2. DISCOVERY + 3. PULL: solo si el registro tiene algo curado.
  if (sites.length) {
    const site = sites[0].site;
    log(`[2] discovery remoto (GET /v1/registry/index?sites=${site})...`);
    const entries = await fetchRemoteIndex([site]);
    assert(entries.length > 0, `el índice de '${site}' vino vacío`);
    log(`    ✓ ${entries.length} tool(s): ${entries.map((e) => e.name).join(", ")}\n`);

    const name = entries[0].name;
    log(`[3] pull determinista (GET /v1/registry/tool/${name})...`);
    const resolved = await resolveItem(name);
    assert(resolved.item.name === name, "el item resuelto no coincide con el pedido");
    assert(isRemoteSource(resolved.source), `esperaba origen remoto, fue '${resolved.source}'`);
    log(`    ✓ resuelto '${name}' desde ${resolved.source}\n`);
  } else {
    log("[2-3] registro remoto vacío → salteo discovery/pull (auth ya validada)\n");
  }

  // 4. GATING: con key inválida, el server debe responder 401 → RegistryAuthError.
  log("[4] gating: key inválida debe dar 401 → RegistryAuthError...");
  const goodKey = process.env.TOOL_MEMORY_REGISTRY_KEY;
  process.env.TOOL_MEMORY_REGISTRY_KEY = "bmk_invalida_e2e";
  let threw: unknown = null;
  try {
    await fetchRemoteSites();
  } catch (e) {
    threw = e;
  }
  process.env.TOOL_MEMORY_REGISTRY_KEY = goodKey;
  assert(threw instanceof RegistryAuthError, "una key inválida debió lanzar RegistryAuthError");
  log(`    ✓ 401 propagado como RegistryAuthError (status ${(threw as InstanceType<typeof RegistryAuthError>).status})\n`);

  log("== ✓ E2E remoto OK ==");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`\n${(e as Error).message}\n`);
    process.exit(1);
  },
);
