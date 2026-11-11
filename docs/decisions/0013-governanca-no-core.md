# ADR 0013 — Governança aplicada no Core: identidade = ator + canal

**Status:** aceito (2026-10-14)

## Contexto

Na rodada de 2026-10-14, um agente aprovou 90 propostas pela API local. O caminho foi legítimo para o código da época, mas revelou dois defeitos:

1. **A API tratava toda requisição com o `.brain/api-token` como humana.** O token é um arquivo do vault, legível por qualquer processo local (agentes rodam com o mesmo usuário do SO).
2. **O Core só aplicava a política de agentes quando o adapter passava `via="agent"`.** Quem decidia se a política valia era o adapter.

A política desejada é simples: agentes **leem, buscam, pedem contexto e propõem**, e decidir é do humano.

## Decisão

- **Toda operação mutativa do Core chama `authorize(quem, operação, contexto)`** (`packages/core/src/authz.ts`):
  - **Operações:** `propose`, `amend`, `decide`, `write`, `link`, `verify`, `assist`, `admin`.
  - **Negado por padrão:** chamada sem identidade ou com objeto literal vindo de JSON/HTTP.
- **Identidade = ator + canal, cunhada pelo adapter, nunca informada pelo cliente.**
  - `principal()` cria apenas agentes e sistema.
  - O humano só nasce de uma **sessão humana válida** (`humanFromSession`) ou de um **terminal real** (`humanFromTerminal`: stdin e stdout TTY, mais a frase-senha do revisor quando definida).
- **Canais humanos de revisão:** `ui` (sessão humana) e `cli-admin` (`brain admin …` num terminal, com confirmação digitada).
- **Sessões humanas da UI:**
  - São emitidas por `brain ui` ou `brain serve` num terminal.
  - Ficam guardadas **fora do vault**, só como hash (sha256), com validade de 30 dias e revogáveis.
  - O `api-token` do vault passou a identificar um **agente** (`api-client`).
  - O SSE usa ticket curto e de uso único, nunca a sessão na URL.
- **Matriz padrão:**

  | Operação | Agente (MCP, API, CLI comum) | Revisor humano (UI/`brain admin`) | Sistema |
  |---|---|---|---|
  | ler / buscar / contexto | sim | sim | sim |
  | propor / substituir como **proposta** | sim | sim | importador e manutenção |
  | corrigir a **própria** proposta (`brain_amend`) | sim | sim (qualquer uma) | — |
  | decidir (aprovar, ignorar, complementar, atualizar, substituir) | não¹ | sim | não |
  | aprovar em lote | não | sim | não |
  | escrever nota direto / relação / config / commit manual / revert | não² | sim | — |
  | anexar verificação de atualidade | não | sim | importador e manutenção |
  | assistente (`assist`: capturar, perguntar, reprocessar, desfazer captura) | não | sim | não |
  | **`desktop`** (credencial do atalho: humano no canal `desktop`) | — | só ler, propor e `assist`; desfaz só capturas feitas pelo desktop; nada além disso³ | — |

  ³ O canal `desktop` só nasce de uma sessão com escopo `desktop` (`brain pair-desktop`); `principal()` o recusa. Não é canal de revisão: não decide, não aprova em lote, não escreve direto, não cria relação, não reverte e não muda config. Detalhes no ADR 0014, seção "Credencial do desktop".

  ¹ A política opcional por tipo (ADR 0011) continua existindo e desligada (`commit_policy: never`). Mesmo ligada, só cobre conhecimento **new** com `create`. Atualização, substituição, conflito, manutenção, `final_body` e lote são sempre humanos, em **todos** os adapters. O ADR 0014 amplia esta nota com a política `additive`, que cobre também `complement` e `duplicate`.

  ² Relação de agente exige `can_link` **e** `commit_policy ≠ never`. `supersedes` nunca é aceito de agente (use `brain_supersede`).

- **Frase-senha do revisor (opcional, recomendada):**
  - Comando: `brain admin passphrase`.
  - Grava `review.passphrase_required: true` no vault, que é versionado.
  - A partir daí, `brain ui` e `brain admin` exigem a frase-senha.
  - Se o arquivo do revisor não for encontrado (HOME ou armazenamento trocado), a ação é **negada**.
- **Auditoria:** commits de decisão levam o trailer `Brain-Channel`; a atividade registra o canal.

## Modelo de ameaça (honesto)

Protege os **caminhos suportados** contra:
- agentes bem-comportados;
- pedidos ambíguos ("aprove tudo");
- erros de integração (um adapter repassar `{kind:"human"}` do cliente);
- uso rotineiro de ferramentas sem terminal.

**Não** protege contra um processo do mesmo usuário do SO que decida contornar deliberadamente. Esse processo pode:
- editar o Markdown e dar `git commit` direto no vault;
- carregar a biblioteca no próprio processo;
- alocar um pty (`script`).

Sem frase-senha, a prova de humano é só o terminal. O `brain doctor` avisa, e com a frase-senha a barreira passa a ser um segredo que o agente não conhece. Isolamento real exigiria rodar os agentes com outro usuário do SO: fica para o futuro, registrado em FUTURE.

## Consequências

- A UI aberta com o `api-token` fica em modo leitura e proposta, com aviso. Para revisar, rode `brain ui` num terminal.
- Pedir "aprove tudo" a um agente deixa de funcionar. O agente prepara a fila com sugestões e evidências, e o humano decide em lote (UI) ou com `brain admin approve --eligible`.
- `brain update-policy`, `brain integrate --apply/--remove` e `brain admin commit` passaram a exigir terminal.
- Testes de bypass por adapter: `packages/cli/test/governance.test.ts`.
