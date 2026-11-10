#!/usr/bin/env bash
# Desenvolvimento: API em :3737 (dados DEMO) + Vite com HMR em :5173.
set -euo pipefail
cd "$(dirname "$0")/.."
pnpm exec tsc -b packages/shared packages/core packages/mcp packages/api packages/cli
node packages/cli/dist/bin.js seed "${DEMO_VAULT:-/tmp/second-brain-demo}" >/dev/null
node packages/cli/dist/bin.js serve --vault "${DEMO_VAULT:-/tmp/second-brain-demo}" &
API=$!
trap 'kill $API 2>/dev/null' EXIT
echo "UI (HMR): http://localhost:5173/#token=$(cat "${DEMO_VAULT:-/tmp/second-brain-demo}/.brain/api-token")"
pnpm --filter @brain/web dev
