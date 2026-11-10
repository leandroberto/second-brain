#!/usr/bin/env bash
# Sobe a API + UI web do Second Brain (o MCP não depende disto).
set -euo pipefail
cd "$(dirname "$0")/.."
if [ ! -f packages/cli/dist/bin.js ] || [ ! -f apps/web/dist/index.html ]; then
  echo "[second-brain] primeiro build…"; pnpm install --frozen-lockfile && pnpm build
fi
exec node packages/cli/dist/bin.js serve "$@"
