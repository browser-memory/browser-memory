import {
  SETTINGS,
  effectiveConfig,
  setSetting,
  unsetSetting,
  resetConfig,
  configPath,
} from "./settings.js";

/**
 * CLI de configuración: `browser-memory config ...`. Se despacha ANTES de levantar el MCP
 * server (index.ts) cuando hay argumentos posicionales. Escribe ~/.tool-memory/config.json
 * vía settings.ts; los cambios aplican la próxima vez que arranca el server.
 */

function out(s: string): void {
  process.stdout.write(s + "\n");
}
function err(s: string): void {
  process.stderr.write(s + "\n");
}

/** Claves que el CLI expone para configurar. El resto vive solo en env var / config.json. */
const CLI_KEYS = SETTINGS.filter((s) => s.cli);

/** Lanza si la clave no está expuesta por el CLI (o no existe). */
function requireCliKey(key: string): void {
  if (!CLI_KEYS.some((s) => s.key === key))
    throw new Error(
      `"${key}" no se configura desde el CLI. Configurables: ${CLI_KEYS.map((s) => s.key).join(", ")}`,
    );
}

function printHelp(): void {
  out(`browser-memory — memoria reutilizable de acciones web (MCP server)

Sin argumentos arranca el MCP server (stdio). Subcomandos:

  config show                 muestra la config y de dónde sale cada valor
  config server <on|off>      prende/apaga el registry remoto (off = 100% local)
  config set-url <url>        cambia la URL del registry remoto
  config get <clave>          imprime el valor efectivo de una clave
  config set <clave> <valor>  persiste una clave en ${configPath}
  config unset <clave>        borra una clave (vuelve al default)
  config reset                vacía toda la config persistida
  config path                 imprime la ruta del archivo de config

Precedencia: env var  >  config.json  >  default.

Claves configurables desde el CLI:`);
  for (const s of CLI_KEYS) {
    out(`  ${s.key.padEnd(18)} ${s.describe}`);
    out(`  ${" ".repeat(18)}   env ${s.env} · default: ${s.defaultDesc}`);
  }
}

function printShow(): void {
  out(`config (archivo: ${configPath})\n`);
  const rows = effectiveConfig().filter((r) => CLI_KEYS.some((s) => s.key === r.key));
  const w = Math.max(...rows.map((r) => r.key.length));
  for (const r of rows) {
    out(`  ${r.key.padEnd(w)}  ${r.value}   [${r.source}]`);
  }
  out("\nPrecedencia: env > config.json > default. Cambios aplican al reiniciar el server.");
}

/** Normaliza el valor de `config server`/`registry-enabled` a "on"/"off". */
function asOnOff(v: string): string {
  const t = v.toLowerCase();
  if (["on", "true", "1", "yes"].includes(t)) return "on";
  if (["off", "false", "0", "no"].includes(t)) return "off";
  throw new Error(`valor inválido: "${v}" (usá on u off)`);
}

function applied(key: string, value: string): void {
  out(`✓ ${key} = ${value}  (guardado en ${configPath})`);
  out("  Reiniciá el MCP server para que tome efecto.");
}

/** Maneja el CLI. Setea process.exitCode=1 ante error de uso. Nunca arranca el server. */
export function runCli(argv: string[]): void {
  const [cmd, ...rest] = argv;

  if (cmd === "help" || cmd === "--help" || cmd === "-h") {
    printHelp();
    return;
  }

  if (cmd !== "config") {
    err(`comando desconocido: "${cmd}"\n`);
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
        if (!key) throw new Error("falta la clave: `config get <clave>`");
        requireCliKey(key);
        const entry = effectiveConfig().find((e) => e.key === key)!;
        out(entry.value);
        return;
      }

      case "set": {
        const [key, ...valueParts] = args;
        if (!key || valueParts.length === 0)
          throw new Error("uso: `config set <clave> <valor>`");
        requireCliKey(key);
        const value = valueParts.join(" ");
        setSetting(key, value);
        applied(key, value);
        if (key === "home")
          out(
            "  Nota: reubica el dir de datos para próximos runs; tu memoria actual NO se mueve sola (copiá el contenido si querés conservarla). El config.json no se mueve.",
          );
        return;
      }

      case "unset": {
        const key = args[0];
        if (!key) throw new Error("uso: `config unset <clave>`");
        requireCliKey(key);
        unsetSetting(key);
        out(`✓ ${key} borrado (vuelve al default)`);
        return;
      }

      case "reset":
        resetConfig();
        out(`✓ config vaciada (${configPath})`);
        return;

      case "set-url": {
        const url = args[0];
        if (!url) throw new Error("uso: `config set-url <url>`");
        setSetting("registry-url", url);
        applied("registry-url", url);
        return;
      }

      case "server": {
        const v = args[0];
        if (!v) throw new Error("uso: `config server <on|off>`");
        const onoff = asOnOff(v);
        setSetting("registry-enabled", onoff);
        applied("registry-enabled", onoff);
        if (onoff === "off")
          out("  Modo local: no se consultan tools remotas ni se manda telemetría.");
        return;
      }

      default:
        throw new Error(`subcomando desconocido: "config ${sub}"`);
    }
  } catch (e) {
    err(`error: ${(e as Error).message}`);
    process.exitCode = 1;
  }
}
