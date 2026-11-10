# Modelo de conhecimento

## Layout do vault

```
~/second-brain/                 (repositório Git próprio; NÃO é o repo de código)
  AGENTS.md  README.md
  knowledge/
    inbox/                      notas com status proposed / capturas rápidas do Obsidian
    projects/<slug>/            tudo que tem `project:` (arquivo = <id>.md)
    decisions/ learnings/ facts/ preferences/ patterns/ references/ concepts/ open-questions/
    archive/                    status archived
  skills/second-brain/SKILL.md
  .brain/
    config.yaml                 (versionado)
    proposals/decided/          (versionado – trilha de auditoria das revisões)
    proposals/pending/          (ignorado – fila local)
    index.db  lock.d  api-token (ignorados; index.db é reconstruível)
  .obsidian/app.json            (opcional)
```

Diferenças em relação ao esboço do prompt: o **caminho é organizacional, não semântico** (a verdade está no frontmatter; mover arquivos não quebra nada — o nome do arquivo é o `id`, então `[[id]]` funciona no Obsidian em qualquer pasta); `people/` foi removido (sem uso concreto — pessoas são `concept` com tag); `fact`, `preference` e `open-question` ganham pasta própria quando não têm projeto.

## Frontmatter

```yaml
---
id: decision-promo-watcher-listing-resolution   # == nome do arquivo; [a-z0-9-]
title: Resolução de identidade de listings
type: decision            # decision|learning|fact|preference|pattern|reference|project|concept|open-question
status: active            # proposed|active|deprecated|superseded|archived
project: promo-watcher    # opcional
created_at: 2026-09-18T10:00:00.000Z
updated_at: 2026-10-14T10:00:00.000Z
tags: [marketplace, identity-resolution]
source: { type: pr, repository: promo-watcher, ref: "#12" }   # git|pr|issue|doc|conversation|manual|other
created_by: { kind: agent, name: claude-code }
confidence: high          # low|medium|high (opcional) — confiança de EXTRAÇÃO
verification: { state: current, confidence: high, against: promo-watcher@db30ad6, checked_at: 2026-10-14 }  # opcional: atualidade verificada no import (docs/knowledge-freshness.md)
relations:
  supersedes: ["[[decision-old]]"]     # aspas: o Obsidian reconhece como link
---
```

Mínimo obrigatório de verdade: `id`, `title`, `type` (o resto tem default). O parser é **leniente**: nota editada à mão sem frontmatter ou com YAML quebrado ainda é indexada (id derivado do nome do arquivo, `type: concept`) e aparece em *Saúde → problemas*; chaves desconhecidas do Obsidian são preservadas no roundtrip.

Sem campo `revision` no arquivo: a revision é o hash do conteúdo (calculado), logo edição manual nunca fica "fora de sincronia".

## Tipos (9) — todos necessários?

Mantidos: `decision` (escolha + porquê), `learning` (lição não óbvia), `fact` (dado estável: versão, limite — o exemplo do Python 3.12), `preference` (como o usuário quer), `pattern` (convenção reutilizável), `reference` (ponteiro canônico), `concept` (termo do domínio), `project` (visão geral), `open-question` (pendência). `fact` vs `learning` é a fronteira mais fraca; foi mantida porque `fact` é onde a deduplicação por valor (3.12 → 3.13) mais atua.

## Estados e substituição

`proposed` (inbox) → `active` → `deprecated` (ainda válido mas desaconselhado, rebaixado na busca) → `superseded` (substituído; relação `superseded_by`; **nunca deletado**) → `archived` (move para `archive/`). `superseded` também é o status de conhecimento **histórico** aprovado a partir do import (substituído, revertido ou que deixou de valer); `verification.state` diz qual (ADR 0012). Notas `active` com `verification.state` planned/uncertain/conflict são rotuladas e pesam menos na busca/contexto. Substituir cria a nota nova com `supersedes: [antiga]` e marca a antiga `superseded` + `superseded_by`, tudo no mesmo commit. Busca/contexto ignoram `superseded`/`archived` por padrão.

## Relações

`related_to, depends_on, supersedes, superseded_by, derived_from, applies_to, contradicts, implements, references` (frontmatter, tipadas) + links `[[wiki]]` no corpo (tipo `link`). `supersedes` mantém o inverso automaticamente. Links quebrados aparecem em *Saúde*.

## Governança: classificação da nova informação

| Classe | Critério (heurística explicável) | Resolução sugerida |
|---|---|---|
| `new` | nada acima do limiar de candidato (0.42) | create |
| `duplicate` | similaridade ≥ 0.78, quase nenhuma sentença nova, sem valor divergente | ignore |
| `complement` | semelhante, mas ≥ 20% das sentenças trazem informação nova | complement |
| `update` | mesma sentença-assunto com **números/versões diferentes** (3.12 → 3.13) | update |
| `replace` | intenção explícita (`brain_supersede`) | replace |
| `conflict` | mesma sentença-assunto com **negação invertida** | keep_separate (revisão humana) |

Similaridade = 0,45·cosseno + 0,35·cobertura lexical + 0,20·título (+bônus de mesmo projeto). Por padrão o cosseno vem do embedder `hash` (lexical/morfológico): detecta quase-duplicatas em pt/en, **não** paráfrases profundas — para isso configure um provider real. A classificação é uma *sugestão*; a decisão é humana (ou política `agents.commit_policy`).

Resoluções: `create`, `complement` (anexa seção datada com origem), `update` (substitui linhas com valor divergente e anexa o novo; prévia + edição antes de salvar), `replace`, `keep_separate` (cria + `related_to`), `ignore` (registra a decisão, não cria nada).

## Ids e nomes de arquivo
`<tipo>-[<projeto>-]<primeira oração do título>` em ASCII, ≤ ~80 caracteres, cortado em fronteira de palavra (`decision-second-brain-web-first`); colisões ganham `-2`, `-3`…; a nota `project` usa `project-<slug>`. O id é estável (renomear o título não muda o id).

## Segredos digitados à mão
Se alguém cola um segredo direto no Obsidian, a nota é indexada **mascarada** (FTS/embeddings/agentes nunca veem o valor), recebe o aviso "segredo detectado", fica **fora** de `commitPending` e bloqueia `link/update` até ser limpa (ver `docs/security-review.md`).
