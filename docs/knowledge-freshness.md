# Atualidade do conhecimento (freshness) e reconciliação com o estado atual

> Princípio: **o humano revisa exceções, não faz a curadoria da base.** Antes de pedir que alguém persista algo como conhecimento atual, o Second Brain tenta descobrir sozinho se aquilo ainda é verdade e mostra por quê.

## O problema
Uma afirmação pode estar **corretamente extraída** e mesmo assim **desatualizada**: a spec antiga descreve uma arquitetura que mudou, o plano tem uma tarefa nunca executada, a ADR foi substituída, o README diz X e o código faz Y, uma mudança foi feita e revertida. Descartar isso perde a história. Gravar como `active` mente sobre o presente.

## Duas confianças, duas perguntas

| | Pergunta | Onde fica |
|---|---|---|
| **Extração** (`draft.confidence`) | "Entendemos corretamente o que esta fonte afirma?" | calculada pelo Import Assistant (`docs/import.md`) |
| **Atualidade** (`proposal.freshness.confidence`) | "Esta afirmação ainda representa o estado atual?" | calculada pela reconciliação (este documento) |

Uma ADR de 2025 pode ter extração **alta** e atualidade **baixa** (há uma ADR de 2026 que a substitui). A UI mostra as duas lado a lado e a incerteza de atualidade nunca fica escondida atrás de uma extração alta.

E duas perguntas que **não se substituem**:
- **WHY / intenção**: por que algo foi decidido? Fontes: ADR, spec, discussão consolidada. Campo `intent`: `in_force | superseded | reverted | unknown | n/a`.
- **WHAT IS TRUE NOW / implementação**: o que o sistema faz hoje? Fontes: código, testes, config, dependências do HEAD. Campo `implementation`: `confirmed | partial | absent | diverges | unknown`.

**Código prova estado, não intenção.** Se o código faz Y e uma ADR antiga diz X sem nada explicando a mudança, o resultado é *implementação = diverge, intenção = não determinada*: o sistema não inventa uma decisão nova. **Plano não prova implementação**, e "Task 17 — migrar o resolver para product_id" só vira atual com evidência no código.

## Semântica das fontes (`sourceKindOf`)

| Tipo | Significado | Tratamento |
|---|---|---|
| `adr` | decisão explícita / intenção | status da ADR e ADRs posteriores decidem a intenção; ADR vigente sem evidência de código continua "atual (baixa)" |
| `spec` | comportamento/arquitetura acordados **naquele momento** | só vira atual com evidência no HEAD; sem âncoras verificáveis → `uncertain` |
| `plan` | trabalho pretendido, **não** prova de implementação | sem evidência → `planned` (sugestão: ignorar). Checkbox `[x]` é sinal fraco (nos repositórios reais os checkboxes nunca são marcados) |
| `readme`, `docs`, `changelog` | descrição, que envelhece | código/testes contradizem → `conflict` (documentação desatualizada) |
| `agents` (AGENTS.md/CLAUDE.md) | regra operacional atual quando está no HEAD | sem âncoras → atual (média) |
| `code`, `test` | estado observável | usados como **evidência**, nunca como fonte de intenção |
| `issue`, `commit` | intenção / mudança declarada | idem plano / histórico |

Detectado pelo caminho (`docs/adr/`, `specs/`, `plans/`, `*-design.md`, `README.md`…) e, para documentos genéricos, pelo conteúdo (≥ 3 checkboxes ou "Task N" = plano). Texto colado formulado como trabalho futuro ("Implementaremos…", "will add", `TODO` maiúsculo) é `planned` mesmo sem repositório.

## Modelo mínimo (sem taxonomia nova na nota)

Nada de 20 campos novos. O ciclo de vida continua sendo o `status` que já existia; a atualidade entra em dois lugares:

1. **Na proposta** (`proposal.freshness`, para a revisão): `state`, `confidence`, `intent`, `implementation`, `source {kind, path, commit, date, in_head}`, `against {repo, commit, date}`, `evidence[]` (≤ 12, cada uma com `kind`, `stance` = sustenta/contradiz/contexto, `ref` rastreável e `detail`), `summary`, `suggestion`, `effort`, `checked_at`.
2. **Na nota aprovada** (frontmatter), só o necessário para a recuperação:
   ```yaml
   status: superseded            # histórico NÃO compete com o atual (busca/contexto o excluem por padrão)
   source: { type: doc, repository: promo-watcher, ref: "docs/…#…@db30ad6", kind: spec }
   verification: { state: superseded, confidence: high, against: promo-watcher@db30ad6, checked_at: 2026-10-14 }
   ```
   A evidência completa fica na proposta decidida (`.brain/proposals/decided/`, versionada), não poluindo a nota.

Estados (`FreshnessState`): `current` (inclui "implementado", que é `current` vindo de plano/spec), `planned`, `historical`, `superseded`, `reverted`, `uncertain`, `conflict`. Ao aprovar, `superseded/reverted/historical` viram **nota com `status: superseded`** (o revisor pode desmarcar "Registrar como histórico"); os demais viram `active`, e os não confirmados (`planned/uncertain/conflict`) ficam **rotulados** na busca e no contexto.

## Pipeline

```
fonte → extração → durabilidade → autocontenção → atomicidade → evidência → candidato
      → semelhantes na base → ATUALIDADE (reconciliação com o HEAD) → sugestão + esforço → proposta (humano decide)
```

### Reconciliação (`packages/core/src/freshness/reconcile.ts`)
Para cada candidato, as 12 perguntas viram passos determinísticos:

1. **Origem e idade**: tipo da fonte, commit e data em que o arquivo entrou (uma única passada de `git log --name-status`), última alteração, se ainda está no HEAD, renomeações e exclusões.
2. **Supersessão explícita**: status da ADR (`superseded/deprecated/rejected…`), "Superseded by ADR-N", outra ADR que declara substituí-la, marcador de obsolescência no próprio documento, outro documento que diz substituir este arquivo. Resultado: `superseded` (alta).
3. **Âncoras verificáveis** (`semantics.ts`): identificadores de código (snake_case, camelCase, CONSTANTES, `entre crases`), caminhos de arquivo, tecnologias de um léxico **genérico** com categorias mutuamente exclusivas (bancos, filas, estilos de API, shells desktop…), nomes próprios e, com peso baixo, palavras de conteúdo. Cada âncora tem **polaridade**: "não usaremos Electron", "Y em vez de X", "X foi substituído" marcam negação. Negação sem verbo de escolha ("o serviço não conhece aiogram", "sem SQL") é **ambígua** e descartada. Nome do projeto nunca é âncora.
4. **Evidência no HEAD** (`repo.ts`): índice invertido de identificadores lido dos **blobs do commit HEAD** (`git ls-tree` + `git cat-file --batch`). A árvore de trabalho nunca é evidência do HEAD: alteração não commitada não confirma nada. Snake e camel colapsam na mesma chave, com subtokens e bigramas, e as dependências declaradas (`package.json`, `pyproject.toml`, `requirements*.txt`, `go.mod`, `Cargo.toml`) também entram. **Não é busca da frase literal**: `catalog_id`, `catalogId` e `CatalogId` são a mesma chave, e "listing identity" casa com `resolve_listing_identity`. **Implementação exige código, config ou dependência de produção**; teste só corrobora (pode ser descrição, fixture ou legado).
5. **Evidência contrária**: âncora positiva ausente; rival da mesma categoria presente ("docs dizem MySQL, código usa `pg`"); âncora negada que está em uso; documento **posterior** que descreve a mudança ("migramos de X para Y", "Y em vez de X", "X deixou de…"); emenda no **próprio** documento.
6. **Git**: commits relacionados depois da fonte; commit relacionado que foi **revertido** (`Revert "…"` / `This reverts commit …`); identificador que **existiu e saiu** do código (`git log -S`, orçamento por índice).
7. **Decisão** com regras explícitas (ex.: supersessão explícita → `superseded`; revert sem implementação → `reverted`; documento posterior descreve migração e o HEAD bate com o estado novo → `superseded`; descrição contradita por código e testes → `conflict`; intenção contradita sem explicação → `uncertain`; plano sem evidência → `planned`; sem nada verificável → `uncertain`/"confirmar").

Toda conclusão traz evidência rastreável (`arquivo:linha`, `commit abc1234`, caminho da ADR). Sem evidência suficiente, o estado é `uncertain` e o sistema não inventa nada.

### Salvaguardas contra falso CURRENT (aprendidas no dogfood e na revisão independente)
- **Âncora específica**: confirmar exige um identificador ou caminho presente em código de produção, **ou** uma tecnologia numa frase de **escolha pura** ("Usaremos SQLite como banco local", "Usar gRPC para a API pública", "O cache é Redis"). "We use Redis to encrypt every session…" com `redis` no `package.json` **não** confirma o predicado e fica parcial.
- **Cobertura**: se o índice atingiu limites ou ignorou arquivos de código grandes, a ausência é confirmada com `git grep` no HEAD e nunca presumida. Âncora que não pôde ser verificada **continua contando** (o resto da afirmação não confirma sozinho), e falha ao listar ou ler os blobs do HEAD invalida o índice: a análise cai para a semântica da fonte.
- **Caminho para arquivo-vocabulário** (lista de nomes) prova que o arquivo existe, não a afirmação: parcial.
- **Arquivos-vocabulário** (que citam ≥ 6 tecnologias distintas, como léxicos e fixtures) não contam como uso de nenhuma delas.
- **Teste sozinho** não prova implementação: identificador só em teste é corroboração (evidência parcial), tecnologia só em teste nem isso. Teste pulado (`.skip`, `xfail`) ou de legado/compatibilidade não conta.
- **PascalCase solto na prosa** ("TypeScript", "GitHub") não é identificador. A ausência dele não contradiz e a presença só em teste não confirma. Se o documento original o escreve entre crases, é identificador.
- **Nome próximo** (`x_ratio_7d` ausente, `x_ratio` presente) é evidência *parcial*, nunca contradição. Um commit posterior que cita o nome exato e altera o arquivo do nome próximo aparece como **contexto** para o revisor; o assunto de um commit não prova implementação nem equivalência entre nomes.
- **Repetição não é evidência**: dois documentos antigos dizendo X não aumentam a confiança (documentos nunca contam como evidência de implementação).
- "Existiu e saiu" só vale se o termo não está em **nenhum** arquivo do HEAD, nem em comentário (`git grep`); senão o pickaxe acha a adição, não a remoção.
- **Revert** só derruba a afirmação quando o HEAD não a contém (reverter uma melhoria relacionada não reverte o que continua implementado).
- **Polaridade**: rejeição exige verbo de escolha ("não usaremos X"); "o serviço não conhece X" ou "sem X" é ambíguo e descartado. Voz ativa ("Redis replaced Memcached": Redis é o novo) × passiva ("X was replaced"), e negação perto da troca ("não foi substituído") anula a regra.
- **Emenda no próprio documento**: uma frase quase idêntica à afirmação com mudança de polaridade ("we no longer use…", "não usamos mais…") é uma reversão, não a própria afirmação.
- **Datas**: documento "posterior" é o que entrou depois da **última revisão** da fonte (instantes reais, não texto de data). Renomeações são seguidas.
- **ADR "Proposta"**: implementação não transforma proposta em decisão (`intent` fica não determinada). ADR não versionada é lida da árvore de trabalho só para status e supersessão.
- **Plano × HEAD diferente**: o HEAD usar outra coisa hoje não prova que o plano foi abandonado (continua `planned`).

## Sugestão e esforço de revisão

| Sugestão | Quando | "Aceitar sugestão" faz |
|---|---|---|
| `accept_current` | atual com evidência | cria nota ativa |
| `confirm` | não verificável no código e nada contradiz (ou ADR vigente ainda não implementada) | cria nota ativa (o humano confirma que ainda vale) |
| `accept_historical` | substituída/revertida/histórica | cria nota com `status: superseded` |
| `complement_current` | histórica **e** há nota ATIVA semelhante na base | anexa como seção "Histórico" à nota atual |
| `ignore` | plano sem implementação; documentação desmentida pelo código | ignora a proposta e registra o motivo |
| `investigate` | evidência conflitante (intenção × implementação, migração inacabada) | — (decisão humana; evidências abertas) |

**Esforço de revisão** (métrica de UX/governança, **nunca** usada para aprovar sozinho): `auto_clear` (evidência forte e sugestão clara), `quick` (só confirmar), `investigate` (conflito/incerteza com evidência contrária). O objetivo do produto é maximizar `quick`/`auto_clear` e minimizar `investigate`. **Auto-approve continua desligado:** atualidade `current` + extração alta ainda passa pelo humano. A aprovação em lote exige atualidade `current` com confiança média ou alta (o core recusa o resto).

## Recuperação: atual primeiro, histórico acessível
- `brain_search`: `superseded`/`archived` ficam fora por padrão (`include_inactive: true` para história). Notas ativas não confirmadas (`planned/uncertain/conflict`) vêm com `freshness` e peso 0,85.
- `brain_context`: `items` = estado atual. Quando algo **substituído** casa com o tópico, o **sucessor atual** entra em `items` (mesmo que não tenha casado) e o antigo vai para `history` como "X substituído por Y — não é o estado atual". Se a consulta pede evolução ("por que mudou", "histórico", "antes", "legado"), `history` traz resumos (até 5). Itens atuais que substituíram algo carregam `supersedes`. Nunca há X e Y lado a lado sem dizer qual vale.

## Git e desempenho
- **Uma varredura por fonte**: `git ls-tree` do HEAD + **um** `git cat-file --batch` para os blobs de código/teste/config/docs (limites: 4 000 arquivos, 30 MB, 400 KB por arquivo, 400 docs) + **um** `git log --name-status -M` (até 3 000 commits) + status das ADRs. Depois, N reconciliações baratas em memória. Textos normalizados dos documentos e um índice token→documentos são construídos **uma vez** (não por candidato).
- **Pickaxe** (`git log -S`) só para identificadores ausentes, no máximo 12 por varredura, com timeout de 6 s cada. **`git grep`** (no máximo 30 por varredura) só para confirmar ausência com índice incompleto ou antes de afirmar "existiu e saiu".
- **Cache derivado em memória** por (raiz, sha do HEAD, limites). Como o HEAD é imutável, o cache é sempre correto: reimportar ou enviar a prévia (submit da UI) com o mesmo HEAD não refaz a varredura (de ~0,5–1,1 s para ~10 ms). É descartável e reconstruível; não há cache em disco.
- Tempos medidos num repositório real de 269 commits e 153 arquivos: varredura de cerca de 0,5 s e reconciliação de 18 candidatos em cerca de 1 s.

## Segurança
O repositório analisado é **não confiável**:
- O git roda endurecido: `core.fsmonitor=false`, `core.hooksPath=/dev/null`, `--no-ext-diff --no-textconv`, `GIT_OPTIONAL_LOCKS=0` (não reescreve o index do repositório inspecionado), sem prompt e sem pager, sempre com `execFile` e argumentos em array.
- Nenhum script, teste ou hook do projeto é executado. O conteúdo do repositório nunca é interpretado como comando.
- Não segue symlinks e não sai da raiz (`realpath`). Não lê `.env`, chaves, credenciais nem lockfiles. Binários e arquivos grandes ficam fora.
- Segredos em documentos e mensagens de commit são mascarados **na origem**, antes de normalizar ou recortar o trecho de evidência, e de novo ao montar a proposta.
- Só o importador (ator `system`) anexa atualidade a uma proposta. A API **recalcula** a atualidade no servidor ao enviar candidatos, e um `POST /api/proposals` comum (humano, agente ou cliente HTTP) nunca injeta um veredito.
- Editar o rascunho rebaixa a verificação para "incerta" (o veredito valia para o texto anterior) e guarda o veredito anterior (`stale_from`). Uma proposta histórica, mesmo editada, não pode fazer `update`/`replace` de nota **atual** sem `as_historical=false` explícito; alvo já histórico pode ser atualizado.
- Todo comando git usa o **sha** resolvido do HEAD (nunca `HEAD`): um checkout durante a análise não mistura commits nem contamina o cache. `cat-file` com saída incompleta ou código de erro invalida os arquivos afetados.

## Ferramentas
- `brain import <repo> --dry-run --show-evidence`: mostra estado, conclusão e evidências por candidato.
- `brain reconcile <repo> [--show-evidence] [--apply]`: reverifica as propostas **importadas** e pendentes daquele repositório. Sem `--apply` é só leitura; com `--apply`, grava apenas o campo `freshness` nas propostas pendentes (rascunho, análise e decisão intactos).
- `node scripts/freshness-bench.mjs saida.json <repo>…`: dogfood de import com veredito por candidato (vault temporário). `--cases <arquivo.json>` roda afirmações com gabarito (`{ repo, cases: [{ path, title, body, expected }] }`).
- `node scripts/freshness-queue.mjs <pasta-de-propostas> repo=caminho…`: análise somente leitura de uma fila (lê JSON, não abre o vault).

## Origem da afirmação: documento importado × síntese (2026-10-14, tarde)

A reconciliação foi calibrada para **trecho de documento importado**: um documento posterior que descreve uma mudança o refuta. Aplicada a **notas de agente**, sobre-sinalizava: 22 de 23 notas corretas apareciam como contraditas, substituídas ou "investigar". Exemplo: uma frase do PROGRESS.md sobre outro assunto "refutava" 6 notas de um mesmo projeto.

Agora `origin` (`imported` | `agent` | `human`) e `asOf` mudam a estratégia.

- **Documento importado:** estratégia anterior. Ganhou um ajuste: frase condicional ou de plano ("quando migrarmos…") não conta mais como migração.
- **Síntese (agente/humano)** só é refutada por:
  - **proposição incompatível** (`propositions.ts`): estado de produção/lançamento e chaves ligado/desligado, contra a config do HEAD e contra frases **afirmativas** de documentos POSTERIORES a `asOf`. "Quando entrar em produção…" nunca contradiz; um documento **anterior** que diverge vira evidência "corrija a fonte";
  - **código/config atual** que viola o que a nota rejeita;
  - **remoção ou revert no Git** de um nome que a nota cita;
  - **documento/ADR posterior** que descreve a mudança de um nome **específico** (identificador de código, caminho, tecnologia numa escolha pura). Nome de produto ou palavra comum não conta.
- **Nome ausente numa síntese não refuta.** O motor distingue:
  - referência a documento ou arquivo do HEAD;
  - artefato gerado (`dist/`, `.next/`);
  - nome que só existe na documentação (`uncertain`: "confirme o nome real");
  - nome ausente de tudo (`uncertain`: outra branch ou outro repositório).
- **Síntese nunca vira histórico sozinha.** Evidência nova e incompatível gera a sugestão **`revalidate`** (revisão rápida, com a evidência).

**Benchmark real** (27 notas de agente rotuladas à mão contra o Git; o script e os rótulos ficaram fora do repositório público porque usam dados privados):

| | Falsos positivos | Sinais verdadeiros | Incertos de outra branch |
|---|---|---|---|
| Antes | 22/23 | — | — |
| Depois | **0/23** | **2/2 mantidos** (trigger citado só na ADR; PROGRESS.md dizendo "em produção") | 2/2 não promovidos a atual |

Todas as 27 ficaram em revisão rápida. O gabarito de documentos importados não mudou (8/10).

## Conhecimento temporal e revalidação

Algumas verdades valem **numa data** e expiram por um **evento**, não por idade: "ainda não está em produção", "a flag X está desligada". Para elas, a nota leva `temporal: { as_of: AAAA-MM-DD, revalidate_when?: "evento" }`, e só isso, sem taxonomia nova.

- `brain_context` entrega `temporal` junto com o item e pede revalidação antes de qualquer ação destrutiva.
- `brain revalidate <repo>` reverifica o conhecimento **aprovado** ligado ao repositório. É somente leitura; com `--apply`, cada caso vira **uma** proposta de manutenção (`maintenance.kind = "revalidate"`), nunca uma alteração:
  - **Confirmar:** continua valendo, e `as_of` é renovado.
  - **Alterar:** edite o texto para o estado novo.
  - **Ignorar:** mantém a nota como está.
- Agente não injeta revalidação nem veredito. A manutenção é do sistema e a decisão é humana.

## Corrija a fonte antes de ensinar o cérebro a compensar

Quando um documento está errado (README com comando incompleto, CLAUDE.md descrevendo auth antiga, PROGRESS.md dizendo "em produção"), o caminho preferido é **corrigir a fonte** e depois reimportar ou reconciliar. Uma heurística permanente para contornar documento ruim é o último recurso. A reconciliação ajuda a achar essas fontes: documento ANTERIOR que contradiz uma síntese aparece como "corrija a fonte".

## Títulos

`brain maintain titles` detecta títulos que não se sustentam fora do documento: dependentes do nome do arquivo ("CLAUDE.md: Architecture"), organizacionais ("Decisões fechadas neste documento"), sem sujeito. Sugere um título derivado da primeira afirmação do corpo. Com `--apply`, gera propostas (Confirmar renomeia mantendo id e arquivo); nada é renomeado sozinho.

## Limitações
- Sem compreensão semântica de código: afirmações sobre **comportamento** ("o failure_reason é zerado ao entrar em joining") são confirmadas pela existência dos nomes, não do comportamento.
- Afirmações **negativas sobre conceitos** ("não há outbox") ficam `uncertain`: a ausência só é verificada para tecnologias com verbo de escolha.
- Português ↔ inglês: palavras de conteúdo não se traduzem ("respostas" ≠ `response`). Âncoras fortes (identificadores, tecnologias) não dependem de idioma.
- O léxico de tecnologias é curado e finito; tecnologia fora dele vale só como identificador ou nome próprio.
- O pickaxe é limitado; clones rasos (`--depth`) têm histórico parcial e então datas e reverts antigos não aparecem (o estado vira `uncertain`, nunca `current` por falta de histórico).
- Data da afirmação = data em que o **arquivo** entrou no repositório (sem `blame` por linha, por desempenho); uma seção adicionada depois herda a data do arquivo.
- A reconciliação roda no import e, para conhecimento aprovado, sob demanda (`brain revalidate <repo>`); não há agendamento periódico ainda.
- Proposições de estado cobertas: produção/lançamento e ligado/desligado. Outras ("migração ainda não executada", "cliente não usa Y") ficam como `temporal` com revalidação humana pelo evento.
