#!/usr/bin/env bash
# Commita edições manuais pendentes (agrupadas) e empurra o vault para o remoto, se houver.
set -euo pipefail
V="${BRAIN_VAULT:-$HOME/second-brain}"
cd "$(dirname "$0")/.." && node packages/cli/dist/bin.js commit "brain: backup $(date -I)" --vault "$V" || true
if git -C "$V" remote | grep -q .; then git -C "$V" push --quiet && echo "push ok"; else echo "sem remoto configurado (git -C $V remote add origin …)"; fi
