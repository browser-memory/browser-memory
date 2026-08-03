#!/usr/bin/env node
/**
 * `npm run bundle:verify` — proves the packed `.mcpb` actually runs on its own.
 *
 * Unpacks the bundle to a temp dir and speaks real MCP to it over stdio, exactly the way
 * a host would: spawn `node dist/index.js`, handshake, list the tools. It catches the two
 * failures that a passing `mcpb validate` would still let through — a missing production
 * dependency, and a package.json that lost `"type": "module"` (the ESM dist then loads as
 * CommonJS and the server dies on its first import).
 *
 * Everything is isolated: the memory goes to a throwaway TOOL_MEMORY_HOME and the remote
 * registry is off, so verifying never touches your real tools and never calls the backend.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const MCPB = join(ROOT, "browser-memory.mcpb");

/** Tools whose absence means the bundle is broken, not merely different. */
const MUST_HAVE = ["discover", "run", "request", "save", "bm_navigate", "bm_snapshot"];

if (!existsSync(MCPB)) {
  console.error(`✗ ${MCPB} not found — run \`npm run bundle\` first.`);
  process.exit(1);
}

const tmp = mkdtempSync(join(tmpdir(), "bm-bundle-"));
const unpacked = join(tmp, "unpacked");
let failed = false;

try {
  console.log(`▸ unpacking into ${unpacked}`);
  execFileSync("npx", ["mcpb", "unpack", MCPB, unpacked], { cwd: ROOT, stdio: "inherit" });

  for (const f of ["manifest.json", "package.json", "dist/index.js", "node_modules"]) {
    if (!existsSync(join(unpacked, f))) throw new Error(`bundle is missing ${f}`);
  }

  console.log("▸ starting the server the way a host would");
  const env = Object.fromEntries(Object.entries(process.env).filter(([, v]) => v != null));
  const transport = new StdioClientTransport({
    command: "node",
    args: [join(unpacked, "dist", "index.js")],
    cwd: unpacked,
    env: {
      ...env,
      TOOL_MEMORY_HOME: join(tmp, "home"),
      TOOL_MEMORY_REGISTRY_ENABLED: "0",
    },
  });
  const client = new Client({ name: "bundle-verify", version: "1.0.0" });
  await client.connect(transport);

  const instructions = client.getInstructions() ?? "";
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  await client.close();

  const missing = MUST_HAVE.filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`server started but is missing tools: ${missing.join(", ")}`);
  if (!instructions.trim()) throw new Error("server exposed no MCP instructions (the agent loop)");

  console.log(`\n\x1b[32m✓ bundle is live — ${names.length} tools, ${instructions.length} chars of instructions\x1b[0m`);
  console.log(`  ${names.join(", ")}`);
} catch (e) {
  failed = true;
  console.error(`\n\x1b[31m✗ ${e instanceof Error ? e.message : e}\x1b[0m`);
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

process.exit(failed ? 1 : 0);
