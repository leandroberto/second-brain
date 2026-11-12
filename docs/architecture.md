# Arquitetura

> Princípios: **CORE FIRST · API FIRST · WEB FIRST · DESKTOP OPTIONAL**. O ativo é a base de conhecimento (Markdown + Git) e a capacidade de vários agentes a usarem com governança — não o app que a exibe.

```
 Claude Code ─┐                                   Navegador (Windows/WSL)
 Codex ───────┼─ MCP stdio ─┐                      (futuro: Tauri / Electron / PWA)
 outras IAs ──┘             │                                 │ HTTP + SSE (127.0.0.1)
                            ▼                                 ▼
                    ┌─────────────────────  @brain/core  ─────────────────────┐
                    │ Brain (fachada) · governança · busca · índice · Git · lock │
                    └────┬───────────────┬──────────────────┬──────────────────┘
                         │               │                  │
                 Markdown (verdade)   SQLite (derivado)   Git (histórico)
                 knowledge/**.md      FTS5 + vetores      commits por operação
                         │
                         └── Obsidian abre a mesma pasta como vault
```

## Camadas e pacotes

| Pacote | Responsabilidade | Depende de |
|---|---|---|
| `@brain/shared` | tipos, schemas zod, ids, erros | — |
| `@brain/core` | **toda a regra de negócio**: parser, vault, índice, busca, embeddings, governança, propostas, **importador**, **doctor**, Git, lock, watcher, `Brain` | shared |
| `@brain/mcp` | adaptador MCP (stdio). Zero regra de negócio | core |
| `@brain/api` | adaptador HTTP/SSE local + serve o frontend. Zero regra de negócio | core |
| `@brain/cli` | `brain init/mcp/serve/seed/integrate…` | core, mcp, api |
| `apps/web` | React + Vite. Só fala com a API; ESLint proíbe importar Core/Node | API (HTTP) |

MCP e API são **dois adaptadores finos sobre a mesma fachada `Brain`**. Nenhuma regra (dedupe, segredos, política, concorrência) vive neles nem na UI.

Divergência deliberada do esboço do prompt (`storage/ search/ knowledge/` como pacotes): essas partes compartilham transações (lock → sync → escrever → indexar → commitar) e separá-las criaria ciclos e mais fronteiras sem ganho. A separação existe como **módulos** dentro do core (`vault`, `indexer`, `search`, `governance`, `git`…). Ver ADR 0002.

## Fluxo de escrita governada

```
agente ─ brain_propose ─▶ validar (segredos, tamanho) ─▶ normalizar ─▶ buscar semelhantes
        (nunca grava)                                               │
                               ┌── nenhum ──▶ classe "new" ─────────┤
                               └── há ──▶ comparar sentença a sentença
                                    new | duplicate | complement | update | replace | conflict
                                                   │  (heurística explicável + sugestão)
                                                   ▼
                              .brain/proposals/pending/<id>.json   (fila local)
                                                   │
                    humano (UI/CLI) ou política explícita decide: create / complement / update /
                                   replace / keep_separate / ignore
                                                   ▼
                lock ─▶ checa revision do alvo ─▶ grava .md (atômico) ─▶ git commit agrupado
                                                   ─▶ reindexa ─▶ decisão arquivada em proposals/decided/
```

## Concorrência (Claude + Codex + UI + Obsidian)

1. **Lock de arquivo entre processos** (`.brain/lock.d`, `mkdir` atômico, detecção de lock órfão). Toda escrita faz: adquirir lock → `sync()` → operar → liberar.
2. **Concorrência otimista por `revision`** (hash do arquivo). Propostas guardam a revision do alvo vista na análise; se mudou, a resolução falha com `conflict_revision`, a proposta vira `stale` e o revisor reanalisa. Edição manual (`updateNote`) exige `expected_revision`.
3. **Escrita atômica** (tmp + rename) e **commit só dos caminhos tocados** (`git commit --only -- paths`): alterações alheias no working tree não entram nem são perdidas.
4. **SQLite em WAL + busy_timeout** para vários processos.
5. **Sem loop watcher→índice→escrita**: o indexador só *lê* Markdown e escreve no SQLite; a escrita do Core gera evento cujo sync resulta em no-op (mesma revision).

## Busca híbrida

SQLite FTS5 (`unicode61 remove_diacritics`, bm25 ponderado título/tags/corpo) + similaridade de cosseno sobre vetores guardados em tabela SQLite (força bruta em memória; adequado para dezenas de milhares de notas). Sem banco vetorial externo (ADR 0003). Provider de embeddings plugável; sem embeddings a busca por texto continua funcionando.

## Auditoria

Atividade operacional (consultas, leituras, propostas, decisões, edições externas) fica na tabela `activity` do SQLite — **não** no Git. Conhecimento durável e quem o criou/decidiu ficam em Markdown/Git (`created_by`, trailers `Brain-Proposed-By`, `Brain-Decided-By`, `Brain-Resolution` nos commits). Retenção configurável.

## Segurança

- Segredos: regex best-effort (chaves cloud, tokens, JWT, credenciais em URL, atribuições `password=`…) **rejeita** a gravação; o valor nunca é ecoado. Blocos de código > 40 linhas e notas > 8000 caracteres são rejeitados.
- Paths: `safeResolve` bloqueia traversal, absolutos, NUL e symlinks que escapam do vault.
- API: bind em `127.0.0.1`, token Bearer (`.brain/api-token`, modo 0600, fora do Git), checagem de `Host` (anti DNS-rebinding) e `Origin`, CSP no frontend, corpo ≤ 1 MB.
- Embeddings externos: **opt-in** (`embeddings.external_opt_in`), e a UI mostra o que sai da máquina.

## Diagnóstico e operação
`brain doctor` (e *Configurações → Executar diagnóstico*) roda 12+ verificações — vault, config, Git, SQLite `quick_check`, FTS, consistência índice × arquivos (somente leitura), embeddings, API, watcher, **handshake MCP real** e estado das integrações Claude/Codex — e mostra a causa provável + o comando de correção. A fachada `Brain` é a única porta de escrita; o importador só produz **propostas**.

## Módulos
Extensões de outros repositórios, instaladas pelo dono e ligadas pela chave `modules` da config do vault: aba na UI (iframe com origem opaca e token de página), rotas, tarefas agendadas, estado próprio, ferramentas MCP, IA e avisos. Rodam dentro do `brain serve`, com um contexto restrito e escrita de conhecimento sempre como agente `module/<id>`; um módulo com falha não derruba os outros. O código vive em `packages/module-sdk` (contrato) e `packages/core/src/modules/`. Guia de autoria em [`modules.md`](modules.md) e decisão no [ADR 0015](decisions/0015-modulos.md).

## Import Assistant
`packages/core/src/importer/` (scan seguro → extração heurística → `processCandidates` → fila). Ver [`import.md`](import.md).
