# ADR 0014 — Captura aditiva: o agente grava direto o que só acrescenta

**Status:** aceito (2026-11-10)

## Contexto

Pelos ADRs 0005, 0011 e 0013, agentes leem, buscam e **propõem**, e um humano decide tudo. A política opcional por tipo
(`agents.commit_policy` + `agents.per_type`) existia, mas desligada (`never`) e, mesmo ligada, só cobria `new` com `create`
(nota ¹ do ADR 0013).

No uso pessoal diário, isso inflou a fila. A maior parte do que os agentes propõem é nota nova ou complemento de uma nota
existente, e quase tudo era aprovado sem mudança. O custo de revisar tudo fez a fila crescer sem que a revisão protegesse
alguma coisa. Uma fila grande também esconde as poucas propostas que de fato precisam de um humano: atualizações,
substituições e contradições.

## Decisão

Um novo valor de `agents.commit_policy`: **`additive`**. O enum passa a ser `never | new_only | additive | all`. O padrão
do repositório continua `never`.

| Classificação (do Core) | Com `additive`, quando o autor é um agente |
|---|---|
| `new` | o agente cria direto (`create`) |
| `complement` | o agente anexa direto, como seção datada com origem (`complement`, o comportamento de sempre) |
| `duplicate` | é registrado como ignorado (`ignore`), sem nota nova; a decisão fica em `proposals/decided/` |
| `update`, `replace`, `conflict` | vai para a Review Queue (humano) |

### Como funciona

- **A gravação acontece dentro do próprio `propose`** (`brain_propose` no MCP), no mesmo lock. O agente não precisa chamar
  `brain_commit` depois. Se precisasse, o agente que esquecesse deixaria pendência, e a fila voltaria a crescer. O retorno
  traz `auto: { resolution, note_id?, commit? }`, e o `next` do MCP diz "gravado direto (política additive)".
- **Mesma porta de escrita.** A decisão automática passa pelo mesmo caminho do `resolve` (`resolveLocked`). Isso inclui:
  - `authorize(agente, "decide", …)`, que permite ou nega;
  - a checagem de revisão do alvo;
  - o JSON em `proposals/decided/`, com `decided.by` igual ao agente;
  - os mesmos trailers de commit (`Brain-Proposal`, `Brain-Proposed-By`, `Brain-Decided-By: agent/<nome>`,
    `Brain-Channel`, `Brain-Resolution`).

  Desfazer uma captura é um `git revert` do commit, e encontrar as capturas de um agente é procurar o trailer
  `Brain-Decided-By`.
- **A classificação é do Core, não do agente.** Sob `additive`, o `intent` e o `target_id` do agente só podem *subir* uma
  proposta para revisão, nunca *descer* (`classify(…, { trustHint: false })`):
  - Um "complemento" declarado que traga valor divergente (número ou versão) vira `update`. Se trouxer negação invertida,
    vira `conflict`. Os dois vão para a fila.
  - Um alvo declarado que não tem relação com o rascunho também não esconde o valor divergente da nota que a heurística
    escolheria sozinha.
  - Complemento sobre um alvo declarado só vale se o alvo for um candidato relevante (similaridade ≥
    `candidate_threshold`) ou o mesmo que a heurística escolheria sozinha. Senão vale a classificação independente
    (tipicamente `new`, uma nota nova), e o rascunho nunca é anexado a uma nota arbitrária.
- **`per_type`:** sob `additive`, um tipo sem entrada vale `auto`. Um tipo marcado explicitamente como `review` continua
  indo para a fila, e serve de válvula para tipos sensíveis (por exemplo, `decision`). No complemento, vale também o tipo da
  nota **alterada**: complementar uma `decision` marcada `review` vai para a fila, seja qual for o tipo declarado no rascunho.
  O agente só complementa o alvo que o Core analisou.
- **Humano propondo não é auto-aplicado.** A proposta de um humano fica pendente como sempre, e ele decide pela fila.
  Propostas do sistema (importador, manutenção) também ficam pendentes.
- **O agente só decide as próprias propostas.** Sob `additive`, um `brain_commit` de agente sobre proposta de humano, do
  sistema ou de outro agente é negado: essas decisões da fila são do revisor.
- **`brain_commit` de agente é reclassificado.** Antes de autorizar, o Core refaz a classificação sem confiança na dica, e é
  essa a classificação que vale para a autorização. A análise gravada pode ser de quando o vault confiava na dica (por
  exemplo, sob `never`, um `intent: complement` mascarava um valor divergente). Se a reclassificação der `update` ou
  `conflict`, a decisão é negada. A proposta e a revisão do alvo registrada ficam intactas.

### Por que `complement` é seguro

O complemento só acrescenta: o corpo existente fica intacto e o texto novo entra numa seção datada com a origem. Nada é
sobrescrito, o Git guarda a versão anterior, e um `git revert` desfaz a captura inteira. O que poderia apagar ou alterar
conhecimento existente não passa por essa porta: valor divergente vira `update`, e contradição vira `conflict`.

## Credencial do desktop

O atalho desktop (Windows) anota e pergunta pela API local com uma credencial própria, mais fraca que a sessão do revisor.

- **Canal `desktop`.** É humano, mas não é canal de revisão (fica fora de `HUMAN_CHANNELS`). Só nasce de uma sessão com
  escopo `desktop`, emitida por `brain pair-desktop` num terminal interativo (`humanFromSession` devolve o canal
  `desktop` para essa sessão). `principal()` recusa o canal `desktop` para qualquer tipo de ator.
- **Operação `assist`.** Capturar, perguntar, reprocessar pendentes e desfazer captura. `authorize(…, "assist")` aceita
  o revisor (`ui`, `cli-admin`) e o canal `desktop`; agente e sistema recebem `forbidden`. Fora disso, o canal `desktop`
  só lê e propõe: não decide, não aprova em lote, não escreve direto, não cria relação, não reverte e não muda config.
- **Allowlist da API.** Com essa credencial, a API só aceita `/api/assistant/*` e `GET /api/health`. A checagem roda
  **antes** do roteamento, então uma rota nova fora do prefixo já nasce bloqueada (403). Uma rota nova **sob** o prefixo
  passa pela allowlist e precisa do próprio `authorize` (como `assistantFor` faz) ou de uma checagem explícita de canal.
- **Desfazer captura.** O humano do desktop só desfaz capturas feitas pelo desktop (origem `desktop`); o revisor desfaz
  qualquer uma; agente nunca. Os commits da captura saem de um só `git log`, pelo autor (`%an` exatamente
  `assistant/<id>`, o nome que o `commit()` grava para o agente cunhado) **e** pelo primeiro trailer do bloco final:
  `Brain-Decided-By: agent/assistant/<id>` nas decisões automáticas e `Brain-Actor: agent/assistant/<id>` nas relações
  criadas com `brain_link`. Texto livre (título, nota da decisão, assunto do link, nome do ator) entra no commit em uma
  linha só (`oneLine`), então não forja trailer. Tudo é revertido do mais novo para o mais antigo, como uma operação: se
  uma nota mudou depois, o revert inteiro é abortado e a captura continua como estava.
- **`BRAIN_AGENT_NAME`.** O motor do assistente inicia o MCP filho com `BRAIN_AGENT_NAME=assistant/<id da captura>` (e
  `assistant/ask` nas perguntas). O nome vem do ambiente de quem inicia o processo, nunca de argumento de ferramenta, e
  vence o `clientInfo.name` e o `--agent`/`BRAIN_AGENT`. Nome fora de `^[a-z0-9/_-]{1,80}$` vira `claude-code`, com aviso.
- **Validade e cota.** A sessão `desktop` vale 30 dias e fica fora do vault, só como hash, como as sessões da UI. Cada vault
  tem no máximo 2 sessões `desktop` vivas (emitir uma terceira despeja a mais antiga), e elas não contam no limite de 10
  sessões `full`: abrir a UI muitas vezes não derruba o desktop.
- **Renovação.** `POST /api/assistant/session/renew` só aceita o canal `desktop` (`ui` e agente recebem 403) e devolve
  `{ token }`. No core, `renewDesktopSession` exige uma sessão `desktop` viva, emite outro token com o mesmo escopo e
  validade nova de 30 dias e revoga o antigo. Não aceita sessão `full` e não promove escopo. O desktop guarda a data de
  emissão junto do token (cifrado pelo Windows) e, na subida e uma vez por dia, renova quando a credencial tem mais de 7
  dias. Recusada (401/403), mostra a mensagem de pareamento; offline, tenta de novo depois.

## O que continua só humano

- `update`, `replace` e `conflict`;
- `final_body` (corpo escrito à mão na decisão);
- `keep_separate` e qualquer resolução fora da tabela acima;
- propostas de manutenção (revalidação e título);
- aprovação em lote (`approveMany`) e ignorar em lote (`ignoreMany`);
- revert de commit, config (`updateConfig`) e commit de edições manuais;
- as decisões da fila: tudo que ficou pendente.

## Relação com o ADR 0013

Este ADR muda de propósito a nota ¹ do ADR 0013, que diz que a política opcional "só cobre conhecimento **new** com
`create`". Com `additive`, ela passa a cobrir também `complement → complement` e `duplicate → ignore`. O resto do ADR 0013
continua valendo:

- identidade = ator + canal, cunhada pelo adapter;
- `authorize` no Core para todo adapter;
- canais humanos de revisão;
- as regras duras do ADR 0011.

A decisão automática é uma decisão de **agente**, autorizada e auditada como qualquer outra, e não um atalho que pula a
autorização.

## Consequências

- Um vault com `commit_policy: additive` não precisa de revisão para o fluxo comum de captura, e a fila fica com o que pede
  julgamento humano.
- A qualidade passa a ser filtrada na gravação, pelo texto da política no `AGENTS.md` e na skill, e validada depois, de forma
  passiva (visão "Entrou recentemente", com Desfazer).
- O risco aceito é uma nota nova ou um complemento ruim entrar sem revisão. O custo de desfazer é um `git revert`, e o
  trailer `Brain-Decided-By: agent/…` torna essas capturas fáceis de encontrar.
- Sob `additive`, relações de agente (`brain_link`) seguem a regra do ADR 0013 (`can_link` e `commit_policy ≠ never`):
  ficam permitidas, como já ficavam com `new_only` e `all`.
