#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { join } from "node:path";

import { launchSharedChrome, stopSharedChrome } from "./browser/chrome.js";
import { disconnectReplay, captureScreenshotsInto } from "./browser/connect.js";
import { startNetLog, getNetLog, mergeNetwork, clearNetLog } from "./browser/netlog.js";
import {
  discover,
  sortCompositesFirst,
  listSites,
  mergeSites,
  forgetSite,
  type Candidate,
} from "./memory/discover.js";
import { loadItem, saveItem, removeItem } from "./memory/store.js";
import { isComposite } from "./schema/tool.js";
import { run, type RunResult } from "./runner/execute.js";
import { runComposite, type ComposeResult } from "./runner/compose.js";
import { learn } from "./learn/signal.js";
import { fetchRemoteIndex, fetchRemoteSites } from "./registry/client.js";
import { resolveItem, isRemoteSource } from "./registry/resolve.js";
import { logEvent } from "./registry/log.js";

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
    // 1. Remoto (best-effort): el server es la fuente de verdad (oferta curada). El índice
    //    ya trae los nombres de params, así que no hace falta leer el item.
    const remoteEntries = await fetchRemoteIndex(sites);
    const remoteNames = new Set(remoteEntries.map((e) => e.name));
    const remote: Candidate[] = remoteEntries.map((e) => ({
      name: e.name,
      type: e.type,
      site: e.site,
      intent: e.intent,
      params: e.params ?? [],
      side_effect: e.side_effect,
      source: "remote" as const,
    }));

    // 2. Local: SOLO las que el server no tiene. Dedup por name: GANA el server.
    //    Enriquecemos los params reales leyendo el item (requires.params o params).
    const local: Candidate[] = discover(sites)
      .filter((c) => !remoteNames.has(c.name))
      .map((c) => {
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

    const candidates = sortCompositesFirst([...remote, ...local]);

    // "Se quiso hacer algo y no hay tool (ni local ni remoto)": señal de demanda no cubierta.
    if (candidates.length === 0) {
      logEvent({ event_type: "discover_miss", sites });
    }
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
  "list_sites",
  "Lista TODOS los sitios que tienen al menos una tool en memoria — los del registro " +
    "REMOTO (oferta curada del server) y los LOCALES del usuario, deduplicados por sitio. " +
    "Usala para responder 'qué sitios soportamos de forma nativa'. NO toca el browser ni " +
    "necesita params. Cada sitio trae su `source` (local / remote / both) y el conteo de " +
    "tools de cada lado.",
  {},
  async () => {
    // Remoto best-effort (igual que discover): si el backend está caído, devuelve [].
    const remote = await fetchRemoteSites();
    const local = listSites();
    const sites = mergeSites(local, remote);
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify({ count: sites.length, sites }, null, 2),
        },
      ],
    };
  },
);

server.tool(
  "forget_site",
  "Borra de la memoria LOCAL todas las tools de un sitio (mismo matching por marca/" +
    "dominio que discover: 'wikipedia' → es.wikipedia.org). Usala cuando el usuario pida " +
    "'eliminá X de los sitios disponibles'. Es DIRECTO e IRREVERSIBLE: no hay papelera ni " +
    "undo — confirmá con el usuario antes de llamarla. NO toca el registro remoto (la " +
    "oferta curada del server se cura aparte): si el sitio existe solo en remoto, " +
    "`deleted` vuelve vacío.",
  {
    site: z.string().describe("sitio a olvidar: marca o dominio, ej. 'wikipedia' o 'es.wikipedia.org'"),
  },
  async ({ site }) => {
    const res = forgetSite(site);
    const text = res.deleted.length
      ? `Borradas ${res.deleted.length} tool(s) locales de '${res.site}': ${res.deleted.join(", ")}.`
      : `No había tools locales para '${res.site}' (puede existir solo en el registro remoto, que no se toca desde acá).`;
    return { content: [{ type: "text", text }] };
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
    // Resolución unificada (Opción A) para decidir el dispatch y conocer el origen.
    // La cache hace barata esta resolución y la de adentro de run/runComposite.
    let composite = false;
    let source: "local" | "remote" = "local";
    try {
      const resolved = await resolveItem(name);
      composite = isComposite(resolved.item);
      source = isRemoteSource(resolved.source) ? "remote" : "local";
    } catch {
      // no existe en ningún lado; run()/runComposite() lo reportan como no-aplica.
    }
    const res = composite
      ? await runComposite(name, params ?? {})
      : await run(name, params ?? {});

    // tool_run: UN evento por llamada top-level (un composite = 1 acá; sus pasos los
    // loguea compose.ts como tool_step).
    logEvent({
      event_type: "tool_run",
      tool_name: name,
      item_type: composite ? "composite" : "primitive",
      source: !composite && (res as RunResult).source ? (res as RunResult).source! : source,
      outcome: res.ok ? "ok" : "error",
      fail_mode: composite
        ? (res as ComposeResult).steps.find((s) => !s.ok)?.error?.mode
        : (res as RunResult).error?.mode,
      param_keys: Object.keys(params ?? {}),
    });

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
      // No logueamos saves fallidos: el log solo guarda lo que funcionó bien.
      return {
        content: [{ type: "text", text: `Inválido: ${(e as Error).message}` }],
        isError: true,
      };
    }

    const itemType = isComposite(saved) ? "composite" : "primitive";
    const paramKeys = isComposite(saved)
      ? Object.keys(saved.params)
      : Object.keys(saved.requires.params);

    // Smoke-run: SOLO primitivas de lectura (un write ejecutaría el efecto de verdad).
    if (verify_with && !isComposite(saved) && saved.side_effect === "read") {
      const res = await run(saved.name, verify_with);
      if (!res.ok || res.result == null) {
        removeItem(saved.name); // revertimos: un tool que no verifica no queda en memoria.
        const why = res.ok ? "el extractor devolvió null/sin dato" : res.error?.message;
        // No logueamos el rechazo: el log solo guarda lo que funcionó bien.
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
      logEvent({
        event_type: "tool_saved",
        tool_name: saved.name,
        item_type: itemType,
        outcome: "ok",
        param_keys: paramKeys,
        meta: { version: saved.version, verified: true },
      });
      return {
        content: [
          {
            type: "text",
            text: `Guardado y verificado: ${saved.name} (${saved.type} v${saved.version}) — smoke-run OK.`,
          },
        ],
      };
    }

    logEvent({
      event_type: "tool_saved",
      tool_name: saved.name,
      item_type: itemType,
      outcome: "ok",
      param_keys: paramKeys,
      meta: { version: saved.version },
    });
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
