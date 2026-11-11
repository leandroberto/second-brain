# ADR 0015 — Módulos: extensões do dono, no processo do `serve`

**Status:** aceito (2026-11-11)

## Contexto

O second-brain é público e genérico. O dono quer crescer com coisas que só fazem sentido para ele (rotinas próprias,
integrações privadas) sem que nada disso entre neste repositório. O primeiro caso real é uma rotina diária com aprovação
humana: de manhã o módulo junta dados de fontes externas e monta um rascunho, e só depois do OK do dono executa uma ação
externa. O desenho precisa servir esse caso inteiro sem que o second-brain saiba nada sobre ele.

Um módulo precisa de: aba na UI, rotas HTTP, tarefas agendadas que recuperam a execução perdida, estado próprio,
ferramentas MCP, motor de IA, avisos e acesso governado ao conhecimento.

## Decisão

Um módulo é um **pacote Node, instalado pelo dono, carregado dentro do `brain serve`**. Ele mora num repositório próprio e é
ligado pela chave `modules` do `.brain/config.yaml`. O guia de autoria está em [`docs/modules.md`](../modules.md).

### Alternativas

| | Como | Resultado |
|---|---|---|
| **A** | Pacote Node carregado no `serve`, com contexto restrito (`ctx`); aba em iframe | **escolhida**: um processo, pouca infraestrutura; agendador, rotas e MCP quase de graça |
| B | Serviço separado que se registra por HTTP; o second-brain faz proxy da aba e das rotas | descartada: isolamento total e qualquer linguagem, mas cerca do dobro do trabalho (tokens por módulo, proxy de MCP, um serviço por módulo, agendador repetido). Não compensa para um dono com módulos próprios |
| C | UI do módulo compilada junto com `apps/web` | descartada: prende o build público ao código privado, que é o que se quer evitar |

### Modelo de confiança

Módulos são **código instalado pelo dono** e rodam no processo do second-brain com o poder do Node. A proteção que o
desenho oferece é contra **erro** (isolamento de falhas, contexto restrito, governança) e contra **conteúdo hostil na
página** (XSS), **não contra um módulo malicioso**. Quem instala um módulo confia nele como confia em qualquer pacote que
roda na própria máquina.

- O módulo nunca é humano. Tudo que ele grava em conhecimento passa pela fachada `Brain` com o ator
  `principal("agent", "module/<id>", "module")` (ADR 0013), com o mesmo poder de um agente. Um módulo não decide propostas
  alheias nem usa operações de revisor.
- O second-brain nunca importa um módulo pelo nome: só pela lista `modules` da config do vault.
- O estado do módulo fica sempre fora da pasta do vault (`<stateDir>/modules/<id>/`).

### Credenciais e prova de humano

| Credencial | Rotas de módulo | `chamador` |
|---|---|---|
| Sessão humana da UI | todas, fora de `_mcp` | `{ via: "ui", humano: true }` |
| Token de página (só sessão humana `full`) | só `/api/modules/<id>/*` do próprio módulo, fora de `ui-token`, `_mcp` e `_tarefas` | `{ via: "pagina", humano: true }` |
| api-token do vault (agentes, MCP) | só `_mcp` e `GET /api/modules` | `{ via: "mcp", humano: false }` |
| Credencial do desktop | nenhuma (só avisos) | — |

`chamador.humano` é a única prova de humano que o módulo deve usar. Rotas com `humano: true` recusam (403) quem não é
humano antes de chamar o handler. O `_mcp` não repassa nome de agente por cabeçalho: `chamador` traz só `via: "mcp"`.

### Aba em iframe e origem `null`

A aba é uma página estática do módulo, servida em `/modules/<id>/*` e aberta num `<iframe sandbox="allow-scripts
allow-forms">` **sem** `allow-same-origin`. A página tem origem opaca (`Origin: null`): não lê a janela do second-brain, o
armazenamento nem a sessão humana.

Como `null` vale para qualquer origem opaca, **a segurança vem do token de página, não da origem**. O token é curto (12 h,
só em memória do processo), emitido por módulo (`POST /api/modules/<id>/ui-token`) e só para a sessão humana `full`. Vale
somente para as rotas do próprio módulo: não vale em `ui-token`, `_mcp` nem `_tarefas`. A checagem roda antes do roteamento.
`Origin: null` só é aceito nos prefixos `/api/modules/<id>/*` e `/modules/<id>/*`; em qualquer outro caminho é 403.

**Desvio deliberado do texto do spec:** a CSP do estático da aba inclui `sandbox allow-scripts allow-forms`. O spec previa
o sandbox só no atributo do iframe. Sem ele na CSP, uma página de módulo aberta direto no navegador (fora do iframe) teria a
origem do second-brain e leria o `localStorage` onde a UI guarda a sessão humana. Com `sandbox` na CSP, a origem é opaca
também nesse caso.

### Tarefas agendadas

Uma ocorrência conta como atendida **assim que a execução começa**. Falha, timeout ou queda do processo não geram nova
tentativa automática, porque o second-brain não sabe se a ação externa já saiu. O resultado fica em Saúde e o dono usa "rodar
agora". Em troca, o módulo escreve tarefas **idempotentes por `ocorrencia`**.

### IA

`ctx.ia.completar` roda pelo `claude -p` da máquina, com a assinatura do dono (nenhuma chave de API é lida). Há orçamento
por chamada e um teto diário por módulo (`ia_max_usd_dia`). Os valores em US$ são estimativas do `claude`, usadas como freio
de consumo.

## Limites aceitos

- **Um laço síncrono infinito ou um `process.exit` no módulo derrubam o `serve`** (consequência de rodar no mesmo processo).
  O systemd reinicia, e Saúde mostra o módulo que estava em execução antes da queda.
- **Sem nova tentativa automática** de tarefa que falhou (ver acima).
- **Alterar `modules` na config exige reiniciar o `serve`.** Não há recarga a quente. Saúde avisa quando a config em disco
  difere da carregada.
- **Um `serve` por vault.** O `serve.lock` impede um segundo `serve` no mesmo vault. A liveness vem de `GET /api/serve`:
  um `serve.json` com pid vivo que não responde ali não conta como serve vivo.
- Sem marketplace, sem instalação remota, sem módulos em outras linguagens, sem comunicação entre módulos e sem janelas
  próprias no desktop.

## Consequências

- Um módulo defeituoso fica `falho` com a causa em Saúde, e os demais seguem. Erro em rota, tarefa ou ferramenta é
  capturado e registrado.
- O repositório público não contém nada de módulo privado. O único módulo versionado aqui é o exemplo `lembrete`
  (`examples/modules/lembrete`), usado também como teste de integração.
- O contrato muda por versão do SDK (`sdk: 1`): o second-brain recusa um módulo com `sdk` que ele não suporta.
