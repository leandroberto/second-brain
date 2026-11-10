# Interface web

React 19 + TypeScript + Vite, CSS próprio (sem biblioteca de componentes; ~14 kB de CSS, ~114 kB gzip de JS). Servida pela própria API em `http://127.0.0.1:3737/`. **Não contém regra de negócio**: toda leitura/escrita passa por `/api/*` (a regra ESLint `no-restricted-imports` proíbe importar `@brain/core` ou `node:*` na UI). Por isso o mesmo frontend serve a browser, PWA, Tauri ou Electron.

Acesso: `brain ui` imprime `http://127.0.0.1:3737/#token=…` (o fragmento não é enviado ao servidor; o token fica no `localStorage` e a URL é limpa). Sem token a UI pede para colá-lo (`.brain/api-token`).

| Tela | Conteúdo |
|---|---|
| Home | saudação, contadores, fila de revisão, recentes, projetos ativos, mais consultados (30 d), atividade de agentes, saúde |
| Buscar | híbrida; filtros projeto/tipo/tag/período/inativos; trechos realçados |
| Conhecimento | corpo renderizado (`[[wikilinks]]`), metadados, autor/origem, relações e backlinks, semelhantes, histórico Git, uso/auditoria, edição com `expected_revision`, arquivar/depreciar, "Abrir no Obsidian" |
| Inbox / Revisão | lista + painel lado a lado **Existente × Proposto**, similaridade, classe e avisos, escolha **Complementar / Atualizar / Substituir / Manter separado / Ignorar**, prévia com diff e edição do resultado, nota da decisão (vai ao commit), reanálise quando `stale` |
| Importar | colar texto ou informar uma pasta; prévia dos candidatos (tipo, classe, confiança, origem, trecho de evidência) com seleção; envia à Review Queue |
| Projetos | lista + página com Visão geral, Decisões, Arquitetura/padrões, Aprendizados, Referências, Perguntas, Histórico, Relacionados (grafo) |
| Grafo | layout de forças em SVG (relações e wikilinks), destaque de vizinhos, cores por tipo |
| Timeline | atividade agrupada por dia (filtrável por agente) |
| Agentes | consultas, contribuições, última atividade (auditoria) |
| Configurações | saúde, reindexar, commit de edições manuais, últimos commits (+reverter), embeddings/opt-in, Git, política de agentes, limiares, retenção, tema |
| Ctrl+K | paleta: comandos (buscar, adicionar, abrir projeto, revisar, atividade, criar projeto, reindexar, commitar, abrir no Obsidian) + busca ao vivo; `/` também abre |

Adicionar conhecimento (`+ Adicionar`): checa semelhantes **ao digitar** e oferece "Criar agora" ou "Enviar para revisão".
Acessibilidade: foco visível, `aria-*` nos tabs/diálogo/combobox, `prefers-reduced-motion`. Tema escuro por padrão (claro opcional).

## Review Queue (revisão da madrugada)
Mostra **todas** as pendentes (filtros por classe e origem; `j`/`k`), "Inbox" = só as `new`. A **aprovação em lote** só vale para propostas `new` + confiança **alta** + **sem semelhantes** (caixas de seleção só nelas; confirmação listando títulos; **um** commit); o core recusa o resto mesmo que a UI seja contornada. Cada decisão exibe **"O que acontecerá ao confirmar"** em linguagem direta (ex.: *Substituir*: cria novo e marca o antigo `superseded` — **não é apagado**). Dá para **editar a proposta** antes de decidir (reanálise automática), ver a origem de importação (regra + trecho), ignorar duplicatas em lote (um commit) e, após aprovar uma proposta, as demais sobre o mesmo assunto são reanalisadas.

## Home
Onboarding discreto quando a base está vazia (conectar Claude/Codex com status real, criar projeto, importar, abrir no Obsidian). Depois: o que precisa de você (revisão, edições manuais sem commit, problemas de saúde, conhecimento antigo), o que mudou, projetos ativos, mais consultados, atividade dos agentes.
