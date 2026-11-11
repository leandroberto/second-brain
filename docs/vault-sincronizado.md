# Vault em pasta sincronizada (OneDrive, Dropbox…)

Guia para usar uma pasta sincronizada como vault, mantendo o motor no WSL. É um runbook de uso único: siga na ordem. Os exemplos usam `<pasta>` para o caminho da pasta vista do WSL (por exemplo `/mnt/c/Users/<voce>/<pasta-sincronizada>/notas`) e `brain` para `pnpm brain` (ou `node packages/cli/dist/bin.js`), executado na raiz do clone.

## Quando usar

Use quando as notas já vivem (ou precisam viver) numa pasta sincronizada, aberta no Obsidian do Windows, no celular etc. O que fica na pasta são só as **notas** (`knowledge/**`, `AGENTS.md`, `README.md`, `.brain/config.yaml`, `.brain/proposals/decided/`, `.obsidian/`).

O **motor** fica no disco do WSL (ext4), em um diretório de estado: `index.db*` (SQLite), `lock.d`, `proposals/pending/`, `api-token` e o git-dir. Motivo: o 9P de `/mnt/c` é lento e não confiável para SQLite, Git e locks, e o `api-token` e o histórico não podem ser sincronizados. Ver [`windows-wsl.md`](windows-wsl.md).

## Pré-requisitos

- Node ≥ 22.5 e pnpm no WSL. Se o corepack do sistema não rodar o pnpm da versão do `packageManager` do `package.json`, instale direto e garanta que ele vem primeiro no `PATH`:

  ```bash
  npm i -g pnpm@<versão do packageManager>
  pnpm --version
  ```

- Build: `pnpm install && pnpm build`.
- Claude CLI autenticado para uso sem supervisão (assistente, capturas). Num terminal do WSL:

  ```bash
  claude setup-token
  claude -p "ok"        # deve responder sem login interativo
  ```

## Configuração

Crie `<pasta>/.brain/config.yaml` **antes** do `init`:

```yaml
vault_name: Notas        # o nome vira o slug do diretório de estado
state:
  external: true         # motor fora da pasta sincronizada
agents:
  commit_policy: additive
governance:
  keep_history_section: true
```

Depois:

```bash
brain init "<pasta>"     # inicializa sobre a pasta existente, sem apagar nada
export BRAIN_VAULT="<pasta>"
brain doctor             # tudo verde, incluindo external-state
```

- **Diretório de estado:** `~/.local/state/second-brain/<slug do vault_name>/` (criado com permissão `0700`); `BRAIN_STATE_DIR` sobrescreve o local. Com `state.external: true`, o core recusa abrir o vault se esse diretório não puder ser usado.
- **Um estado, um vault:** na primeira abertura o core grava `<estado>/vault-path` com o caminho real do vault e, depois, recusa (`state_unavailable`) abrir outro vault com o mesmo estado. Se usar `BRAIN_STATE_DIR`, ele precisa ser **igual em todos os pontos de entrada** do vault: o `serve` (unit do systemd), o MCP do Claude Code (`env` do servidor `second-brain`) e o timer de backup. Valores diferentes criam dois índices e dois históricos para as mesmas notas.
- **Nunca pode aparecer na pasta sincronizada:** `.git`, `index.db*`, `api-token`, `lock.d`. O `doctor` acusa falha se aparecer. O Git roda com `--git-dir=<estado>/git --work-tree=<pasta>`.
- `commit_policy: additive` e `keep_history_section` estão explicados em [Agentes](#agentes).
- Em `assistant.*` (`engine`, `model`, `max_budget_usd`, `timeout_s`, `claude_path`) os padrões servem; ajuste só se precisar.

## Migração de um vault em pastas

Para notas antigas organizadas por pastas de tema, com cabeçalho `titulo`/`tags`/`criado`/`atualizado`. O comando `migrate-flat` preserva o texto (não usa o importador).

1. **Copie a pasta inteira** para um lugar seguro. Não pule este passo.
2. Confira que as notas antigas estão rastreadas pelo Git do estado:

   ```bash
   git --git-dir=<estado>/git --work-tree="<pasta>" ls-files
   ```

3. **Dry-run** (o padrão; não grava nada, não exige humano):

   ```bash
   brain migrate-flat "<pasta>"
   ```

   A tabela mostra id, tipo, projeto e origem → destino. Tipos com `?` são sugestões.
4. Corrija os tipos errados com `--type id=tipo` (repetível; o tipo precisa ser um tipo de nota válido) e rode de novo até a tabela ficar certa.
5. Aplique, **num terminal interativo** (só o revisor humano aplica):

   ```bash
   brain migrate-flat "<pasta>" --apply --type <id>=<tipo> --type <id2>=<tipo2>
   ```

O que acontece:

- O corpo é preservado byte a byte, exceto links convertidos (`## Ver também` vira `[[id]]`); `## Histórico` fica como está.
- Os originais vão para `_legado/`, onde ficam até você aprovar. `.desfazer/` é descartado (o desfazer passa a ser `git revert`). Entradas de `_entrada/` vão para `.brain/captures/`.
- Tudo entra em **um único commit**.
- Arquivos que não sejam UTF-8 válido (latin1/cp1252) são **recusados** e nada é alterado. Converta-os e rode de novo.
- **Reverter:** `git --git-dir=<estado>/git --work-tree="<pasta>" revert <commit>` seguido de `brain reindex`; em último caso, restaure a cópia do passo 1.

## Serviço e backup

`brain serve` e o backup rodam como `systemd --user` no WSL (o WSL precisa de `systemd=true`). Os arquivos de `scripts/` assumem o clone em `~/projetos/second-brain` e o vault em `~/second-brain`: ajuste o `BRAIN_VAULT` (e o caminho do clone, se for outro) numa cópia ou por `systemctl --user edit`.

```bash
mkdir -p ~/.config/systemd/user
cp scripts/second-brain.service scripts/second-brain-backup.{service,timer} ~/.config/systemd/user/
systemctl --user edit second-brain.service          # [Service] Environment=BRAIN_VAULT=<pasta>
systemctl --user edit second-brain-backup.service   # idem
systemctl --user daemon-reload
systemctl --user enable --now second-brain.service second-brain-backup.timer
curl -s localhost:3737/api/health
```

O timer diário roda `brain backup-history`, que grava o histórico Git em `<pasta>/.brain/backup/history.bundle` (um arquivo só, seguro para sincronizar; pula se nada mudou). Como o git-dir fica fora da pasta, é esse bundle que o sincronizador leva. Restaurar:

```bash
git clone <pasta>/.brain/backup/history.bundle restaurado
```

Ver também [`backup.md`](backup.md).

## Agentes

```bash
brain integrate            # dry-run
brain integrate --apply    # configura MCP e a política no Claude Code (faz backup antes)
claude mcp list            # second-brain: Connected
```

Se existir uma skill antiga de notas em `~/.claude/skills/`, remova-a para não duplicar a do second-brain.

Com `agents.commit_policy: additive` ([ADR 0014](decisions/0014-captura-aditiva.md)), o agente grava direto só o que acrescenta: `new` cria a nota e `complement` anexa uma seção datada com origem; `duplicate` é registrado como ignorado. `update`, `replace` e `conflict` vão para a Review Queue, e continuam só humanos: aprovação em lote, revert, config e decisões da fila. A classificação é do core, não do agente. Um tipo marcado `review` em `agents.per_type` continua indo para a fila. Com `governance.keep_history_section: true`, aprovar um `update` move a linha antiga para `## Histórico` em vez de apagá-la.

## Atalho desktop (Windows)

1. No terminal interativo do WSL (a credencial só sai para humano):

   ```bash
   brain pair-desktop
   ```

   Os avisos vão para o stderr e o stdout leva **só o token** (válido por 30 dias). Guarde-o e não o compartilhe. O desktop renova a credencial sozinho (na subida e uma vez por dia, quando ela tem mais de 7 dias); só é preciso parear de novo se ela vencer com o desktop desligado ou for recusada.
2. No PowerShell do Windows, copie e instale o desktop (sem `-Distro`, usa a distro padrão do WSL):

   ```powershell
   .\scripts\windows\desktop-install.ps1
   # outra distro: -Distro <nome>; teste: -Dest <pasta nova> -SkipShortcut
   ```

   `-WslUser` (padrão: o resultado de `wsl whoami`) e `-RepoPath` (padrão: `projetos\second-brain`) localizam o clone em `\\wsl.localhost\<distro>\home\<usuário>\<RepoPath>`. Um clone fora do caminho padrão exige `-RepoPath`, por exemplo `-RepoPath dev\second-brain`. Se o PowerShell bloquear o script, rode com `powershell -ExecutionPolicy Bypass -File .\scripts\windows\desktop-install.ps1`.

   A instalação espelha a pasta de destino, então o script só aceita em `-Dest` uma pasta nova, vazia ou instalada por ele (marcador `.second-brain-desktop`); uma pasta com outros arquivos é recusada.

   O script grava a distro e o clone escolhidos na cópia de `second-brain.cmd`. Fora dela, o `.cmd` lê `SECOND_BRAIN_DISTRO` (sem ela, não passa `-d` e o WSL usa a distro padrão) e `SECOND_BRAIN_REPO` (padrão `~/projetos/second-brain`).
3. Cole o token no desktop uma vez.

A credencial tem escopo `desktop`: só captura, pergunta, reprocessa e desfaz as capturas do próprio desktop (e lê a saúde). Não decide a fila, não aprova em lote, não reverte commits alheios e não muda config. Decidir a fila continua sendo na UI web.

## Verificação final

- [ ] `brain doctor` verde (incluindo `external-state`).
- [ ] `curl -s localhost:3737/api/health` no WSL responde.
- [ ] No PowerShell: `Invoke-WebRequest http://localhost:3737/api/health` responde.
- [ ] Edite uma nota no Obsidian do Windows: ela aparece na UI em segundos (varredura de 5 s sobre o 9P).
- [ ] A pasta sincronizada não contém `.git`, `index.db*`, `api-token` nem `lock.d`:

  ```bash
  find "<pasta>" \( -name .git -o -name 'index.db*' -o -name api-token -o -name lock.d \)
  ```

  (a saída deve ser vazia)
- [ ] `claude mcp list` mostra `second-brain: Connected`.

## Problemas comuns

- **Cópias de conflito do sincronizador** (`nome-MAQUINA.md` ao lado de `nome.md`): aparecem em *Saúde* como `sync_conflict_copy`. Junte o conteúdo por uma proposta de `complement`; a fusão nunca é automática.
- **Erro `auth` no assistente:** rode `claude setup-token` num terminal do WSL e confira com `claude -p "ok"`.
- **Captura `pendente`:** é um estado real de captura (falha de autenticação, timeout ou orçamento). O texto bruto está em `.brain/captures/AAAA-MM.md`. Ele nunca se perde. Confira as pendentes e reprocesse (a ação "Organizar pendentes" na bandeja, ou reiniciar o `serve`).
- **O `serve` não abre o vault:** o diretório de estado não pôde ser usado (permissão, `BRAIN_STATE_DIR` inválido). Rode `brain doctor`.
- **Desktop não acha a API:** confirme `systemctl --user status second-brain.service` e o `curl` de saúde.
- **O desktop mostra "Não sei se foi registrado; confira as pendentes (bandeja → Organizar pendentes) antes de reenviar." (ou "Não sei se foi desfeito" / "Não sei se organizou"):** `incerto` não é estado de captura, é só o resultado que o desktop devolve quando a resposta não chega (timeout ou erro 5xx). O servidor pode ter gravado, então o desktop **não reenvia** sozinho, para não duplicar. Ação: confira bandeja → *Organizar pendentes*, a nota e a Review Queue antes de reenviar. O texto ditado já está em `.brain/captures/AAAA-MM.md` antes de qualquer processamento. Na pergunta, o timeout aparece como "A pergunta demorou demais para responder; tente de novo." e basta repetir.
- **`ls-files` vazio na migração:** o histórico do estado não rastreia as notas antigas. Pare e não use `--apply` antes de commitar o estado atual (ou de confirmar a cópia do passo 1).
- **`systemctl --user edit` do `second-brain.service`:** se o clone não estiver em `~/projetos/second-brain`, sobrescreva também o `ExecStart` (linha `ExecStart=` vazia e depois a nova).
- **`systemd=true`:** em `/etc/wsl.conf`, `[boot]` com `systemd=true`, e depois `wsl --shutdown`.
