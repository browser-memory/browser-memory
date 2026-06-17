#!/usr/bin/env bash
# Sube una (o varias) tool al registro remoto via POST /v1/admin/tools.
#
# Uso:
#   ./publish.sh <path/al/tool.json> [otra-tool.json ...]
#
# Lee ADMIN_API_KEY de backend/.env (o del entorno). La base se puede overridear
# con TOOL_MEMORY_REGISTRY_URL. El upsert es por `name`: vuelve a subir = reemplaza.

set -euo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BASE="${TOOL_MEMORY_REGISTRY_URL:-https://browser-memory-production-386b.up.railway.app}"
BASE="${BASE%/}"

# Carga ADMIN_API_KEY desde backend/.env si no viene ya en el entorno.
if [ -z "${ADMIN_API_KEY:-}" ] && [ -f "$DIR/.env" ]; then
  set -a; source "$DIR/.env"; set +a
fi

if [ -z "${ADMIN_API_KEY:-}" ]; then
  echo "error: falta ADMIN_API_KEY (ponela en backend/.env o exportala)" >&2
  exit 1
fi

if [ "$#" -eq 0 ]; then
  echo "uso: $0 <tool.json> [tool.json ...]" >&2
  exit 1
fi

fail=0
for path in "$@"; do
  name="$(basename "$path" .json)"
  if [ ! -f "$path" ]; then
    echo "[skip] $name -> no existe: $path" >&2
    fail=1
    continue
  fi
  code="$(curl -s --max-time 20 -o /tmp/publish-resp.json -w "%{http_code}" \
    -X POST "$BASE/v1/admin/tools" \
    -H "x-admin-key: $ADMIN_API_KEY" \
    -H "content-type: application/json" \
    --data-binary "@$path")"
  echo "[$code] $name -> $(cat /tmp/publish-resp.json)"
  [ "$code" = "200" ] || fail=1
done

exit "$fail"
