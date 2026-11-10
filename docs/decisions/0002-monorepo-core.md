# ADR 0002 — Monorepo TypeScript com Core único (menos pacotes que o esboço)

Status: aceito · Data: 2026-10-14

## Decisão
pnpm workspaces: `shared`, `core`, `mcp`, `api`, `cli`, `apps/web`. Node 24 (`node:sqlite` embutido, sem módulo nativo), TypeScript estrito, zod, vitest.

## Por que não `storage/ search/ knowledge/` separados
Compartilham a mesma transação (lock → sync → escrita → índice → commit). Pacotes separados criariam dependências circulares/DTOs sem benefício. A fronteira é por **módulo** no core. MCP e API são adaptadores sem regra; a UI é cliente HTTP.

## Alternativas
Python no core (ecossistema de embeddings): rejeitado — stack poliglota sem ganho claro na V1; embeddings reais entram por provider HTTP/local plugável.
