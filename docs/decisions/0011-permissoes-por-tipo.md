# ADR 0011 — Permissões de agentes por tipo (preparadas, desligadas) e regras duras

Status: aceito · Data: 2026-10-14

## Decisão
`agents.commit_policy` (never|new_only|all) é o teto global; `agents.per_type` (review|auto) refina por tipo. Padrão: tudo `review` e `never`. **Regras duras** independentes da configuração: `conflict` e `replace` sempre exigem humano; `brain_supersede` é só proposta; a política é relida do disco sob o lock.

## Por quê
Preparar o caminho para auto-aprovar `reference`/`learning` no futuro sem reabrir a arquitetura, sem habilitar nada agora (integridade do conhecimento > conveniência).
