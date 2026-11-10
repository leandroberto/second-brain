# Import Assistant (bootstrap)

Objetivo: **alimentar o cérebro sem despejar documentos**. Fonte → candidatos a conhecimento durável → deduplicação → propostas → Review Queue → humano decide. Nada entra direto na base; nenhum LLM é necessário.

```
fonte ─ scan ─ extração ─ normalização ─ busca de semelhantes ─ classificação ─ proposta pendente
 (respeita .gitignore,    (heurística      (dedupe interno e        (new · duplicate · complement ·   (Review Queue / Inbox)
  limites, sem segredos)   explicável)      contra a base)           update · replace · conflict)
```

## Como usar
```bash
brain import ~/projetos/meu-repo --project meu-repo --dry-run   # só mostra os candidatos (nada é gravado)
brain import ~/projetos/meu-repo --project meu-repo --max 12    # cria até 12 propostas (mais confiáveis primeiro)
brain import docs/decisions/0004-x.md                           # um arquivo
pbpaste | brain import - --project meu-repo                     # texto pelo stdin
```
Opções: `--dry-run`, `--max N` (padrão 30), `--include-duplicates`, `--git-log` (decisões em mensagens de commit; baixa confiança), `--loose` (aceita sinais só no corpo; mais ruído), `--json`. Na UI: **Importar** (colar texto ou informar uma pasta dentro da sua home; prévia com caixas de seleção → "Enviar para a Review Queue").

Reexecutar é seguro: propostas idênticas já pendentes viram `JÁ`; o que já virou conhecimento aparece como `DUP` (duplicata) e não vai para a fila.

## O que é lido
`README*`, `AGENTS.md`/`CLAUDE.md`, ADRs (`adr/`, `decisions/`, `NNNN-título.md`), `docs/`, demais `.md/.mdx/.txt` (`.txt` só em `docs/`). Respeita `.gitignore` (via `git ls-files`) ou uma lista de pastas ignoradas (`node_modules`, `dist`, `build`, `venv`, `.git`…). **Nunca** lê: symlinks (nem os que escapam da raiz), binários, arquivos > 200 KB, `.env`/chaves/credenciais, `CHANGELOG`/`LICENSE`/handoffs/relatórios. Limites duros: 300 arquivos e 3 MB por execução. Não modifica o repositório de origem. Importação por caminho (API/UI) é restrita à home do usuário, com `realpath` (um link que aponta para fora é recusado).

## Conceitos

**Candidato** = um trecho de uma fonte que *pode* ser conhecimento. **Proposta** = um candidato que passou pelos filtros, foi comparado com a base (new/duplicate/complement/update/replace/conflict) e aguarda sua decisão. **Conhecimento durável** é o que continuará útil meses depois, sem abrir o documento de origem: uma decisão com seu porquê, uma regra, um fato estável do projeto, uma armadilha reutilizável. O Second Brain **não é um índice de headings**: o texto sob um cabeçalho pode ser conhecimento; o cabeçalho sozinho nunca é evidência.

## Pipeline de qualidade (`importer/quality.ts`, `importer/extract.ts`)

```
seção → tipo sugerido (sinal fraco) → Durabilidade → Autocontenção → Atomicidade → Evidência → Candidato(+why, confiança)
                                                                                                         ↓
                                              dedupe interno → similaridade com a base → classificação → proposta
```

| Estágio | Pergunta | Rejeita / faz |
|---|---|---|
| Sinal de tipo | o cabeçalho sugere decisão/aprendizado/regra/pergunta? | só **sugere** o tipo; cabeçalhos genéricos ("Decisões", "Arquitetura da Fase 2", "Overview") são reconhecidos como organizacionais |
| Durabilidade | isto dura e não é derivável do código? | conteúdo curto sem marcador normativo; texto que descreve o documento ("esta spec…"); lista só de links; **detalhe de implementação** (≥ 2 identificadores de código); planos/tarefas |
| Autocontenção | em 8 meses, sem o documento, faz sentido? | abertura deítica ("Estas decisões…", "Ela…", "As duas ramificações…") sem contexto; referência a outras seções do documento ("seção 12.5"); cabeçalho informativo → contexto do cabeçalho é **anexado** (`Contexto: …`), cabeçalho genérico → descartado |
| Atomicidade | uma ideia por memória? | lista de itens **independentes** (frases completas, com marcador normativo) → um candidato por item (≤ 3 por seção, ≤ 6 por documento); itens curtos/sem contexto ficam de fora; listas **coesas** (limitações, perguntas) permanecem juntas; itens repetidos entre listas são removidos |
| Evidência | o texto sustenta o título? | cabeçalho sem nenhuma afirmação no corpo → "só cabeçalho" (rejeitado); título sintetizado do conteúdo quando o cabeçalho é organizacional |

Princípios, não listas: a única lista de palavras estruturais é um **sinal fraco** para reconhecer título organizacional; nenhuma regra é "ignore o heading X".

## Confiança (calculada, não falsa precisão)
- **alta**: ADR com seção de decisão explícita, ou regras de `AGENTS.md`/`CLAUDE.md` em lista normativa — estrutura explícita e contexto claro.
- **média**: afirmações sustentam o título (itens separados de listas, seções com tipo sugerido pelo cabeçalho e confirmado pelo conteúdo, listas coesas, candidatos com contexto anexado ou título sintetizado).
- **baixa**: evidência fraca → **não vira proposta** (aparece em "descartados" com o motivo; `--loose` a admite).
Só confiança **alta, classe `new` e sem candidato semelhante** é elegível à aprovação em lote.

## Precisão > recall (por quê)
Uma memória ruim polui a base de forma permanente e degrada a recuperação de todas as outras; uma decisão não importada hoje pode ser importada amanhã. Por isso, na dúvida **não se propõe**. Custo conhecido: listas de princípios curtos e específicos de um projeto ("Telegram é uma fonte, não o domínio") ficam de fora do modo padrão; `--loose` as agrupa numa proposta de média/baixa confiança. Uma futura extração assistida por LLM (opcional) poderá recuperar casos difíceis.

## O que cada proposta carrega
título · resumo · tipo · projeto · tags · origem (`repo`, `arquivo#cabeçalho@commit`) · confiança · **trecho de evidência** · **por que virou proposta** (`why`) · seção-pai · sinalizadores (`heading-based`, `title-synthesized`, `enriched`, `split`, `group`) · semelhantes encontrados · classificação. A Review Queue mostra tudo isso; confiança média/baixa e sinalizadores de atenção ficam destacados. Candidatos descartados e o motivo aparecem em `brain import --dry-run --show-rejected` e na página Importar ("descartados pelos filtros").

## Lições do teste em repositórios reais
O primeiro desenho (palavras-chave em qualquer parte do título) gerou dezenas de falsos positivos num repositório real com ~20 specs/planos (ex.: "Motor de **decisão**…", "Task 4", datas `2026-08-19-x.md` confundidas com ADR, `todo` em português lido como TODO). Hoje: sinais ancorados no início do título, planos/tarefas ignorados, ADR só por pasta/numeração, sinais só-de-corpo atrás de `--loose`. Resultado no repositório real: 51 → 19 candidatos, praticamente todos "Decisões…", invariantes, arquitetura e limitações.

## Atualidade (o que ainda é verdade hoje)
Quando a fonte é um repositório git, cada candidato é **reconciliado com o HEAD** antes de virar proposta: tipo da fonte (ADR/spec/plano/docs/AGENTS), supersessão explícita, evidência em código/testes/config/dependências, documentos posteriores que descrevem mudança, reverts e nomes que saíram do código. A proposta mostra **extração** e **atualidade** separadas, as evidências, a sugestão ("Aceitar sugestão") e o esforço de revisão. Planos nunca viram fato atual sem código. Detalhes: `docs/knowledge-freshness.md`. Para propostas antigas: `brain reconcile <repo>` (somente leitura por padrão).

## Extensão futura
`Candidate` + `processCandidates()` são independentes da fonte: um extrator de conversas (chats exportados) ou um provider LLM opcional só precisa produzir `Candidate[]`; o restante (dedupe, classificação, fila, governança) é reaproveitado.
