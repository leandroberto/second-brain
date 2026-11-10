# Revisão de segurança e concorrência

Revisão independente feita pelo **Codex CLI 0.162.1** (`codex exec -s read-only`, sem modificar arquivos) sobre o working tree em 2026-10-14, seguida de correções e testes pelo Claude Code. Os testes estão em `packages/core/test/security.test.ts` (um teste por achado, nomeados `#N`).

| # | Sev. | Achado | Situação |
|---|---|---|---|
| 1 | Alta | opt-in de embeddings externos burlado por `http://localhost.attacker.example` (regex sem terminador) | **Corrigido** — `isLocalUrl` compara hostname exato, recusa credenciais na URL e protocolos não-http; `redirect: "error"` no fetch |
| 2 | Alta | mover/arquivar nota sobrescrevia arquivo existente no destino | **Corrigido** — colisão é checada antes de qualquer escrita (`duplicate_id`) |
| 3 | Alta | lock roubado após 30 s mesmo com dono vivo; dono apagava o lock do sucessor | **Corrigido** — heartbeat + token de propriedade; órfão só se PID morto ou heartbeat parado; liberação só remove o próprio lock |
| 4 | Alta | entrada inválida (título > 200, `project` com `../`) era persistida e quebrava o índice | **Corrigido** — validação completa antes de gravar; parser trunca; indexação isola falha por arquivo |
| 5 | Alta | segredos em tags, motivo, evidência de import, nota da decisão e consultas (logs) | **Corrigido** — tudo é escaneado antes de persistir; atividade passa por `redactSecrets` |
| 6 | Alta | DoS por backtracking em regex do importador | **Corrigido** — cabeçalhos em parsing linear, regexes limitadas, remoção de blocos de código linear |
| 7 | Média | revision da proposta ≠ snapshot analisado | **Corrigido** — a análise roda dentro do lock |
| 8 | Média | política/config obsoleta em processos já abertos | **Corrigido** — config relida sob o lock em toda escrita |
| 9 | Média | allowlist de import seguia symlink de ancestral para fora da home | **Corrigido** — `realpath` de alvo e raízes; scan recusa arquivos cujo realpath sai da raiz |
| 10 | Média | rename apagava a nota do índice | **Corrigido** (e testado em `watcher.test.ts`) |
| 11 | Média | pathspec com glob / opção em `revert` | **Corrigido** — `GIT_LITERAL_PATHSPECS=1`; revisão validada (hex) e resolvida para hash |
| 12 | Média | placeholder escondia credencial real na mesma linha | **Corrigido** — todas as ocorrências são examinadas |
| 13 | Média | segredo colado manualmente (Obsidian) entrava no SQLite/embeddings e podia ser commitado | **Corrigido** — nota fica mascarada no índice, fora dos embeddings, fora de `commitPending` e bloqueia `link/update` até ser limpa; agentes recebem o corpo redigido |
| — | Baixa | token da API na query do SSE | **Aceito**: só loopback; limitado por Host/Origin; EventSource não envia headers. Reavaliar se virar app empacotado |
| — | Baixa | erros 500 expunham mensagem interna | **Corrigido** — mensagem genérica; detalhe só no log do servidor |
| — | Baixa | enumeração de diretório antes dos limites; releitura sem teto | **Corrigido** — teto de 50 mil entradas e 400 KB por releitura |
| — | Info | TOCTOU de troca de arquivo por symlink entre checagem e uso | **Aceito**: exige atacante local com escrita no vault, que já controla os dados |

Áreas que o revisor considerou sólidas: serialização YAML (sem injeção de frontmatter), ids restritos, `safeResolve` contra traversal comum, chamadas Git por array de argumentos (sem shell), bind em loopback + Host/Origin + token + limite de 1 MB, dedupe de propostas dentro do lock, SQLite em WAL com busy_timeout.


## 2ª rodada — revisão do diff da própria madrugada (Codex, read-only)

O mesmo revisor leu `git diff c8b2dd4..HEAD` e achou 13 problemas, vários **regressões introduzidas pelas correções da 1ª rodada**. Todos corrigidos com teste (`security.test.ts`, grupo "segunda revisão", e `skilllink.test.ts`):

| # | Sev. | Achado | Correção |
|---|---|---|---|
| R1 | P1 | segredo chegava ao provider de embeddings durante `analyze`/import antes da validação | `analyze()` valida (segredo/tamanho) **antes** de qualquer embedding |
| R2 | P1 | `reloadConfig` reconstruía o embedder com a config antiga (revogar opt-in não valia) | atribui a nova config antes de reconstruir |
| R3 | P1 | heartbeat truncava o arquivo `owner`; outro processo lia JSON parcial e despejava um lock vivo | publicação atômica (tmp+rename) + leitura com retry |
| R4 | P1 | refresh automático de propostas avançava a `target_revision`, anulando a proteção de revision | proposta cujo alvo mudou vira **stale**; revision do alvo nunca é avançada automaticamente |
| R5 | P1 | `ignoreMany` não escaneava a nota da decisão | valida antes de mutar |
| R6 | P1 | linhas > 20 000 caracteres burlavam o detector (truncava) | janelas sobrepostas; nada é truncado |
| R7 | P1 | arquivo duplicado (mesmo id) com segredo escapava da quarentena de commit | `commitPending` escaneia o **conteúdo bruto** de cada arquivo sujo |
| R8 | P1 | `replace` gravava a nota nova antes de validar a antiga (efeito parcial) | `preflight` de todas as notas afetadas antes de qualquer escrita (também em `link supersedes`) |
| R9 | P2 | aprovação em lote criava near-duplicatas | cada item é reanalisado contra o índice atual |
| R10 | P2 | UI mantinha o corpo final editado após editar a proposta | override invalidado ao mudar resolução/alvo/rascunho |
| R11 | P2 | `integrate --remove` apagava symlinks alheios | só remove link que aponta para a skill deste vault |
| R12 | P2 | slug de projeto longo gerava id fora do schema | slug ≤ 60 e ids bounded |
| R13 | P2 | filtros da fila sumiam com filtro ativo | controles ficam visíveis enquanto houver filtro |

Efeito colateral útil descoberto ao corrigir: falha do provider de embeddings (rede, chave, cota) **não derruba mais escrita** — a base segue por FTS5 e o `doctor` avisa (`embed_error`).


## 3ª rodada — revisor independente do Claude (subagente, somente leitura)

O Codex atingiu o limite de uso durante a 3ª revisão (mensagem do próprio CLI, volta às 06:57), então o commit de correção foi revisado por um subagente do Claude em contexto separado. Achados e correções (testes em `security.test.ts`, grupo "rodada 3"):

| # | Achado | Correção |
|---|---|---|
| 1 | consulta de `brain_search`/`brain_context` com segredo ia ao embedder e ao log de atividade | consulta/tópico/tarefa são redigidos antes de tudo |
| 2 | queda do provider de embeddings ainda derrubava `search`/`similar`/`propose`; `approveMany` podia deixar arquivos sem commit | busca e similaridade caem para FTS; `approveMany` sempre commita o que já gravou e reporta a interrupção |
| 3 | roubo de lock órfão não era atômico (dois contendores) | roubo por `rename` após re-checagem (só um vence) |
| 4 | `commitPending` só escaneava os 2000 primeiros arquivos; entradas de rename do `git status` | escaneia todos; `--no-renames` |
| 5 | UI: preview/edição do corpo final ficavam presos ao alvo antigo após reanálise | dependências incluem `target_revision`/`state` |
| 6 | proposta com alvo apenas sugerido vira stale ao mudar o alvo | **aceito** (atrito mínimo; reanalisar resolve) |
