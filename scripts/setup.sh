#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
node -e 'if(process.versions.node.split(".")[0]!=="24") throw new Error("Node.js 24 required")'
command -v uv >/dev/null || { echo "Install uv (tested with 0.12.23) before setup" >&2; exit 1; }
npm ci --ignore-scripts --cache "${TMPDIR:-/tmp}/agent-city-npm"
UV_CACHE_DIR="${TMPDIR:-/tmp}/agent-city-uv" uv sync --frozen --project services/runtime
if [ ! -e apps/web/.env.local ]; then
  cp apps/web/.env.local.example apps/web/.env.local
fi
echo "Dependencies installed. Start local mock mode with: npm run dev"
