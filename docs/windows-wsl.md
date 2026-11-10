# Windows + WSL

**Topologia adotada (a preferida do projeto):**

```
Windows                                  WSL2 Ubuntu 24.04
┌───────────────────────┐   localhost    ┌───────────────────────────────────────────┐
│ Navegador (UI)        │ ─────────────▶ │ brain serve  (API 127.0.0.1:3737 + UI)    │
│ (futuro: Tauri/Electron)│  HTTP/SSE     │ @brain/core · Markdown · Git · SQLite     │
│ Obsidian (opcional)   │ ── \\wsl.localhost ─▶ ~/second-brain (somente edição humana)│
└───────────────────────┘                │ Claude Code ── MCP stdio ──▶ core         │
                                         │ Codex      ── MCP stdio ──▶ core          │
                                         └───────────────────────────────────────────┘
```

- **Core, API, MCP, Markdown, Git, SQLite vivem no WSL.** Nada de Node/Electron no Windows é necessário.
- A GUI **nunca** acessa arquivos do WSL: só HTTP em `localhost`. Validado: `Invoke-WebRequest http://localhost:3737/api/health` a partir do PowerShell do Windows atinge a API no WSL (WSL2 *localhost forwarding*, padrão). O `Host` aceito é `127.0.0.1`/`localhost` na porta configurada.
- SQLite/Git ficam no ext4 do WSL (rápido e com locks corretos). **Não** coloque o vault em `/mnt/c/...` (9P lento, locks e watcher pouco confiáveis).
- **Obsidian** é a exceção consciente: edição humana de Markdown. Duas opções:
  1. Obsidian do Windows abrindo `\\wsl.localhost\Ubuntu-24.04\home\<voce>\second-brain` (funciona; o file-watching sobre 9P pode atrasar — o Second Brain complementa com `fs.watch` + varredura a cada 5 s no lado WSL).
  2. Obsidian Linux via WSLg (sem 9P). Preferível se aparecer atraso.
  `brain` mostra o caminho Windows com `wslpath -w`; a UI copia o caminho e tenta `obsidian://open`.
- Se o `localhost` do Windows não alcançar o WSL (WSL antigo/`networkingMode=mirrored` customizado): habilite `localhostForwarding=true` em `%UserProfile%\.wslconfig`, ou use `brain serve --host 0.0.0.0` **somente** com firewall local (o token continua obrigatório).
- Iniciar a partir do Windows: `scripts/windows/second-brain.cmd` (chama `wsl.exe`, sobe o serviço e abre o navegador).
- Serviço permanente (opcional): `scripts/second-brain.service` (systemd --user; o WSL tem `systemd=true`).
- O MCP não precisa do serviço: Claude Code/Codex iniciam o processo `brain mcp` sob demanda.

## Desktop shell futuro
Um shell (Tauri/Electron) no Windows apenas aponta para `http://localhost:3737` e guarda o token — por isso não há acoplamento. Ver ADR 0009.
