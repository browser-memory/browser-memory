/**
 * E2E of the REMOTE channel against the real backend (Railway). Exercises auth + discovery + pull
 * + gating, WITHOUT touching the browser (it does not run recipes: `npm run smoke` already covers that).
 *
 *   TOOL_MEMORY_REGISTRY_URL=https://<your-railway> \
 *   TOOL_MEMORY_REGISTRY_KEY=<key from /app> \
 *   npm run e2e:remote
 *
 * MIND the quota: the server's rate-limit is CUMULATIVE per user (it does not reset).
 * Each run spends ~2 uses (1 index + 1 tool). The auth check with an invalid key does NOT
 * spend quota (the server cuts off at 401 before the counter).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate the local memory (we don't want a local tool to shadow the remote pull).
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
  assert(process.env.TOOL_MEMORY_REGISTRY_KEY, "missing TOOL_MEMORY_REGISTRY_KEY");
  log(`== remote E2E against ${registryConfig.baseUrl} ==\n`);

  // 1. AUTH OK: with a valid key, /sites responds without throwing (200). /sites does not spend quota.
  log("[1] auth with a valid key (GET /v1/registry/sites)...");
  const sites = await fetchRemoteSites();
  assert(Array.isArray(sites), "fetchRemoteSites should have returned an array (auth ok)");
  log(`    ✓ ${sites.length} remote site(s): ${sites.map((s) => s.site).join(", ") || "(empty)"}\n`);

  // 2. DISCOVERY + 3. PULL: only if the registry has something curated.
  if (sites.length) {
    const site = sites[0].site;
    log(`[2] remote discovery (GET /v1/registry/index?sites=${site})...`);
    const entries = await fetchRemoteIndex([site]);
    assert(entries.length > 0, `the index for '${site}' came back empty`);
    log(`    ✓ ${entries.length} tool(s): ${entries.map((e) => e.name).join(", ")}\n`);

    const name = entries[0].name;
    log(`[3] deterministic pull (GET /v1/registry/tool/${name})...`);
    const resolved = await resolveItem(name);
    assert(resolved.item.name === name, "the resolved item does not match the requested one");
    assert(isRemoteSource(resolved.source), `expected a remote source, got '${resolved.source}'`);
    log(`    ✓ resolved '${name}' from ${resolved.source}\n`);
  } else {
    log("[2-3] remote registry empty → skipping discovery/pull (auth already validated)\n");
  }

  // 4. GATING: with an invalid key, the server must respond 401 → RegistryAuthError.
  log("[4] gating: an invalid key must give 401 → RegistryAuthError...");
  const goodKey = process.env.TOOL_MEMORY_REGISTRY_KEY;
  process.env.TOOL_MEMORY_REGISTRY_KEY = "bmk_invalida_e2e";
  let threw: unknown = null;
  try {
    await fetchRemoteSites();
  } catch (e) {
    threw = e;
  }
  process.env.TOOL_MEMORY_REGISTRY_KEY = goodKey;
  assert(threw instanceof RegistryAuthError, "an invalid key should have thrown RegistryAuthError");
  log(`    ✓ 401 propagated as RegistryAuthError (status ${(threw as InstanceType<typeof RegistryAuthError>).status})\n`);

  log("== ✓ remote E2E OK ==");
}

main().then(
  () => process.exit(0),
  (e) => {
    console.error(`\n${(e as Error).message}\n`);
    process.exit(1);
  },
);
