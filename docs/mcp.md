# MCP

Servidor **stdio** independente da GUI: `node packages/cli/dist/bin.js mcp` (variáveis: `BRAIN_VAULT`, `BRAIN_AGENT`). Cada cliente (Claude Code, Codex…) inicia o seu processo; a coordenação é por lock de arquivo + revision (ver arquitetura). Com a UI fechada nada muda. Stdout é exclusivo do protocolo; logs vão para stderr. SDK: `@modelcontextprotocol/server` 2.x (linha estável atual).

**Identidade do agente** = `clientInfo.name` do handshake MCP (normalizado: `codex*` → `codex`, `claude*` → `claude-code`), sobrescrevível por `--agent`/`BRAIN_AGENT`.

**`BRAIN_AGENT_NAME`** (opcional) fixa o nome do agente pelo ambiente de quem **inicia** o processo MCP e vence o `clientInfo.name` e o `--agent`/`BRAIN_AGENT`. É o que o motor do assistente usa: cada captura roda com `BRAIN_AGENT_NAME=assistant/<id da captura>` (perguntas, `assistant/ask`), e é por esse nome que o desfazer captura acha os commits dela (ADR 0014, "Credencial do desktop"). Aceita `^[a-z0-9/_-]{1,80}$`; fora disso vale `claude-code`, com aviso no stderr. Não configure no MCP do Claude Code: lá a identidade deve continuar vindo do cliente.

| Tool | Efeito | Observações |
|---|---|---|
| `brain_context {project?, topic?, task?, max_items?}` | leitura | pacote pequeno: visão do projeto, decisões/preferências **atuais**, resultados do tópico, perguntas em aberto; resumos ≤ 280 caracteres. `history` = conhecimento substituído que casou com o tópico ("X substituído por Y"), com resumo quando o tópico pede histórico; itens com `freshness` não foram confirmados como estado atual |
| `brain_search {query, project?, type?, tags?, since?, include_inactive?, limit?}` | leitura | híbrida FTS+semântica; snippets |
| `brain_get {id}` | leitura | nota completa + relações + histórico Git + semelhantes; aceita `prop-…` |
| `brain_recent {limit?, since?, project?}` | leitura | |
| `brain_projects {}` | leitura | |
| `brain_similar {title, body, project?, type?}` | leitura | classifica sem gravar |
| `brain_propose {title,type,body,…,intent?,target_id?,reason?}` | **cria proposta** | com `never` (padrão) não persiste; com `additive` pode gravar direto (retorno `auto`, ver abaixo); rejeita segredos/dumps; deduplica propostas idênticas |
| `brain_commit {proposal_id, resolution, …}` | persiste | **negado por padrão**; `agents.commit_policy`: `never` \| `new_only` \| `additive` \| `all`; o Core reclassifica antes de autorizar; sob `additive` o agente só decide as próprias propostas aditivas |
| `brain_link {from,to,type}` | escreve (aditivo) | `agents.can_link`; commit agrupado |
| `brain_supersede {old_id, …novo}` | cria proposta `replace` | antigo preservado como `superseded` após aprovação |
| `brain_health {}` | leitura | Git, índice, embeddings, problemas |

Erros voltam com `isError` e `{error, message}` (`secret_detected`, `too_large`, `forbidden`, `conflict_revision`, `not_found`…).

## Claude Code

```bash
claude mcp add --scope user second-brain --env BRAIN_VAULT=$HOME/second-brain \
  -- node /caminho/second-brain/packages/cli/dist/bin.js mcp
claude mcp list        # deve mostrar "Connected"
```
(`brain integrate --apply` faz isto, mais política e skill.) Escopo `project` gera `.mcp.json` versionável. Política: Claude Code lê `CLAUDE.md`; o bloco gerenciado em `~/.claude/CLAUDE.md` importa `@~/second-brain/AGENTS.md`. Skill: `~/.claude/skills/second-brain` (symlink).

## Codex

```bash
codex mcp add second-brain --env BRAIN_VAULT=$HOME/second-brain \
  -- node /caminho/second-brain/packages/cli/dist/bin.js mcp
```
ou em `~/.codex/config.toml`:
```toml
[mcp_servers.second-brain]
command = "node"
args = ["/caminho/second-brain/packages/cli/dist/bin.js", "mcp"]
startup_timeout_sec = 20
[mcp_servers.second-brain.env]
BRAIN_VAULT = "/home/voce/second-brain"
```
Política: Codex lê `~/.codex/AGENTS.md` (bloco gerenciado) e o `AGENTS.md` do repositório. Skill: `~/.agents/skills/second-brain`.

## ChatGPT / outras IAs

Mesmas ferramentas por MCP. Clientes remotos precisam de transporte HTTP (não incluído na V1 por exigir autenticação/exposição de rede — ver FUTURE.md); qualquer cliente MCP local por stdio já funciona.

## Permissões dos agentes (padrão) — aplicadas no CORE (ADR 0013)

A política vale igual para MCP, API e CLI: quem decide é a identidade (ator + canal) cunhada pelo adapter, nunca um argumento do cliente.

| Operação | Padrão |
|---|---|
| ler / buscar / contexto / recentes / projetos / saúde | **sim** |
| propor (`brain_propose`, `brain_supersede`) | **sim** (vira proposta; com `never` nada é gravado, com `additive` nota nova e complemento são gravados direto). `temporal` opcional para conhecimento que pode deixar de ser verdade |
| corrigir a PRÓPRIA proposta pendente (`brain_amend`) | **sim** (título, corpo, tags, `temporal`); a de outro agente/humano, não |
| persistir (`brain_commit`) | **não** — `agents.commit_policy: never` |
| atualizar / substituir nota existente | **não** (só humano). Complementar só com `additive` (ADR 0014) |
| relacionar (`brain_link`) | **não** com `commit_policy: never` (exige `can_link` **e** política ≠ never; `supersedes` nunca) |

`agents.per_type` (ADR 0011): com `new_only`, um agente só persiste conhecimento **new** com `create` se o tipo estiver em `auto`; com `additive`, tipo sem entrada vale `auto` e `review` manda para a fila. Lote, atualização, substituição, conflito, manutenção e `final_body` são sempre humanos. A política é relida do disco sob o lock a cada escrita.

### Política `additive` e o retorno `auto` (ADR 0014)

Com `agents.commit_policy: additive`, o `brain_propose` de um agente grava dentro da própria chamada, sem `brain_commit`. O retorno ganha `auto: { resolution, note_id?, commit? }` e o `next` diz "gravado direto (política additive)":

| Classificação | `auto.resolution` | Efeito |
|---|---|---|
| `new` | `create` | nota criada |
| `complement` | `complement` | seção datada anexada à nota existente |
| `duplicate` | `ignore` | nenhuma nota nova; decisão registrada em `proposals/decided/` |
| `update`, `replace`, `conflict` | (sem `auto`) | fica pendente na Review Queue |

Sem `auto` no retorno, a proposta está pendente (política `never`, tipo marcado `review` em `per_type`, ou classificação que exige humano). É assim que o agente descobre a política, sem ler config. O Core classifica sem confiar no `intent`/`target_id` do agente (eles só podem subir uma proposta para revisão), propostas de humano e do sistema continuam pendentes, e `final_body`, lote e config seguem só humanos. Desfazer uma captura é um `git revert`; o trailer `Brain-Decided-By: agent/<nome>` as identifica.

Se o usuário pedir a um agente para "aprovar", o agente prepara (propostas com evidência, títulos bons, temporal correto) e o humano decide na UI (sessão humana via `brain ui`) ou com `brain admin approve` num terminal.

Além disso: um corpo de nota com segredo (colado à mão) é devolvido **redigido** (`[REDACTED]`) a agentes em `brain_get`, e consultas com segredos são redigidas na atividade.
