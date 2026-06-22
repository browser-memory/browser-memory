import {
  SETTINGS,
  effectiveConfig,
  setSetting,
  unsetSetting,
  resetConfig,
  configPath,
} from "./settings.js";

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

/** Handles the CLI. Sets process.exitCode=1 on usage error. Never starts the server. */
export function runCli(argv: string[]): void {
  const [cmd, ...rest] = argv;

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
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
