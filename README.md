# tool-memory-mcp

MCP server local que le da a un agente una **memoria de acciones web reutilizables**: la
primera vez que se hace una acción en un sitio se *aprende* y se guarda como un tool
ejecutable; la próxima se *descubre* y se *ejecuta directo*, sin re-averiguar nada.

Este repo es el **MVP (Etapas 0-2)**: Chrome compartido por CDP, memoria en disco + discovery,
y el runner que ejecuta recipes de forma determinista. `learn`/distiller (E3) y composites (E4)
vienen después.

## Arquitectura

Un solo Chrome (perfil dedicado + `--remote-debugging-port`). Dos clientes se atachan vía CDP y
ven el mismo estado:

- `@playwright/mcp` (`--cdp-endpoint`) — **explorar** al aprender.
- `tool-memory` (`connectOverCDP`) — **ejecutar** recipes (`discover` / `run` / `save`).

## Uso

```bash
npm install
npm run build
npm test        # tests unitarios (sin navegador)
npm run smoke   # end-to-end: lanza Chrome, discover → run sobre Wikipedia
```

Para usarlo desde Claude Code, registrá los dos MCP (ver `.mcp.json`). `tool-memory` es dueño
del Chrome y lo levanta al iniciar; `@playwright/mcp` se atacha al mismo endpoint.

## Memoria

Vive en `~/.tool-memory/` (`tools/*.json` + `index.json`). Override con `TOOL_MEMORY_HOME`.
Secretos nunca se guardan en tools ni traces (perfil persistente / `creds.local.json`).

## Tools del MCP

- `discover(goal)` → candidatos con score, params y side_effect.
- `run(name, params)` → datos estructurados. Errores tipados: `re-auth`, `no-aplica`, `tool-roto`.
- `save(tool)` → valida y persiste un tool.
