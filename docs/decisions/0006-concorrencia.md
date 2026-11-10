# ADR 0006 — Concorrência: lock de arquivo + revision otimista + commits por caminho

Status: aceito · Data: 2026-10-14

## Decisão
Escritas: `mkdir`-lock (detecção de órfão) → sync → operar → liberar. Cada proposta guarda a `revision` (hash) do alvo; divergência ⇒ `conflict_revision` + proposta `stale` + reanálise. `updateNote` exige `expected_revision`. Escrita atômica (tmp+rename); `git commit --only -- <paths>`. Índice SQLite em WAL.

## Alternativas
Daemon único dono de todas as escritas: rejeitado — o MCP precisa funcionar com a UI/daemon fechados. Lock do Git (`index.lock`) sozinho: insuficiente para a janela entre ler e escrever o Markdown.
