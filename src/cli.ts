import {
  SETTINGS,
  effectiveConfig,
  setSetting,
  unsetSetting,
  resetConfig,
  configPath,
} from "./settings.js";
import {
  HOSTS,
  type Host,
  type HostResult,
  installHost,
  uninstallHost,
  detectedHosts,
} from "./install.js";
import { rmSync, existsSync } from "node:fs";
import { paths } from "./config.js";

/**
 * Configuration CLI: `browser-memory config ...`. Dispatched BEFORE starting the MCP
 * server (index.ts) when there are positional arguments. Writes ~/.tool-memory/config.json
 * via settings.ts; changes apply the next time the server starts.
 */

function out(s: string): void {
  process.stdout.write(s + "\n");
}
function err(s: string): void {
  process.stderr.write(s + "\n");
}

/** Keys the CLI exposes for configuration. The rest live only in env var / config.json. */
const CLI_KEYS = SETTINGS.filter((s) => s.cli);

/** Throws if the key is not exposed by the CLI (or does not exist). */
function requireCliKey(key: string): void {
  if (!CLI_KEYS.some((s) => s.key === key))
    throw new Error(
      `"${key}" is not configurable from the CLI. Configurable: ${CLI_KEYS.map((s) => s.key).join(", ")}`,
    );
}

function printHelp(): void {
  out(`browser-memory — reusable memory of web actions (MCP server)

With no arguments it starts the MCP server (stdio). Subcommands:

  install [host]              add this server to a host's MCP config
                                host: codex | cursor | vscode | claude · omit = autodetect
  uninstall [host]            remove it again (same hosts; omit = autodetect)
  reset-profile               delete the dedicated Chrome profile (a copy) so the
                                next launch re-seeds fresh from your real Chrome
  config show                 show the config and where each value comes from
  config server <on|off>      turn the remote registry on/off (default on; off = 100% local)
  config set-url <url>        change the remote registry URL
  config get <key>            print the effective value of a key
  config set <key> <value>    persist a key to ${configPath}
  config unset <key>          delete a key (reverts to default)
  config reset                clear all persisted config
  config path                 print the path of the config file

Precedence: env var  >  config.json  >  default.

Keys configurable from the CLI:`);
  for (const s of CLI_KEYS) {
    out(`  ${s.key.padEnd(18)} ${s.describe}`);
    out(`  ${" ".repeat(18)}   env ${s.env} · default: ${s.defaultDesc}`);
  }
}

function printShow(): void {
  out(`config (file: ${configPath})\n`);
  const rows = effectiveConfig().filter((r) => CLI_KEYS.some((s) => s.key === r.key));
  const w = Math.max(...rows.map((r) => r.key.length));
  for (const r of rows) {
    out(`  ${r.key.padEnd(w)}  ${r.value}   [${r.source}]`);
  }
  out("\nPrecedence: env > config.json > default. Changes apply when the server restarts.");
}

/** Normalizes the value of `config server`/`registry-enabled` to "on"/"off". */
function asOnOff(v: string): string {
  const t = v.toLowerCase();
  if (["on", "true", "1", "yes"].includes(t)) return "on";
  if (["off", "false", "0", "no"].includes(t)) return "off";
  throw new Error(`invalid value: "${v}" (use on or off)`);
}

function applied(key: string, value: string): void {
  out(`✓ ${key} = ${value}  (saved to ${configPath})`);
  out("  Restart the MCP server for it to take effect.");
}

/** One human-readable line per host result. */
function fmtResult(r: HostResult): string {
  const at = r.path ? ` (${r.path})` : "";
  switch (r.status) {
    case "added":
      return `  ✓ ${r.host} added${at}`;
    case "already":
      return `  • ${r.host} already configured${at}`;
    case "removed":
      return `  ✓ ${r.host} removed${at}`;
    case "absent":
      return `  • ${r.host} was not configured${at}`;
    case "unavailable":
      return `  ⚠ ${r.host}: ${r.message ?? "host CLI not found"}`;
    case "error":
      return `  ✗ ${r.host}: ${r.message ?? "failed"}`;
  }
}

/** `install [host]` / `uninstall [host]`. Empty host = every detected host. */
function runInstall(action: "install" | "uninstall", host: string): void {
  const run = (h: Host) => (action === "install" ? installHost(h) : uninstallHost(h));
  try {
    let results: HostResult[];
    if (!host) {
      const hosts = detectedHosts();
      if (hosts.length === 0) {
        out("No supported hosts detected (looked for Codex, Cursor, VS Code, Claude Code).");
        out(`Pass one explicitly, e.g. \`${action} codex\`.`);
        return;
      }
      out(`Detected: ${hosts.join(", ")}`);
      results = hosts.map(run);
    } else if ((HOSTS as string[]).includes(host)) {
      results = [run(host as Host)];
    } else {
      throw new Error(
        `unknown host "${host}" — supported: ${HOSTS.join(", ")} (or omit to autodetect)`,
      );
    }
    for (const r of results) out(fmtResult(r));
    if (action === "install" && results.some((r) => r.status === "added"))
      out("  Restart the affected app(s) for the change to take effect.");
    if (results.some((r) => r.status === "error")) process.exitCode = 1;
  } catch (e) {
    err(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}

/**
 * `reset-profile`: removes the dedicated Chrome profile (a COPY the server maintains). The next
 * launch re-seeds it fresh from your real Chrome. Never touches the real browser, your tools, or
 * the index — only `<home>/chrome-profile`. Respects TOOL_MEMORY_HOME via paths.chromeProfile.
 */
function runResetProfile(): void {
  const dir = paths.chromeProfile;
  try {
    if (!existsSync(dir)) {
      out(`• No dedicated profile to remove (${dir})`);
      return;
    }
    rmSync(dir, { recursive: true, force: true });
    out(`✓ Dedicated Chrome profile removed (${dir})`);
    out("  The next discover/run re-seeds it from your real Chrome.");
  } catch (e) {
    err(`error: could not remove ${dir}: ${(e as Error).message}`);
    err("  The dedicated Chrome may still be running and locking the folder.");
    err("  Stop the MCP server (close the app/editor) and try again.");
    process.exitCode = 1;
  }
}

/** Handles the CLI. Sets process.exitCode=1 on usage error. Never starts the server. */
export function runCli(argv: string[]): void {
  const [cmd, ...rest] = argv;

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  if (cmd === "install" || cmd === "uninstall") {
    runInstall(cmd, (rest[0] ?? "").toLowerCase());
    return;
  }

  if (cmd === "reset-profile") {
    runResetProfile();
    return;
  }

  if (cmd !== "config") {
    err(`unknown command: "${cmd}"\n`);
    printHelp();
    process.exitCode = 1;
    return;
  }

  const [sub, ...args] = rest;
  try {
    switch (sub) {
      case undefined:
      case "show":
        printShow();
        return;

      case "path":
        out(configPath);
        return;

      case "get": {
        const key = args[0];
        if (!key) throw new Error("missing key: `config get <key>`");
        requireCliKey(key);
        const entry = effectiveConfig().find((e) => e.key === key)!;
        out(entry.value);
        return;
      }

      case "set": {
        const [key, ...valueParts] = args;
        if (!key || valueParts.length === 0)
          throw new Error("usage: `config set <key> <value>`");
        requireCliKey(key);
        const value = valueParts.join(" ");
        setSetting(key, value);
        applied(key, value);
        if (key === "home")
          out(
            "  Note: relocates the data dir for future runs; your current memory does NOT move on its own (copy the contents if you want to keep it). The config.json does not move.",
          );
        return;
      }

      case "unset": {
        const key = args[0];
        if (!key) throw new Error("usage: `config unset <key>`");
        requireCliKey(key);
        unsetSetting(key);
        out(`✓ ${key} deleted (reverts to default)`);
        return;
      }

      case "reset":
        resetConfig();
        out(`✓ config cleared (${configPath})`);
        return;

      case "set-url": {
        const url = args[0];
        if (!url) throw new Error("usage: `config set-url <url>`");
        setSetting("registry-url", url);
        applied("registry-url", url);
        return;
      }

      case "server": {
        const v = args[0];
        if (!v) throw new Error("usage: `config server <on|off>`");
        const onoff = asOnOff(v);
        setSetting("registry-enabled", onoff);
        applied("registry-enabled", onoff);
        if (onoff === "off")
          out("  Local mode: no remote tools are queried and no telemetry is sent.");
        return;
      }

      default:
        throw new Error(`unknown subcommand: "config ${sub}"`);
    }
  } catch (e) {
    err(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
