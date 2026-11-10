# Backup e recuperação

O vault é um repositório Git comum — o backup é **empurrar o Git**.

1. **Remoto privado** (recomendado): `git -C ~/second-brain remote add origin git@github.com:<voce>/second-brain-vault.git && git push -u origin main`. Repositório **privado**; o vault não deve conter segredos (o sistema os rejeita), mas contém conhecimento pessoal/de clientes.
2. **Automático**: um timer diário `git -C ~/second-brain push` (systemd --user ou cron) — `scripts/backup.sh` faz commit das edições pendentes + push.
3. **Cópia fria**: `tar czf` do vault inclui `.git`. `.brain/index.db` é descartável.
4. **Restaurar**: `git clone … ~/second-brain && brain reindex` (reconstrói o índice; propostas pendentes — fila local não versionada — não são restauradas, as decididas sim).
5. **Rollback de uma decisão**: UI → Configurações → ↩ no commit, ou `git revert <hash>` (preserva histórico) seguido de `brain reindex`.
6. **Sem dependência de ferramenta**: apague `.brain/index.db`, desinstale tudo — os `.md` continuam abrindo no Obsidian/qualquer editor.
