import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  codexConfigPath,
  cursorConfigPath,
  vscodeConfigPath,
  tomlAdd,
  tomlRemove,
  jsonAddServer,
  jsonRemoveServer,
  commandExists,
  claudeSaysAbsent,
  detectedHosts,
  installHost,
  uninstallHost,
} from "../src/install.ts";

function tmp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

// --- path resolvers -------------------------------------------------------

test("codexConfigPath honors CODEX_HOME", () => {
  const prev = process.env.CODEX_HOME;
  const home = tmp("codex-home-");
  process.env.CODEX_HOME = home;
  try {
    assert.equal(codexConfigPath(), join(home, "config.toml"));
  } finally {
    if (prev === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = prev;
  }
});

test("cursor/vscode paths sit under the given home", () => {
  const home = "/fake/home";
  assert.equal(cursorConfigPath(home), join(home, ".cursor", "mcp.json"));
  assert.ok(vscodeConfigPath(home).endsWith(join("Code", "User", "mcp.json")));
  assert.ok(vscodeConfigPath(home).startsWith(home));
});

// --- TOML (codex) transforms ----------------------------------------------

test("tomlAdd appends once and is idempotent", () => {
  const added = tomlAdd("");
  assert.match(added!, /\[mcp_servers\.browser-memory\]/);
  assert.match(added!, /args = \["-y", "browser-memory"\]/);
  assert.equal(tomlAdd(added!), null); // already present
});

test("tomlAdd preserves existing tables and adds a separating newline", () => {
  const next = tomlAdd('[mcp_servers.other]\ncommand = "foo"'); // no trailing newline
  assert.match(next!, /\[mcp_servers\.other\]/);
  assert.match(next!, /\[mcp_servers\.browser-memory\]/);
});

test("tomlRemove drops the table and its sub-tables, keeps the rest", () => {
  const src =
    '[a]\nx = 1\n\n[mcp_servers.browser-memory]\ncommand = "npx"\nargs = ["-y","browser-memory"]\n\n[mcp_servers.browser-memory.env]\nFOO = "bar"\n\n[b]\ny = 2\n';
  const out = tomlRemove(src)!;
  assert.doesNotMatch(out, /browser-memory/);
  assert.match(out, /\[a\]/);
  assert.match(out, /\[b\]/);
  assert.equal(tomlRemove(out), null); // nothing left to remove
});

// --- JSON (cursor / vscode) transforms ------------------------------------

test("jsonAddServer writes mcpServers for cursor, idempotently", () => {
  const file = join(tmp("cursor-"), "mcp.json");
  assert.equal(jsonAddServer(file, "mcpServers", { command: "npx", args: ["-y", "browser-memory"] }), "added");
  assert.equal(jsonAddServer(file, "mcpServers", { command: "npx", args: ["-y", "browser-memory"] }), "already");
  const obj = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(obj.mcpServers["browser-memory"], { command: "npx", args: ["-y", "browser-memory"] });
});

test("jsonAddServer preserves other servers and other top-level keys", () => {
  const file = join(tmp("cursor2-"), "mcp.json");
  writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" } }, somethingElse: 1 }));
  jsonAddServer(file, "mcpServers", { command: "npx", args: ["-y", "browser-memory"] });
  const obj = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(obj.mcpServers.other);
  assert.ok(obj.mcpServers["browser-memory"]);
  assert.equal(obj.somethingElse, 1);
});

test("jsonRemoveServer deletes only our key", () => {
  const file = join(tmp("cursor3-"), "mcp.json");
  writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: "x" }, "browser-memory": { command: "npx" } } }));
  assert.equal(jsonRemoveServer(file, "mcpServers"), "removed");
  const obj = JSON.parse(readFileSync(file, "utf8"));
  assert.ok(obj.mcpServers.other);
  assert.ok(!("browser-memory" in obj.mcpServers));
  assert.equal(jsonRemoveServer(file, "mcpServers"), "absent"); // already gone
});

// --- per-host install via fileOverride (covers key/entry wiring) ----------

test("installHost(vscode) uses the servers key with type stdio", () => {
  const file = join(tmp("vscode-"), "mcp.json");
  const r = installHost("vscode", file);
  assert.equal(r.status, "added");
  const obj = JSON.parse(readFileSync(file, "utf8"));
  assert.deepEqual(obj.servers["browser-memory"], {
    type: "stdio",
    command: "npx",
    args: ["-y", "browser-memory"],
  });
  assert.equal(uninstallHost("vscode", file).status, "removed");
});

test("installHost(codex) round-trips add → already → removed → absent", () => {
  const file = join(tmp("codex-rt-"), "config.toml");
  assert.equal(installHost("codex", file).status, "added");
  assert.equal(installHost("codex", file).status, "already");
  assert.match(readFileSync(file, "utf8"), /\[mcp_servers\.browser-memory\]/);
  assert.equal(uninstallHost("codex", file).status, "removed");
  assert.doesNotMatch(readFileSync(file, "utf8"), /browser-memory/);
  assert.equal(uninstallHost("codex", file).status, "absent");
});

// --- detection ------------------------------------------------------------

test("commandExists finds an executable on a controlled PATH", () => {
  const prev = process.env.PATH;
  const dir = tmp("bin-");
  const exe = join(dir, "fakecmd");
  writeFileSync(exe, "#!/bin/sh\n");
  chmodSync(exe, 0o755);
  process.env.PATH = dir;
  try {
    assert.equal(commandExists("fakecmd"), true);
    assert.equal(commandExists("definitely-not-here"), false);
  } finally {
    if (prev === undefined) delete process.env.PATH;
    else process.env.PATH = prev;
  }
});

test("claudeSaysAbsent matches Claude's real 'nothing to remove' wordings", () => {
  // The exact message that surfaced the bug (case-insensitive — caller lowercases first).
  assert.ok(claudeSaysAbsent("no user-scoped mcp server found with name: browser-memory"));
  assert.ok(claudeSaysAbsent("no mcp server with name browser-memory"));
  assert.ok(claudeSaysAbsent("server browser-memory not found"));
  assert.ok(claudeSaysAbsent("no such server"));
  // A genuine failure must NOT be swallowed as "absent".
  assert.ok(!claudeSaysAbsent("permission denied writing ~/.claude.json"));
});

test("detectedHosts lists only hosts whose config dir exists", () => {
  const home = tmp("home-");
  mkdirSync(join(home, ".codex"), { recursive: true });
  mkdirSync(join(home, ".cursor"), { recursive: true });
  // no VS Code dir on purpose
  const found = detectedHosts({ home, hasClaude: false });
  assert.deepEqual(found.sort(), ["codex", "cursor"]);
  assert.ok(detectedHosts({ home, hasClaude: true }).includes("claude"));
});
