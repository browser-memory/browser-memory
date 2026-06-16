# browser-memory backend

Registro remoto de **tools curadas** + **logging de uso**, sobre el Supabase existente.

El cliente MCP (`browser-memory`) le pega siempre: `discover` consulta el índice remoto,
`run` baja el JSON de una tool de server a memoria (Opción A, nunca a disco), y cada uso
del sistema reporta un evento. Este backend **no ejecuta** nada del navegador.

## Setup

1. Aplicá el esquema en tu proyecto Supabase: copiá `sql/schema.sql` en el **SQL Editor**
   del dashboard y ejecutalo (crea las tablas `tools` y `events`, el trigger y los índices).
2. `cp .env.example .env` y completá `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`,
   `ADMIN_API_KEY`, `PORT`.
3. `npm install`
4. Dev: `npm run dev` — Prod: `npm run build && npm start`.

Verificá: `curl http://127.0.0.1:8787/health` → `{ "ok": true, ... }`.

## Endpoints

Públicos (los usa el cliente MCP):
- `GET /v1/registry/index?sites=infobae,airbnb` → `{ entries }` (índice sin recipe).
- `GET /v1/registry/tool/:name` → `{ tool }` (el `definition` completo).
- `POST /v1/events` → ingesta de un evento de uso (`202`).

Admin (header `x-admin-key: $ADMIN_API_KEY`):
- `GET /v1/admin/tools` → lista todo (incluido `enabled=false`).
- `POST /v1/admin/tools` → upsert de una tool (body = objeto Tool/Composite).
- `PATCH /v1/admin/tools/:name` → `{ enabled?, definition? }`.
- `DELETE /v1/admin/tools/:name[?hard=true]` → soft delete (default) o borrado real.

## Curación

Dos vías intercambiables para subir/modificar la oferta:
- **Supabase Table Editor** (recomendado): editás el JSON de la columna `definition` a mano;
  el trigger recalcula `name/site/type/intent/keywords/side_effect/version` solo.
- **Endpoints admin**: vía programática (mismo efecto, con validación zod).
