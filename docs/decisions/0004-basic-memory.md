# ADR 0004 — Basic Memory: implementar nossa camada (opção D), usar como referência (C)

Status: aceito · Data: 2026-10-14

## Pesquisa (2026-10-14)
`basicmachines-co/basic-memory` v0.23.2 (PyPI 2026-08-25), **AGPL-3.0**, Python ≥ 3.12, SQLite (ou Postgres), FastMCP (exige `--prerelease=allow`), busca híbrida FTS + FastEmbed, notas Markdown com frontmatter, observações `[categoria]` e relações por wikilink, ferramentas `write_note/read_note/edit_note/search_notes/build_context/recent_activity…`, nuvem paga opcional, telemetria anônima de funil (desligável). Repositório ativo (push 2026-10-12). Fonte: README do repo + PyPI/GitHub API; **não** auditei o código-fonte.

## Avaliação
- É um bom *engine de memória pessoal de um agente*. `write_note`/`edit_note` **gravam direto**: não há fila de proposta, classificação (duplicata/complemento/atualização/substituição/conflito), revisão humana, política por agente nem revisão otimista — exatamente o diferencial exigido aqui (governança antes de persistência).
- Stack Python + FastMCP pré-release + AGPL adiciona uma segunda linguagem, dependência instável e obrigações de licença se redistribuído/integrado.
- Propriedade/interoperabilidade seriam boas (Markdown), mas o formato deles (observações/relações inline) é um dialeto próprio.

## Decisão
**D**: nossa camada em TypeScript, com **referência conceitual** a Basic Memory (Markdown + wikilinks + índice SQLite + MCP). Nosso formato (frontmatter + `[[wikilinks]]`) é Markdown puro e **legível por Basic Memory** se um dia quiser indexar a mesma pasta — sem lock-in em nenhuma direção. Reavaliar B (adotar parte) se surgir necessidade de embeddings locais prontos.
