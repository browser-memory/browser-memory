#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { join } from "node:path";

import { launchSharedChrome, stopSharedChrome } from "./browser/chrome.js";
import { disconnectReplay, captureScreenshotsInto } from "./browser/connect.js";
import { startNetLog, getNetLog, mergeNetwork, clearNetLog } from "./browser/netlog.js";
import { discover } from "./memory/discover.js";
import { loadItem, saveItem, removeItem } from "./memory/store.js";
import { isComposite } from "./schema/tool.js";
import { run } from "./runner/execute.js";
import { runComposite } from "./runner/compose.js";
import { learn } from "./learn/signal.js";

/**
 * Entry MCP (stdio). Registra discover / run / save (spec §5). Es dueño del ciclo
 * de vida del Chrome compartido: lo levanta al iniciar (spec §4).
 */

/**
 * Protocolo que el server le declara al host vía el handshake MCP (`instructions`).
 * Se inyecta en el contexto del modelo al conectar — instala el loop discover → run
 * → request SIN tocar el CLAUDE.md del usuario. Viaja dentro del paquete: funciona para
 * todo el mundo, cero config. (Es un hint del protocolo; Claude Code lo respeta.)
 */
const INSTRUCTIONS = `
Este server te da una MEMORIA de acciones web reutilizables, compartiendo un único
Chrome con el server "playwright" (vía CDP: lo que hace uno lo ve el otro al instante).

SEGUÍ SIEMPRE este loop cuando una tarea implique operar un sitio web:

1. ANTES de explorar con el browser → llamá a \`discover(sites)\` pasando el/los
   sitio(s) de la tarea (ej. ["infobae"] o ["airbnb","booking"]). Devuelve TODAS las
   tools de esos sitios (incluida login/auth): elegí la que corresponde por su intent
   y EJECUTALA con \`run\` en vez de explorar. No abras el navegador a mano si ya hay
   un tool que sirve.

2. Si NO hay tool (discover vacío) → resolvé la tarea de verdad con el server
   "playwright" (snapshot, navigate, click...). Cuando termine BIEN, capturá el
   aprendizaje con \`request(goal, narration, network)\`:
   - narration: los pasos canónicos que funcionaron (intent + action + selector/url/
     value), separando la señal del ruido de exploración (sin backtracks).
   - network: la salida de browser_network_requests (sirve para detectar un endpoint
     HTTP directo, más robusto que la UI).
   request devuelve { status: "pending_distill", suggested_prompt, trace_path }. Acto
   seguido SPAWNEÁ UN SUBAGENTE EN BACKGROUND con ese suggested_prompt: destila la
   trace y guarda el/los tool(s) con \`save\`. El distill no toca el navegador.

3. \`run(name, params)\` devuelve DATOS, no instrucciones. El cálculo o la decisión
   sobre esos datos es tuya. Errores tipados:
   - re-auth  → sesión vencida: re-logueate (login manual). NO re-aprendas.
   - no-aplica → no corresponde (sin permiso / no existe): reportá y pará.
   - tool-roto → selector/API cambió: re-aprendé desde una trace nueva.

Reglas: parametrizá lo que varíe (q, hours), no lo hardcodees. Secretos nunca en
tools/traces. write-irreversible (mandar, pagar) NO tiene gate de confirmación todavía:
cada run ejecuta de verdad — confirmá con el usuario antes de reproducir una.
`.trim();

const server = new McpServer(
  { name: "tool-memory", version: "0.1.0" },
  { instructions: INSTRUCTIONS },
);

server.tool(
  "discover",
  "PRIMER PASO de toda tarea web: llamá a discover ANTES de abrir el browser. El " +
    "matcheo es POR SITIO: pasá el/los sitio(s) de la tarea (marca o dominio, ej. " +
    "['infobae'], ['airbnb','booking']) y devuelve TODAS las tools de esos sitios " +
    "— incluidas login/auth — con los composites primero. Elegí la que corresponde por " +
    "su intent y, si hace falta, corré antes su login. Si ninguno de los sitios está en " +
    "memoria vuelve VACÍO: ahí no hay nada aprendido, explorá con playwright y después " +
    "capturá con request() para aprender tools nuevas.",
  {
    sites: z
      .array(z.string())
      .describe("sitio(s) de la tarea: marca o dominio, ej. ['infobae'] o ['airbnb','booking']"),
  },
  async ({ sites }) => {
    const candidates = discover(sites).map((c) => {
      // Completamos los params reales leyendo el item (requires.params o params).
      try {
        const item = loadItem(c.name);
        const params = isComposite(item)
          ? Object.keys(item.params)
          : Object.keys(item.requires.params);
        return { ...c, params };
      } catch {
        return c;
      }
    });
    // Todo discover marca el INICIO de una tarea nueva: levantamos Chrome (best-effort) y
    // reseteamos+arrancamos el grabador de red SIEMPRE, haya tools o no. Así, aunque el
    // agente corra una tool conocida y DESPUÉS explore una acción nueva en el mismo sitio,
    // su red queda grabada (no dependemos de re-entrar por el branch "sin candidatos").
    // Sobrevive redirects, a diferencia del snapshot del agente. Idempotente: si Chrome ya
    // está vivo es un fast-path; si no, adelanta el launch que igual haría run().
    try {
      await launchSharedChrome();
      await startNetLog();
    } catch (e) {
      process.stderr.write(
        `[tool-memory] no pude prelanzar Chrome / iniciar el grabador: ${(e as Error).message}\n`,
      );
    }
    return { content: [{ type: "text", text: JSON.stringify(candidates, null, 2) }] };
  },
);

server.tool(
  "run",
  "Ejecuta un tool de la memoria de forma determinista (sin modelo en el medio) y " +
    "devuelve DATOS estructurados. Verifica precondiciones de entorno y la " +
    "success_assertion. Errores tipados: re-auth (re-loguearse), no-aplica (no " +
    "corresponde), tool-roto (regenerar con request).",
  {
    name: z.string().describe("nombre del tool o composite"),
    params: z.record(z.unknown()).optional().describe("params/handles del tool"),
  },
  async ({ name, params }) => {
    // Despacha al runner correcto según el tipo del item en memoria.
    let composite = false;
    try {
      composite = isComposite(loadItem(name));
    } catch {
      // no existe; run() lo reporta como no-aplica.
    }
    const res = composite
      ? await runComposite(name, params ?? {})
      : await run(name, params ?? {});
    return {
      content: [{ type: "text", text: JSON.stringify(res, null, 2) }],
      isError: !res.ok,
    };
  },
);

server.tool(
  "save",
  "Guarda (o reemplaza) un tool primitivo o un composite en la memoria. Antes de " +
    "persistir valida esquema + lint estático del cableado de params. Para tools de " +
    "LECTURA, pasá `verify_with` con los params concretos de la trace: el server hace " +
    "un smoke-run real y RECHAZA el tool si no devuelve resultado (caza el caso de un " +
    "param que no llega y un extractor que igual devuelve algo). Lo usa el distiller.",
  {
    tool: z.record(z.unknown()).describe("el objeto Tool (§10.1) o Composite (§10.2)"),
    verify_with: z
      .record(z.unknown())
      .optional()
      .describe(
        "params concretos (de la trace) para el smoke-run de verificación. Solo aplica " +
          "a primitivas de lectura; en writes se ignora (no se puede probar sin efecto).",
      ),
  },
  async ({ tool, verify_with }) => {
    let saved;
    try {
      saved = saveItem(tool);
    } catch (e) {
      return {
        content: [{ type: "text", text: `Inválido: ${(e as Error).message}` }],
        isError: true,
      };
    }

    // Smoke-run: SOLO primitivas de lectura (un write ejecutaría el efecto de verdad).
    if (verify_with && !isComposite(saved) && saved.side_effect === "read") {
      const res = await run(saved.name, verify_with);
      if (!res.ok || res.result == null) {
        removeItem(saved.name); // revertimos: un tool que no verifica no queda en memoria.
        const why = res.ok ? "el extractor devolvió null/sin dato" : res.error?.message;
        return {
          content: [
            {
              type: "text",
              text:
                `Rechazado por smoke-run: '${saved.name}' no produjo resultado con ` +
                `${JSON.stringify(verify_with)} — ${why}. El tool NO se guardó; revisá ` +
                `el cableado de params (URL/extractor) y volvé a guardar.`,
            },
          ],
          isError: true,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Guardado y verificado: ${saved.name} (${saved.type} v${saved.version}) — smoke-run OK.`,
          },
        ],
      };
    }

    return {
      content: [
        { type: "text", text: `Guardado: ${saved.name} (${saved.type} v${saved.version})` },
      ],
    };
  },
);

server.tool(
  "request",
  "ÚLTIMO PASO cuando hiciste una acción web NUEVA con el browser y salió BIEN: " +
    "llamá a request para no tener que re-descubrirla la próxima. NO bloquea: persiste " +
    "la trace congelada y devuelve `pending_distill` con un `suggested_prompt`. " +
    "CONTRATO OBLIGATORIO: al recibirlo, spawneá un SUBAGENTE EN BACKGROUND con ese " +
    "prompt; el subagente destila la trace y guarda los tools vía `save`. El distill " +
    "no toca el navegador.",
  {
    goal: z.string().describe("el objetivo que se logró, en lenguaje natural"),
    narration: z
      .record(z.unknown())
      .describe(
        "objeto con { steps: [{ intent?, action, url?, selector?, value? }, ...] } — " +
          "los pasos canónicos del camino exitoso. `action` es un label libre " +
          "(navigate, click, type, parse, extract...). NO hace falta repetir goal/site " +
          "adentro: se completan solos. Opcional: reader_fn, api_candidate.",
      ),
    network: z.unknown().optional().describe("salida de browser_network_requests"),
    console: z.unknown().optional().describe("salida de browser_console_messages"),
  },
  async ({ goal, narration, network, console }) => {
    try {
      // La captura continua del server (CDP, completa) manda; el snapshot del agente se
      // mergea encima por sus anotaciones de `role`. Así el distiller ve TODOS los networks.
      const mergedNetwork = mergeNetwork(getNetLog(), network);
      const signal = learn({ goal, narration, network: mergedNetwork, console });
      // Congelamos screenshots del estado final "por las dudas" (best-effort, no bloquea).
      await captureScreenshotsInto(join(signal.trace_path, "screenshots"));
      // Episodio congelado: vaciamos el buffer para que la próxima tarea arranque limpia.
      // (Si learn() hubiera fallado, no llegamos acá y la exploración sigue grabada para reintentar.)
      clearNetLog();
      return { content: [{ type: "text", text: JSON.stringify(signal, null, 2) }] };
    } catch (e) {
      return {
        content: [{ type: "text", text: `request inválido: ${(e as Error).message}` }],
        isError: true,
      };
    }
  },
);

async function main(): Promise<void> {
  // tool-memory es dueño del Chrome pero NO lo levanta al arrancar: lo hace lazy,
  // recién cuando hace falta de verdad (un run, o un discover sin resultado que va a
  // derivar en exploración). Así conectar el MCP / mandar un "hola" no abre nada.
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

async function shutdown(): Promise<void> {
  await disconnectReplay();
  stopSharedChrome();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((e) => {
  process.stderr.write(`[tool-memory] fatal: ${e}\n`);
  process.exit(1);
});
