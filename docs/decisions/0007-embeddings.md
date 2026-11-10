# ADR 0007 — Embeddings plugáveis; offline por padrão; externo é opt-in

Status: aceito · Data: 2026-10-14

## Decisão
Interface `EmbeddingProvider`. Padrão `hash-v1` (offline, determinístico: palavras+bigramas+trigramas de caracteres, 512 dims). Opcional `openai-compatible` (OpenAI/Ollama/LM Studio) — se a URL não for localhost exige `external_opt_in: true`, senão cai para `hash` com aviso. Trocar provider invalida vetores e reembute. Sem embeddings o FTS5 segue funcionando.

## Honestidade
`hash-v1` **não é semântica profunda**; serve para quase-duplicatas e morfologia. Documentado em UI e docs.
