# Módulos: extensões plugáveis do second-brain

Data: 2026-11-11 · Status: proposta (aguarda aprovação)

## 1. Intenção e porquê

O second-brain é público e genérico. O dono quer **crescer com coisas que só fazem sentido para ele** (rotinas da empresa,
integrações privadas) **sem que nada disso entre neste repositório**. A solução é um sistema de módulos: o SB oferece
pontos de extensão estáveis; cada módulo mora num repositório próprio (privado, quando for o caso) e é plugado por
configuração.

O primeiro consumidor real é um módulo privado de **rotina diária com aprovação humana**: toda manhã ele junta dados de
fontes externas, monta um rascunho, só chama o dono quando falta evidência e, depois do OK dele, executa uma ação externa.
O desenho deve servir esse caso inteiro, sem que o SB saiba nada sobre ele.

## 2. Objetivos

Um módulo pode:

1. ter uma **aba na UI** (página própria, servida pelo SB, no menu lateral, com contador de pendências);
2. expor **rotas HTTP** em `/api/modules/<id>/...`;
3. declarar **tarefas agendadas** que **recuperam** a execução perdida quando a máquina estava desligada;
4. guardar **estado próprio** (pasta exclusiva fora do vault) e ler **configuração própria** (validada por schema do módulo);
5. registrar **ferramentas MCP** (Claude Code, Codex) com prefixo do módulo;
6. usar o **motor de IA** do SB (`claude -p`) com orçamento e timeout;
7. **avisar o dono**: notificação nativa pelo app desktop + contador na UI e na bandeja; aviso não visto fica guardado;
8. **ler e propor conhecimento** pela fachada `Brain`, como um agente governado.

E o SB:

9. mostra cada módulo em **Saúde** / `brain doctor` (carregado, versão, última execução de cada tarefa, erros);
10. **isola falhas**: módulo que falha ao carregar ou numa tarefa é marcado como falho; o resto do SB segue;
11. traz um **módulo de exemplo** público que exercita todos os pontos acima e serve de teste de integração;
12. tem um **guia de autoria** (`docs/modules.md`) e um ADR.

## 3. Não-objetivos

- Marketplace, descoberta ou instalação remota de módulos.
- Isolamento de processo / sandbox do código do módulo no servidor (ver §5 e §6.11).
- Recarregar módulo sem reiniciar o `brain serve`.
- Módulos em outras linguagens.
- Comunicação entre módulos.
- Janelas próprias de módulo no app desktop (o desktop só mostra avisos e abre a UI).

## 4. Anti-objetivos (falha mesmo que funcione)

- **Qualquer código, teste, fixture ou doc deste repositório citar um módulo privado** ou dado de empresa. O SB nunca
  importa um módulo pelo nome; só lê a lista da configuração.
- **Módulo contornando a governança**: escrever nota direto, aprovar proposta, agir como humano.
- **Página de módulo conseguindo agir com a sessão humana** do revisor (aprovar propostas, editar notas).
- Segredos do módulo indo para o vault ou para a configuração versionada.
- A UI do SB precisar ser recompilada para um módulo aparecer.

## 5. Restrições

- Stack atual (ADR 0002): Node 24, TypeScript estrito, pnpm workspaces, zod, vitest. Sem dependência pesada nova.
- Toda escrita de conhecimento passa pela fachada `Brain` com um `Principal` (ADR 0013). `principal()` recusa identidade
  humana; módulo nunca é humano.
- O MCP roda como **processo stdio separado por cliente** (`brain mcp`), não dentro do `brain serve`. O agendador, as rotas
  e o estado do módulo vivem no `serve`.
- A credencial do desktop tem allowlist estrita antes do roteamento (`packages/api/src/index.ts`); rota nova nasce bloqueada.
- API só em `127.0.0.1`, checagem de `Host` e `Origin`, CSP no estático.
- O vault pode estar numa pasta sincronizada entre máquinas (`docs/vault-sincronizado.md`): **caminhos de máquina não podem
  depender do vault**.
- Confiança: módulos são código **instalado pelo dono** e rodam no processo do SB com o poder do Node. A proteção que o
  desenho dá é contra erro e contra conteúdo hostil na página (XSS), não contra um módulo malicioso. Isso fica escrito no ADR.

## 6. Abordagens consideradas

| | Como | Trade-off | |
|---|---|---|---|
| **A** | Módulo é pacote Node carregado **dentro do `brain serve`**; recebe um contexto restrito (`ctx`); a aba é página própria num iframe | Um processo, pouca infraestrutura, MCP e agendador quase de graça. Um módulo com bug pode travar o processo (mitigado por isolamento de erro) | **escolhida** |
| B | Módulo é **serviço separado** que se registra no SB por HTTP; SB faz proxy de aba e rotas | Isolamento total e qualquer linguagem, mas ~2× o trabalho (tokens por módulo, proxy de MCP, um serviço por módulo, agendador repetido). Não compensa para um dono com módulos próprios | descartada |
| C | UI do módulo **compilada junto** com `apps/web` | Amarra o build público ao código privado: fere o objetivo principal | descartada |

O dono escolheu A em 2026-11-11.

## 7. Desenho

### 7.1 Pacote `@brain/module-sdk`

Novo pacote em `packages/module-sdk`, **sem dependência de runtime** além de `zod` (peer). Exporta:

- `defineModule(def)` — função identidade tipada;
- os tipos do contrato (`ModuleDef`, `ModuleContext`, `Route`, `Task`, `McpTool`, ...);
- `SDK_VERSION` (inteiro, começa em `1`).

O módulo declara `sdk: 1`. O SB recusa carregar um módulo cujo `sdk` ele não suporta, com mensagem clara em Saúde.

**Schemas (decisão do autor do design):** o módulo mora em outro repositório e traz a própria cópia do zod. O SB **não usa
`instanceof`** nem depende da instância do módulo: trata todo schema pela interface **Standard Schema** (`~standard.validate`,
que o zod 4 implementa) e, onde precisa de JSON Schema (entrada MCP, `--json-schema` do `completar`), pede ao módulo a
conversão via `z.toJSONSchema` exportada junto (`schemaJson`) ou converte pela interface. O guia exige **zod 4** no módulo.

**Nome do ator:** `module/<id>` (barra, não dois-pontos), compatível com a regex de `BRAIN_AGENT_NAME`
(`packages/mcp/src/index.ts:45`). Usado igual em `ctx.brain` e em `ctx.ia` (ver §7.11), para auditoria e `amend` baterem.

Esboço do contrato (nomes finais ficam com o builder, a forma não):

```ts
defineModule({
  sdk: 1,
  id: "lembrete",               // [a-z][a-z0-9-]{1,30}; vira prefixo de rota, ferramenta, estado e ator
  nome: "Lembretes",
  versao: "0.1.0",
  configSchema: z.object({...}),// valida o bloco `config` do vault (§7.3)
  aba?: { titulo, icone?, pasta: "ui/dist" },   // pasta relativa à raiz do módulo, com index.html
  rotas?: [{ metodo, caminho: "/itens/:id", rodar: async (req, ctx) => json }],
  tarefas?: [{ id, quando: "30 8 * * 1-5", recuperar?: true, timeoutS?: 300, rodar: async (ctx) => void }],
  ferramentasMcp?: [{ nome, descricao, entrada: z.object({...}), rodar: async (args, ctx) => json }],
  iniciar?: async (ctx) => void,  // no serve, depois de validar a config
  parar?: async () => void,       // no desligamento
});
```

### 7.2 Onde o módulo está instalado (máquina) × o que ele faz (vault)

- **Vault** (`.brain/config.yaml`, nova chave `modules`): quais módulos estão ligados e a configuração de cada um.
  ```yaml
  modules:
    lembrete:
      enabled: true
      config: { horario: "10:00" }
  ```
- **Máquina**: o código do módulo fica em `$BRAIN_MODULES_DIR/<id>` (padrão `~/.local/share/second-brain/modules/<id>`),
  que pode ser um clone ou um symlink para o repositório do módulo. Opcionalmente `modules.<id>.path` no vault sobrescreve
  (aceita `~` e `$VAR`), para quem não sincroniza o vault.
- O módulo é carregado por `import()` do `package.json#exports` (ou `main`) da pasta, já compilado (JS). O SB não compila
  módulos.
- Módulo listado e ligado mas ausente na máquina: aviso em Saúde, não erro fatal.
- **Vault sincronizado em mais de uma máquina** (decisão do autor do design): só roda o módulo a máquina que o tem instalado.
  Se mais de uma tiver, `modules.<id>.host` (hostname) restringe **iniciar e tarefas** a essa máquina; nas outras o módulo
  aparece como "inativo nesta máquina". O estado de módulos fica **sempre** fora da pasta sincronizada: sem `state.external`,
  vai para `~/.local/state/second-brain/<slug do vault>/modules/` (mesma regra de slug de `state.ts`), nunca `.brain/modules/`.
  Assim não há `.gitignore` a atualizar em vaults existentes nem estado de máquina viajando pelo sync.
- **Schema da config:** `ConfigSchema` ganha `modules: z.record(z.string(), z.object({ enabled, path?, host?, ia_max_usd_dia?,
  config: z.unknown() }).passthrough())` para que salvar Configurações (`updateConfig` + `dumpConfig`) **preserve** os
  módulos. O core valida só a casca; o `config` de cada módulo é validado pelo carregador com o schema do módulo.

### 7.3 Configuração e segredos

- O bloco `config` passa pelo `configSchema` do módulo; erro de validação marca o módulo como falho com a mensagem do zod.
- O bloco passa também pelo **detector de segredos** do core; achado bloqueia o carregamento ("segredo na configuração do
  módulo X: use variável de ambiente ou o cofre do sistema").
- Segredos o módulo obtém por conta própria (ambiente, cofre). O SB não oferece API de segredos nesta versão.
- Mudança na config de módulos exige reiniciar o `serve`; Saúde avisa quando a config em disco difere da carregada.

### 7.4 Identidade e governança

- Novo canal `"module"` em `CHANNELS`. O ator de um módulo é `principal("agent", "module/<id>", "module")`.
- `ctx.brain` é uma fachada **restrita** que injeta esse ator: busca, contexto, leitura, `propose`, `similar`, `amend` das
  próprias propostas. Nada de `write`, `decide` (de propostas alheias), `assist` ou operações de revisor. As regras de
  `authz.ts` valem sem exceção; com `commit_policy: additive` o módulo tem o mesmo poder de um agente.
- Auditoria: as ações aparecem na `activity` e na Linha do tempo como `module/<id>`.

### 7.5 Estado

- `ctx.estado.dir`: pasta exclusiva `<stateDir>/modules/<id>/`, sempre fora da pasta do vault (ver §7.2). Nunca dentro de
  `knowledge/`.
- Helpers mínimos: `lerJson(nome)`, `gravarJson(nome, valor)` (escrita atômica tmp+rename), `lock(nome, fn)`.
- O SB não interpreta o conteúdo.

### 7.6 Rotas HTTP

- Montadas em `/api/modules/<id>/<caminho>`, mesma tabela/regex das rotas atuais, avaliadas **depois** das rotas do core.
- O handler recebe `{ metodo, params, query, body, chamador }`. **Nunca** recebe o `Principal` humano: tudo que o handler
  fizer no `Brain` sai como `module/<id>`.
- **Quem pode chamar e prova de humano** (decisão do autor do design; o primeiro consumidor só age fora depois do OK do dono):

  | Credencial | Rotas de módulo | `chamador` |
  |---|---|---|
  | Sessão humana da UI | todas | `{ via: "ui", humano: true }` |
  | Token da página do módulo (§7.7) — só emitido para sessão humana | só `/api/modules/<id>/*` do próprio módulo | `{ via: "pagina", humano: true }` |
  | api-token do vault (agentes, scripts, processo MCP) | **só** `/api/modules/<id>/_mcp/*` | `{ via: "mcp", humano: false }` |
  | Credencial do desktop | nenhuma | — |

  `chamador.humano` é a única prova de humano que o módulo deve usar. Rotas podem declarar `humano: true` e o SB recusa
  (`403`) quem não for humano antes de chamar o handler; o guia recomenda isso para toda rota que dispare ação externa.
  O `_mcp` **não** repassa nome de agente por cabeçalho (a API fixa o agente do api-token, `packages/api/src/index.ts:41-47`):
  `chamador` traz só `via: "mcp"`.
- Erro lançado vira `500 {error:"module_error"}` + registro em Saúde; módulo falho responde `503 {error:"module_unavailable"}`.
- Limites atuais valem (corpo ≤ 1 MB, `Host`/`Origin`).

### 7.7 Aba na UI

- `GET /api/modules` → `[{ id, nome, icone, aba: boolean, badge, status }]`. O menu lateral de `apps/web` lista os módulos
  com aba entre os itens do core e Configurações, com o contador (`badge`).
- Rota da UI `#/m/<id>/<resto>` renderiza `ModuleFrame`: `<iframe sandbox="allow-scripts allow-forms" src="/modules/<id>/#<resto>">`
  (**sem** `allow-same-origin`: a página não acessa a janela, o armazenamento nem a sessão do SB).
- Estático do módulo: `/modules/<id>/*` servido de `<raiz do módulo>/<aba.pasta>` com `safeResolve`, CSP
  `default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; frame-ancestors 'self'`.
  A CSP do SB ganha `frame-src 'self'`.
- **Credencial da página**: a UI (com sessão humana) pede `POST /api/modules/<id>/ui-token` e recebe um token **curto**
  (memória do processo, 12 h, renovável pela UI) que só vale para `/api/modules/<id>/*` — checado antes do roteamento, como
  a allowlist do desktop.
- **CORS da origem opaca:** o iframe tem origem `null`, então o `fetch` com `Authorization` é cross-origin. Hoje
  `new URL("null")` lança e vira 500 (`packages/api/src/index.ts:231`): a checagem de `Origin` passa a tratar `null`
  explicitamente. Regras:
  - `Origin: null` só é aceito em `/api/modules/<id>/*` (exceto `ui-token` e `_mcp`) e em `/modules/<id>/*` (estático);
    em qualquer outro caminho, `403`;
  - a API responde ao preflight `OPTIONS` nesses prefixos (sem exigir token, sem executar nada) com
    `Access-Control-Allow-Origin: null`, `Allow-Headers: authorization, content-type`, `Allow-Methods` das rotas;
  - respostas desses prefixos levam `Access-Control-Allow-Origin: null` e `Vary: Origin`; o estático também, porque os
    scripts `type="module"` do Vite exigem CORS;
  - como `null` vale para qualquer origem opaca, a segurança vem do token de página (curto, por módulo, só emitido a sessão
    humana), não da origem. Fica escrito no ADR.
- Ponte `postMessage` (origem verificada dos dois lados, mensagens com schema):
  - página → SB: `brain:pronto {nonce}` (o nonce nasce com a montagem e vai só no fragmento do `src`, `#n=<nonce>&r=<resto>`), `brain:renovar {nonce}`, `brain:navegar {resto}` (atualiza o hash do SB), `brain:abrirNota {id}`, `brain:badge {n}` (opcional, só visual);
  - SB → página: `brain:init { token, expira, apiBase, tema: "claro"|"escuro", resto }`, `brain:token { token, expira }` (só como resposta a `brain:renovar { nonce }` da página; o SB nunca empurra token), `brain:tema`.
- `GET /modules/_sdk/base.css`: tokens de cor/tipografia do SB (claro/escuro) para as páginas de módulo ficarem coerentes.
  O SDK traz um helper JS mínimo opcional (`brain-module-client.js`) que faz o handshake e o `fetch` com o token.

### 7.8 Tarefas agendadas

- Agendador só no `brain serve`. Expressão cron de 5 campos, **hora local da máquina**. Parser próprio pequeno ou dependência
  leve sem transitivas (escolha do builder).
- Por tarefa o SB guarda em `<stateDir>/modules/_scheduler.json`: última execução prevista atendida, início, fim, resultado,
  erro.
- `recuperar: true`: ao subir (e ao acordar de suspensão, detectado por salto de relógio), se houve ocorrência prevista desde
  a última atendida, roda **uma vez** (não uma por ocorrência perdida). `ctx` informa `ocorrencia` (data/hora prevista) para o
  módulo saber "a qual dia" se refere.
- **Semântica de "atendida"** (decisão do autor do design):
  - uma ocorrência conta como atendida **assim que a execução começa** (marcador gravado antes de chamar `rodar`). Falha,
    timeout ou queda do processo **não** geram nova tentativa automática: o resultado fica em Saúde e o dono usa "rodar
    agora". Motivo: o SB não sabe se a ação externa já saiu; repetir sozinho é o erro pior;
  - na primeira subida sem histórico, nenhuma recuperação: só as próximas ocorrências contam;
  - o guia exige que tarefas sejam **idempotentes por ocorrência** (o módulo grava em `ctx.estado` o que já fez para a
    `ocorrencia` e pula o que já saiu). Rodar agora passa a mesma `ocorrencia` da última atendida ou, se o dono pedir, uma
    data explícita.
- Sem sobreposição: uma tarefa não começa se a anterior ainda roda. Timeout (`timeoutS`, padrão 300) cancela via
  `AbortSignal` em `ctx.sinal` e marca erro.
- Disparo manual: `POST /api/modules/<id>/_tarefas/<tarefa>/rodar`, **só sessão humana** (a tarefa pode causar ação externa).
  `brain modules run <id> <tarefa>` exige terminal interativo e prova de humano (`requireHuman`, com frase-senha quando
  `review.passphrase_required`), emite uma sessão humana curta (`issueHumanSession`, como o `brain serve` já faz), chama o
  `serve` por HTTP e revoga a sessão ao terminar. A tarefa roda no `serve`, nunca no processo da CLI. Sem TTY: recusa.

### 7.9 Avisos (`notify`) e contador (`badge`)

- `ctx.avisar({ titulo, corpo?, link?, chave? })`: grava em `<stateDir>/modules/_avisos.jsonl`. `link` é o `resto` da aba
  (`#/m/<id>/<link>`). `chave` deduplica: novo aviso com a mesma chave substitui o anterior não visto.
- `ctx.badge(n)`: número de pendências do módulo (estado, não evento). Aparece no menu da UI, em `GET /api/modules` e no
  ícone da bandeja (soma).
- API: `GET /api/notifications?depois=<cursor>` → `{ avisos: [...], cursor, badges: { <id>: n }, total }` e
  `POST /api/notifications/<id>/visto`. A soma da bandeja vem daí (`total`), sem abrir `/api/modules` para o desktop.
  **A allowlist do desktop ganha só essas duas rotas** (e continua com assistant e health).
- Desktop: consulta a cada 60 s (e ao abrir); mostra notificação nativa com `titulo`/`corpo`; clique abre
  `${BASE}/#/m/<id>/<link>` com `shell.openExternal` (como já faz com notas) e marca visto. Avisos acumulados enquanto o
  desktop estava fechado aparecem ao abrir (no máximo os 5 mais recentes como notificação; o resto só no contador).
- SSE: a UI recebe `module.badge` e `module.notification` pelo canal de eventos existente.

### 7.10 Ferramentas MCP

- Nome registrado: `<id>_<nome>` (ex.: `lembrete_listar`). Conflito de nome recusa a ferramenta do módulo, nunca a do core.
- O processo `brain mcp` lê a lista de módulos e **importa só as definições** (não chama `iniciar`) para registrar as
  ferramentas. A **execução acontece no `serve`**: o MCP chama `POST /api/modules/<id>/_mcp/<nome>` com o api-token do
  vault (sem cabeçalho de autoria; ver §7.6); o `serve` valida a entrada com o schema e roda o handler com
  `chamador = { via: "mcp", humano: false }`. Assim o estado do módulo tem um único dono.
- **Endereço do `serve`:** o `serve` grava `<stateDir>/serve.json` (`{ url, pid, iniciado }`) ao subir e apaga ao sair; o MCP
  e a CLI leem esse arquivo, com `BRAIN_PORT`/3737 como fallback. O `brain doctor` usa o mesmo arquivo para buscar o estado
  vivo dos módulos (`GET /api/modules` com o api-token, rota de leitura liberada a ele) e, sem `serve`, mostra o que estiver
  em disco (`_scheduler.json`, `_erros.jsonl`).
- `serve` fora do ar: a ferramenta responde erro claro ("o brain serve não está rodando; a ferramenta X precisa dele").

### 7.11 Motor de IA

- Nova operação genérica no motor: `completar({ prompt, schema?, modelo?, orcamentoUsd?, timeoutS?, comNotas?: boolean })`.
  - Sem `comNotas`: `claude -p` **sem nenhuma ferramenta** (`--tools ""`, `--strict-mcp-config` sem MCP), saída JSON com
    `--json-schema` quando houver `schema`.
  - Com `comNotas: true`: mesmo MCP do vault com **as ferramentas de leitura** (as do modo pergunta), com
    `BRAIN_AGENT_NAME=module/<id>`. O processo MCP aceita um canal declarado por variável **só** para o valor `module` e
    só junto de um nome `module/<id>` (o motor é quem inicia esse processo); assim auditoria e `amend` batem com `ctx.brain`.
- `ctx.ia.completar(...)` usa padrões de `assistant` do vault; orçamento por chamada limitado a `assistant.max_budget_usd`
  e um teto diário por módulo (`modules.<id>.ia_max_usd_dia`, padrão 2). O motor passa a extrair `total_cost_usd` da saída
  JSON do `claude` (hoje não extrai) e soma por módulo/dia em `<stateDir>/modules/_ia.json`; sem o campo, conta o orçamento
  máximo da chamada (conservador). Gasto mostrado em Saúde.
- Erros seguem `AssistantError` (`auth`, `timeout`, `orcamento`, `erro`).
- **Autenticação do Claude:** a mesma do assistente hoje — o login do `claude` da máquina (assinatura, via
  `claude setup-token`). Nenhuma chave de API da Anthropic é necessária nem lida. Na assinatura, os valores em US$
  (`--max-budget-usd`, `total_cost_usd`) são **estimativas** do `claude`; aqui servem como freio de consumo da cota, não
  como cobrança.
- **Terminologia:** neste documento, "api-token" é sempre o token **local do second-brain** (`<stateDir>/api-token`), usado
  por processos da máquina para falar com o `serve`. Não tem relação com a Anthropic.

### 7.12 Ciclo de vida e isolamento de falhas

- `serve` sobe: carrega config → para cada módulo ligado: resolve pasta → `import()` → valida `sdk`, `id` (igual à chave do
  vault), config, segredos → `iniciar(ctx)` com timeout (30 s) → registra rotas, aba, tarefas.
- Qualquer falha nesses passos: módulo `falho` com causa; os demais seguem.
- Erro em rota/tarefa/ferramenta: capturado, registrado (últimos 50 por módulo em `_erros.jsonl`), módulo continua ativo.
  Cinco erros seguidos de tarefa: tarefa suspensa até reinício ou disparo manual.
- Limite documentado: laço infinito síncrono ou `process.exit` no módulo derruba o `serve` (consequência da abordagem A); o
  systemd reinicia, e Saúde mostra o último módulo em execução antes da queda (marcador gravado antes de cada execução).
- `parar()` no desligamento, com timeout de 5 s.

### 7.13 Saúde, doctor e CLI

- Saúde (UI) e `brain doctor`: seção Módulos com status, versão, `sdk`, pasta, tarefas (próxima/última execução e
  resultado), erros recentes, gasto de IA do dia.
- CLI: `brain modules list`, `brain modules run <id> <tarefa>`, `brain modules check <pasta>` (valida um módulo sem ligá-lo:
  contrato, `sdk`, schema, aba existe).

### 7.14 Módulo de exemplo e testes

- `examples/modules/lembrete`: aba (lista de lembretes + botão "feito"), rota, tarefa diária com `recuperar`, ferramenta MCP
  `lembrete_listar`, `avisar` + `badge`, uso opcional de `ia.completar` (desligado nos testes por motor falso).
- Testes (vitest):
  - carregador: módulo ok, `sdk` incompatível, id divergente, config inválida, segredo na config, pasta ausente, `iniciar` que lança/estoura tempo;
  - fachada restrita: módulo não consegue `write`/`decide`/`assist`; ator `module/<id>` na `activity`, igual via `ctx.ia`;
  - matriz de credenciais do §7.6: api-token só entra em `_mcp`; rota `humano: true` recusa api-token; `chamador.humano` correto;
  - CORS: preflight `OPTIONS` nos prefixos de módulo, `Origin: null` recusado fora deles, `new URL("null")` não vira 500;
  - config: salvar Configurações preserva `modules`; `host` diferente da máquina deixa o módulo inativo;
  - agendador com relógio falso: cron, recuperação única, salto de relógio, sem sobreposição, timeout, suspensão após 5 erros;
  - API: token de página só vale no próprio prefixo; `Origin: null` recusado fora dele e sem esse token; allowlist do desktop
    aceita só `notifications` além do que já aceitava; módulo falho → 503;
  - avisos: deduplicação por `chave`, cursor, visto;
  - MCP: registro com prefixo, conflito, execução via `serve`, `serve` fora do ar;
  - integração ponta a ponta com o módulo de exemplo (sobe `serve`, chama rota, roda tarefa, recebe aviso).
- A UI do `ModuleFrame` e a ponte `postMessage` ganham teste de unidade das mensagens (schema e verificação de origem).

### 7.15 Documentação

- `docs/decisions/0015-modulos.md`: decisão A, modelo de confiança, limites.
- `docs/modules.md`: guia de autoria (estrutura, contrato, ciclo de vida, aba e ponte, tarefas, avisos, IA, MCP, testes,
  como instalar em `$BRAIN_MODULES_DIR`).
- `docs/architecture.md` e `README.md`: menção curta e link.
- `docs/FUTURE.md`: retirar o que este trabalho entrega; registrar o que ficou de fora (§3).

## 8. Decidido com o dono

- Abordagem A (módulo dentro do processo, aba em iframe).
- Lista de capacidades do §2.
- Avisos: notificação nativa pelo desktop + contador; resposta sempre na aba (sem resposta dentro da notificação); aviso não
  visto fica guardado.
- Integrações específicas de empresa (ex.: mensageria corporativa) ficam nos módulos, nunca no core.
- Este repositório não contém nada de módulo privado (§4).

## 9. Decisões do autor do design (após revisão)

Tomadas sem consultar o dono por serem técnicas; ele pode revertê-las na leitura:

1. Matriz credencial → rota e `chamador.humano` como única prova de humano; rotas `humano: true` (§7.6).
2. Ocorrência atendida ao começar, sem nova tentativa automática; sem recuperação na primeira subida; tarefas idempotentes (§7.8).
3. `brain modules run` com prova de humano no terminal e sessão curta (§7.8).
4. Estado de módulo sempre fora da pasta do vault; `modules.<id>.host` para vault em várias máquinas (§7.2).
5. Standard Schema em vez de `instanceof`; zod 4 obrigatório no módulo (§7.1).
6. Ator `module/<id>`; canal `module` aceito no MCP só nesse caso (§7.1, §7.11).
7. CORS explícito para origem `null`, restrito aos prefixos de módulo (§7.7).
8. `serve.json` para descoberta do endereço do `serve` (§7.10).

## 10. Fica com o builder

- Nomes finais de tipos e funções (a forma do contrato do §7.1 é fixa).
- Parser cron próprio ou dependência leve.
- Distribuição do `@brain/module-sdk` para repositórios de fora (sugestão: dependência git com subcaminho, ou `file:` para
  um clone local; o SDK não tem runtime relevante, então copiar os tipos também é aceitável).
- Visual da aba de módulo no menu e da seção Módulos em Saúde, seguindo o estilo atual.
- Ordem das tarefas no plano.
