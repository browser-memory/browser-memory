import { homedir, platform } from "node:os";
import { join, dirname, delimiter } from "node:path";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";

/**
 * `browser-memory install [host]` / `uninstall [host]` — registers (or removes) this MCP
 * server in a host's config so the user doesn't hand-edit JSON/TOML or remember a
 * host-specific CLI. With no host it autodetects every supported host present on the
 * machine. Dispatched by runCli (cli.ts) before the MCP server starts.
 *
 * Hosts diverge in format, so each is handled on its own terms — but the *invocation* is
 * always the same `npx -y browser-memory@latest`. The explicit `@latest` tag matters: npx
 * re-resolves a tag spec against the registry at session start, while a bare name can be
 * served forever from a stale npx cache (pre-8.12 npm) or shadowed by an old global
 * install — both burned us in production. `update` rewrites entries installed before this.
 *   - codex  → ~/.codex/config.toml          TOML, [mcp_servers.browser-memory]
 *   - cursor → ~/.cursor/mcp.json            JSON, "mcpServers"
 *   - vscode → <VS Code user dir>/mcp.json   JSON, "servers" (+ "type": "stdio")  [Copilot]
 *   - claude → delegated to the `claude` CLI (it owns its big ~/.claude.json safely)
 */

export type Host = "codex" | "cursor" | "vscode" | "claude";
export const HOSTS: Host[] = ["codex", "cursor", "vscode", "claude"];

export interface HostResult {
  host: Host;
  /**
   * install: added|already|unavailable|error · uninstall: removed|absent|unavailable|error
   * · update: updated|added|unavailable|error
   */
  status: "added" | "already" | "updated" | "removed" | "absent" | "unavailable" | "error";
  /** Config file touched (file-based hosts). */
  path?: string;
  /** Human-readable detail (errors, or the mechanism used for delegated hosts). */
  message?: string;
}

/** The name we register under, and the (identical everywhere) command + args. */
const KEY = "browser-memory";
const COMMAND = "npx";
const ARGS = ["-y", "browser-memory@latest"];

// ---------------------------------------------------------------------------
// Config-file locations
// ---------------------------------------------------------------------------

/** Codex: `$CODEX_HOME/config.toml`, else `~/.codex/config.toml`. App and CLI share it. */
export function codexConfigPath(home?: string): string {
  const base =
    home !== undefined
      ? join(home, ".codex")
      : process.env.CODEX_HOME?.trim() || join(homedir(), ".codex");
  return join(base, "config.toml");
}

/** Cursor's global MCP config. */
export function cursorConfigPath(home: string = homedir()): string {
  return join(home, ".cursor", "mcp.json");
}

/** VS Code (Copilot) user-level MCP config, per platform. */
export function vscodeConfigPath(home: string = homedir()): string {
  switch (platform()) {
    case "darwin":
      return join(home, "Library", "Application Support", "Code", "User", "mcp.json");
    case "win32":
      return join(
        process.env.APPDATA || join(home, "AppData", "Roaming"),
        "Code",
        "User",
        "mcp.json",
      );
    default:
      return join(
        process.env.XDG_CONFIG_HOME || join(home, ".config"),
        "Code",
        "User",
        "mcp.json",
      );
  }
}

// ---------------------------------------------------------------------------
// TOML (Codex) — append / remove a table by header, no full parser needed
// ---------------------------------------------------------------------------

const CODEX_BLOCK = `\n[mcp_servers.browser-memory]\ncommand = "npx"\nargs = ["-y", "browser-memory@latest"]\n`;
/** Matches the table header and any sub-table (e.g. `[mcp_servers.browser-memory.env]`). */
const CODEX_HEADER_RE = /^\s*\[mcp_servers\.browser-memory(\.[^\]]+)?\]/m;

/** Append the codex block. Returns the new content, or null if it's already present. */
export function tomlAdd(content: string): string | null {
  if (CODEX_HEADER_RE.test(content)) return null;
  const sep = content.length > 0 && !content.endsWith("\n") ? "\n" : "";
  return content + sep + CODEX_BLOCK;
}

/** Drop the codex table (and any sub-tables). Returns new content, or null if absent. */
export function tomlRemove(content: string): string | null {
  if (!CODEX_HEADER_RE.test(content)) return null;
  const kept: string[] = [];
  let skipping = false;
  for (const line of content.split("\n")) {
    if (/^\s*\[/.test(line)) {
      skipping = /^\s*\[mcp_servers\.browser-memory(\.[^\]]+)?\]/.test(line);
    }
    if (!skipping) kept.push(line);
  }
  let result = kept.join("\n").replace(/\n{3,}/g, "\n\n").replace(/^\n+/, "");
  if (result.length > 0 && !result.endsWith("\n")) result += "\n";
  return result;
}

// ---------------------------------------------------------------------------
// JSON (Cursor / VS Code) — merge / delete a single key, preserving the rest
// ---------------------------------------------------------------------------

type JsonKey = "mcpServers" | "servers";

function readJson(file: string): Record<string, any> {
  if (!existsSync(file)) return {};
  const raw = readFileSync(file, "utf8").trim();
  return raw ? JSON.parse(raw) : {};
}

function writeJson(file: string, obj: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(obj, null, 2) + "\n");
}

/** Add our server under `mapKey`. Returns "added", or "already" if present (untouched). */
export function jsonAddServer(
  file: string,
  mapKey: JsonKey,
  entry: object,
): "added" | "already" {
  const obj = readJson(file);
  const map =
    obj[mapKey] && typeof obj[mapKey] === "object" ? obj[mapKey] : (obj[mapKey] = {});
  if (map[KEY]) return "already";
  map[KEY] = entry;
  writeJson(file, obj);
  return "added";
}

/** Write our server unconditionally. Returns "updated" if an entry was replaced, else "added". */
export function jsonUpdateServer(
  file: string,
  mapKey: JsonKey,
  entry: object,
): "added" | "updated" {
  const obj = readJson(file);
  const map =
    obj[mapKey] && typeof obj[mapKey] === "object" ? obj[mapKey] : (obj[mapKey] = {});
  const status = map[KEY] ? "updated" : "added";
  map[KEY] = entry;
  writeJson(file, obj);
  return status;
}

/** Delete our server. Returns "removed", or "absent" if it wasn't there. */
export function jsonRemoveServer(file: string, mapKey: JsonKey): "removed" | "absent" {
  if (!existsSync(file)) return "absent";
  const obj = readJson(file);
  const map = obj[mapKey];
  if (!map || typeof map !== "object" || !(KEY in map)) return "absent";
  delete map[KEY];
  writeJson(file, obj);
  return "removed";
}

// ---------------------------------------------------------------------------
// Claude Code — delegate to its own CLI (never hand-edit ~/.claude.json)
// ---------------------------------------------------------------------------

/**
 * True if Claude's CLI output means "the server wasn't there" (a benign no-op, not an error).
 * Claude phrases this several ways across versions — most notably "No user-scoped MCP server
 * found with name: …", which contains neither "not found" nor "no mcp" as a contiguous run — so
 * we match every known wording rather than a single substring.
 */
export function claudeSaysAbsent(text: string): boolean {
  return [
    "not found",
    "no mcp",
    "does not",
    "no user-scoped",
    "no such",
  ].some((p) => text.includes(p));
}

/** True if `cmd` is an executable on PATH. Pure lookup — does not run anything. */
export function commandExists(cmd: string): boolean {
  const dirs = (process.env.PATH || "").split(delimiter).filter(Boolean);
  const exts =
    platform() === "win32"
      ? (process.env.PATHEXT || ".EXE;.CMD;.BAT").split(";")
      : [""];
  return dirs.some((dir) => exts.some((ext) => existsSync(join(dir, cmd + ext))));
}

function claudeInstall(): HostResult {
  if (!commandExists("claude"))
    return {
      host: "claude",
      status: "unavailable",
      message:
        "Claude Code CLI not on PATH — run: claude mcp add --scope user browser-memory -- npx -y browser-memory@latest",
    };
  const r = spawnSync("claude", ["mcp", "add", "--scope", "user", KEY, "--", COMMAND, ...ARGS], {
    encoding: "utf8",
  });
  if (r.status === 0)
    return { host: "claude", status: "added", message: "claude mcp add (user scope)" };
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.toLowerCase();
  if (text.includes("already")) return { host: "claude", status: "already" };
  return {
    host: "claude",
    status: "error",
    message: (r.stderr || r.stdout || "claude mcp add failed").trim(),
  };
}

function claudeUpdate(): HostResult {
  if (!commandExists("claude"))
    return {
      host: "claude",
      status: "unavailable",
      message:
        "Claude Code CLI not on PATH — run: claude mcp remove --scope user browser-memory && claude mcp add --scope user browser-memory -- npx -y browser-memory@latest",
    };
  // claude mcp add refuses to overwrite, so update = remove (tolerating absence) + add.
  const rm = spawnSync("claude", ["mcp", "remove", "--scope", "user", KEY], { encoding: "utf8" });
  const removed = rm.status === 0;
  if (!removed && !claudeSaysAbsent(`${rm.stdout ?? ""}${rm.stderr ?? ""}`.toLowerCase()))
    return {
      host: "claude",
      status: "error",
      message: (rm.stderr || rm.stdout || "claude mcp remove failed").trim(),
    };
  const add = claudeInstall();
  if (add.status === "added")
    return { host: "claude", status: removed ? "updated" : "added", message: add.message };
  return add;
}

function claudeUninstall(): HostResult {
  if (!commandExists("claude"))
    return {
      host: "claude",
      status: "unavailable",
      message: "Claude Code CLI not on PATH — run: claude mcp remove --scope user browser-memory",
    };
  const r = spawnSync("claude", ["mcp", "remove", "--scope", "user", KEY], { encoding: "utf8" });
  if (r.status === 0) return { host: "claude", status: "removed" };
  const text = `${r.stdout ?? ""}${r.stderr ?? ""}`.toLowerCase();
  if (claudeSaysAbsent(text)) return { host: "claude", status: "absent" };
  return {
    host: "claude",
    status: "error",
    message: (r.stderr || r.stdout || "claude mcp remove failed").trim(),
  };
}

// ---------------------------------------------------------------------------
// Per-host install / uninstall + autodetect
// ---------------------------------------------------------------------------

/** Install into one host. `fileOverride` (file-based hosts only) is for tests. */
export function installHost(host: Host, fileOverride?: string): HostResult {
  try {
    switch (host) {
      case "codex": {
        const file = fileOverride ?? codexConfigPath();
        const content = existsSync(file) ? readFileSync(file, "utf8") : "";
        const next = tomlAdd(content);
        if (next === null) return { host, status: "already", path: file };
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, next);
        return { host, status: "added", path: file };
      }
      case "cursor": {
        const file = fileOverride ?? cursorConfigPath();
        return { host, status: jsonAddServer(file, "mcpServers", { command: COMMAND, args: ARGS }), path: file };
      }
      case "vscode": {
        const file = fileOverride ?? vscodeConfigPath();
        return {
          host,
          status: jsonAddServer(file, "servers", { type: "stdio", command: COMMAND, args: ARGS }),
          path: file,
        };
      }
      case "claude":
        return claudeInstall();
    }
  } catch (e) {
    return { host, status: "error", message: (e as Error).message };
  }
}

/**
 * Update one host: rewrite our entry to the current command + args even if one is already
 * there. This is the repair path for configs written by older versions (whose unpinned
 * `npx -y browser-memory` can stay frozen on an old release): `install` is deliberately
 * idempotent and never touches an existing entry, so it cannot fix them.
 */
export function updateHost(host: Host, fileOverride?: string): HostResult {
  try {
    switch (host) {
      case "codex": {
        const file = fileOverride ?? codexConfigPath();
        const content = existsSync(file) ? readFileSync(file, "utf8") : "";
        const cleared = tomlRemove(content);
        const next = tomlAdd(cleared ?? content)!;
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, next);
        return { host, status: cleared === null ? "added" : "updated", path: file };
      }
      case "cursor": {
        const file = fileOverride ?? cursorConfigPath();
        return { host, status: jsonUpdateServer(file, "mcpServers", { command: COMMAND, args: ARGS }), path: file };
      }
      case "vscode": {
        const file = fileOverride ?? vscodeConfigPath();
        return {
          host,
          status: jsonUpdateServer(file, "servers", { type: "stdio", command: COMMAND, args: ARGS }),
          path: file,
        };
      }
      case "claude":
        return claudeUpdate();
    }
  } catch (e) {
    return { host, status: "error", message: (e as Error).message };
  }
}

/** Uninstall from one host. `fileOverride` (file-based hosts only) is for tests. */
export function uninstallHost(host: Host, fileOverride?: string): HostResult {
  try {
    switch (host) {
      case "codex": {
        const file = fileOverride ?? codexConfigPath();
        if (!existsSync(file)) return { host, status: "absent", path: file };
        const next = tomlRemove(readFileSync(file, "utf8"));
        if (next === null) return { host, status: "absent", path: file };
        writeFileSync(file, next);
        return { host, status: "removed", path: file };
      }
      case "cursor": {
        const file = fileOverride ?? cursorConfigPath();
        return { host, status: jsonRemoveServer(file, "mcpServers"), path: file };
      }
      case "vscode": {
        const file = fileOverride ?? vscodeConfigPath();
        return { host, status: jsonRemoveServer(file, "servers"), path: file };
      }
      case "claude":
        return claudeUninstall();
    }
  } catch (e) {
    return { host, status: "error", message: (e as Error).message };
  }
}

/**
 * Hosts present on this machine: a host counts as present if its config directory exists
 * (codex/cursor/vscode) or its CLI is on PATH (claude). `opts` is for tests.
 */
export function detectedHosts(opts: { home?: string; hasClaude?: boolean } = {}): Host[] {
  const found: Host[] = [];
  if (existsSync(dirname(codexConfigPath(opts.home)))) found.push("codex");
  if (existsSync(dirname(cursorConfigPath(opts.home)))) found.push("cursor");
  if (existsSync(dirname(vscodeConfigPath(opts.home)))) found.push("vscode");
  if (opts.hasClaude ?? commandExists("claude")) found.push("claude");
  return found;
}
