# Second Brain

Camada de **memória compartilhada entre humanos e agentes de IA** (Claude Code, Codex, ChatGPT/outros via MCP). Local-first, neutra de fornecedor.

- **Fonte de verdade:** Markdown versionado em Git (abre direto no Obsidian). SQLite/embeddings são índices derivados e reconstruíveis.
- **Governança antes de persistência:** agentes *propõem*; o sistema procura semelhantes, classifica (nova · duplicata · complemento · atualização · substituição · conflito) e um humano decide na **Review Queue**. Nada é sobrescrito em silêncio; substituir preserva o histórico.
- **Uma só memória para todos:** Claude Code e Codex usam o mesmo servidor MCP (stdio), com a UI fechada ou aberta.
- **Segredos nunca entram:** filtro de segredos/dumps/código gigante antes de qualquer gravação.

> Princípios: **Core first · API first · Web first · Desktop optional.** Detalhes em [`docs/architecture.md`](docs/architecture.md).

## Início rápido

Requisitos: Node ≥ 22.5 (testado em 24), pnpm, Git. (WSL Ubuntu 24.04 no ambiente de referência.)

```bash
pnpm install
pnpm build

node packages/cli/dist/bin.js init            # cria o vault em ~/second-brain (repositório Git próprio)
node packages/cli/dist/bin.js integrate       # mostra os comandos para Claude Code + Codex (--apply executa)
./scripts/start.sh                            # API + UI em http://127.0.0.1:3737  (ou: brain ui para a URL com token)
```

Atalho: `alias brain='node /caminho/second-brain/packages/cli/dist/bin.js'`. Quer ver sem dados reais? `brain seed /tmp/demo && brain serve --vault /tmp/demo` (dados **fictícios**, vault descartável).

## Alimentar a base (bootstrap)

```bash
brain import ~/projetos/meu-repo --project meu-repo --dry-run   # prévia: candidatos + classificação (nada é gravado)
brain import ~/projetos/meu-repo --project meu-repo --max 12    # cria PROPOSTAS na Review Queue
```
Ou na UI: **Importar** (colar texto ou apontar uma pasta). Extrai decisões, restrições, aprendizados, padrões, referências e perguntas em aberto — não copia documentos — e passa tudo pela governança. Em repositórios git, cada candidato é **verificado contra o HEAD** (ainda é verdade? foi substituído, revertido, só planejado?) e chega à revisão com evidência e uma sugestão de um clique. Detalhes: [`docs/import.md`](docs/import.md) e [`docs/knowledge-freshness.md`](docs/knowledge-freshness.md).

## Conectar o Claude Code

```bash
claude mcp add --scope user second-brain --env BRAIN_VAULT=$HOME/second-brain \
  -- node /caminho/second-brain/packages/cli/dist/bin.js mcp
claude mcp list     # second-brain: Connected
```
`brain integrate --apply` (dry-run por padrão; faz backup em `~/.config/second-brain/backups/`; `--remove` desfaz) também adiciona a política (`@AGENTS.md` em `~/.claude/CLAUDE.md`, em bloco gerenciado) e a skill (`~/.claude/skills/second-brain`). Tools aparecem como `mcp__second-brain__brain_*`.

## Conectar o Codex

```bash
codex mcp add second-brain --env BRAIN_VAULT=$HOME/second-brain \
  -- node /caminho/second-brain/packages/cli/dist/bin.js mcp
```
Política em `~/.codex/AGENTS.md` (bloco gerenciado) e skill em `~/.agents/skills/second-brain`. Detalhes e TOML equivalente: [`docs/mcp.md`](docs/mcp.md).

## Abrir no Obsidian

"Open folder as vault" → `~/second-brain`. No Windows, com o vault no WSL: `\\wsl.localhost\Ubuntu-24.04\home\<voce>\second-brain` (ou Obsidian Linux via WSLg). Edite à vontade: mudanças são reindexadas em segundos (watcher + varredura); para versionar, use *Configurações → Commitar edições manuais* (commit agrupado). Ver [`docs/windows-wsl.md`](docs/windows-wsl.md).

## Windows + WSL

Core/API/MCP/Git/SQLite no WSL; navegador do Windows acessa `http://localhost:3737` (validado do PowerShell). A GUI nunca toca arquivos do WSL. `scripts/windows/second-brain.cmd` inicia tudo e abre o navegador: usa a distro padrão do WSL (ou `SECOND_BRAIN_DISTRO`) e o clone em `~/projetos/second-brain` (ou `SECOND_BRAIN_REPO`).

Vault em pasta sincronizada (OneDrive, Dropbox…) com o motor no WSL: [`docs/vault-sincronizado.md`](docs/vault-sincronizado.md).

## Comandos

| | |
|---|---|
| `brain init [dir]` | cria vault |
| `brain serve [--port]` / `brain ui` | API + UI / URL com token |
| `brain mcp` | servidor MCP stdio |
| `brain review` | propostas pendentes |
| `brain search <texto>` | busca no terminal |
| `brain doctor` | diagnóstico completo (vault, Git, SQLite, FTS, API, watcher, MCP real, integrações) com a correção sugerida |
| `brain health` · `reindex` | saúde · reconstruir índice |
| `brain admin approve <id…>\|--eligible` · `ignore` · `commit` · `ui` · `passphrase` | **ações do revisor** (terminal interativo + frase-senha, se definida + confirmação). `brain ui` emite a sessão humana da UI |
| `brain revalidate <repo>` | reverifica o conhecimento APROVADO contra o HEAD; `--apply` cria propostas de revalidação (nunca altera notas) |
| `brain maintain titles` · `brain audit` | sugere títulos melhores (`--apply` = propostas) · métricas de saúde da base |
| `brain import <caminho\|->` | importa repo/pasta/arquivo/texto como propostas (com verificação de atualidade) |
| `brain reconcile <repo>` | reverifica a atualidade das propostas pendentes importadas do repo (somente leitura; `--apply` anexa) |
| `brain update-policy` | atualiza AGENTS.md/skill do vault e os blocos globais (privilegiado: terminal interativo); `--dry-run` só mostra o que mudaria |
| `brain seed [dir]` | vault DEMO |
| `brain integrate [--apply\|--remove]` | integração Claude Code/Codex/skill: dry-run, aplicar (com backup) ou desfazer |

## Estrutura do repositório

```
packages/shared  tipos/schemas        packages/mcp  adaptador MCP (stdio)
packages/core    regra de negócio     packages/api  adaptador HTTP/SSE + serve a UI
packages/cli     comando `brain`      apps/web      React + Vite (só fala com a API)
templates/       AGENTS.md, SKILL.md, README do vault (copiados no `brain init`)
docs/            architecture · knowledge-model · mcp · modules · windows-wsl · vault-sincronizado · gui · backup · FUTURE · decisions/ (ADRs)
e2e/             testes de browser (Playwright)      scripts/  start/dev/backup/windows/systemd
```

## Desenvolvimento e verificação

```bash
pnpm test         # vitest: unit + MCP stdio real + API + E2E de browser (compila tudo antes)
pnpm lint         # eslint
pnpm typecheck    # tsc -b + tsc do web
pnpm build
pnpm smoke        # ponta a ponta em vault temporário: init → import → API → doctor → MCP real
./scripts/dev.sh  # API (demo) + Vite com HMR
```
E2E precisa de um Chromium do Playwright (`~/.cache/ms-playwright`) ou `CHROME_PATH`; sem ele os testes de browser são *skipped* (não falham silenciosamente: aparecem como skipped).

## Segurança e privacidade

Tudo local. API só em `127.0.0.1` com token, checagem de `Host`/`Origin`. Segredos rejeitados antes de gravar. Embeddings externos são **opt-in** e mostram o que sai da máquina; sem embeddings a busca funciona (FTS5). Veja [`docs/architecture.md`](docs/architecture.md#segurança).

## Módulos

O second-brain carrega módulos de outros repositórios (aba na UI, rotas, tarefas agendadas, ferramentas MCP, avisos) sem que o código deles entre aqui. O exemplo é `examples/modules/lembrete`. Guia de autoria: [`docs/modules.md`](docs/modules.md).

## Backup

O vault é um repo Git: `git remote add origin … && git push` (ver [`docs/backup.md`](docs/backup.md)). `.brain/index.db` é descartável.

## Limitações conhecidas (V1)

- O embedder offline (`hash-v1`) detecta quase-duplicatas e morfologia, **não** paráfrases profundas; configure um provider de embeddings (opt-in) para recall semântico. A classificação conflito/atualização é heurística (negação e números), com revisão humana.
- Sem shell desktop, grafo avançado nem MCP remoto (HTTP) — ver [`docs/FUTURE.md`](docs/FUTURE.md).
- Propostas pendentes ficam numa fila local não versionada (as decididas vão ao Git).
- File-watching do Obsidian do Windows sobre `\\wsl.localhost` (9P) pode atrasar; há varredura de segurança a cada 5 s.
- Uso single-user/máquina única.

## Licença

[MIT](LICENSE) © 2026 Leandro Santos
