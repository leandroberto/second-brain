# ADR 0003 — Markdown+Git como verdade; SQLite (FTS5 + vetores) como índice derivado; sem banco vetorial

Status: aceito · Data: 2026-10-14

## Decisão
Fonte de verdade: `knowledge/**.md` versionado. `.brain/index.db` (SQLite WAL, FTS5, vetores como BLOB) é **reconstruível** (`brain reindex`; apagar o arquivo não perde nada). Busca = bm25 (FTS5) + cosseno em memória.

## Por quê
Para dezenas de milhares de notas a busca vetorial por força bruta é instantânea; Qdrant/Weaviate/Milvus/Elastic são infraestrutura sem necessidade concreta (princípio do prompt). `node:sqlite` evita compilar `better-sqlite3`/`sqlite-vec` no WSL. Verificado: FTS5 disponível (SQLite 3.53) com `remove_diacritics`.

## Limite conhecido
~50 mil notas: avaliar sqlite-vec/HNSW (FUTURE).
