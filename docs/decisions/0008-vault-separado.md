# ADR 0008 — Vault separado do repositório de código; frontmatter leniente

Status: aceito · Data: 2026-10-14

## Decisão
O código vive em `second-brain/`; os dados em outro repositório (`~/second-brain` por padrão), criado por `brain init`. Seed/demo só em `brain seed` (vault descartável, dados fictícios). Parser leniente: nunca rejeita arquivo editado à mão; problemas viram avisos em *Saúde*.

## Por quê
Dados pessoais não se misturam ao código nem ao seed; o vault pode ter remoto privado próprio e sobreviver ao app.
