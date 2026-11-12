# Gerenciar módulos pela UI — plano de implementação

> **Para agentes:** sub-skill obrigatória: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans para implementar este plano tarefa por tarefa. Os passos usam checkbox (`- [ ]`).

**Objetivo:** página Configurações › Módulos com a lista dos módulos e um passo a passo de 4 etapas para adicionar, mais configurar, ligar/desligar, remover e tentar de novo, reiniciando o `brain serve` sozinho.

**Arquitetura:** o core ganha um resumo/validação de módulo reutilizável, a listagem de pastas e uma escrita dedicada do bloco `modules`; a CLI ganha `brain modules check --json` (rodado como processo filho para a conferência) e o reinício do processo; a API ganha rotas `_gerenciar` só para sessão humana `full`, com frase-senha e ticket de conferência; a web ganha a página e o assistente.

**Stack:** TypeScript estrito, Node ≥ 22.5, pnpm, zod 4, vitest, React/Vite, playwright-core (e2e).

**Spec:** `docs/superpowers/specs/2026-11-12-gerenciar-modulos-design.md` (os §§ citados estão lá).

## Restrições globais

- Repositório **público**: nada privado em código, testes ou docs; o único módulo citado é o exemplo `lembrete`.
- Sem módulos configurados, o comportamento atual não muda.
- Todas as rotas novas: **só sessão humana `full`**; api-token, desktop e token de página → 403 antes do roteamento.
- **Adicionar e ligar** exigem a frase-senha quando `hasReviewerPassphrase()`; sem frase configurada, a sessão humana basta. Configurar, desligar, remover e tentar de novo: só sessão `full`.
- O aviso de confiança e a frase-senha vêm **antes** de o código do módulo rodar (Continuar da etapa 1); a conferência roda num **processo filho descartável**.
- Remover nunca apaga a pasta nem o estado do módulo.
- `PUT /api/settings` recusa as chaves `modules` e `review` (403).
- Toda gravação no `config.yaml` passa pelo `Brain` (lock + auditoria `config_update`).
- Mensagens ao usuário em português; textos fixos do spec usados literalmente: "Módulo adicionado. O brain serve será reiniciado para aplicar as alterações." e "Para conferir, o código desta pasta será carregado no seu computador. Continue só com módulos em que você confia."
- `_gerenciar` não colide com id de módulo (regex `/^[a-z][a-z0-9-]{1,30}$/`).

## Foco de revisão

1. **Ticket de conferência perdido no reinício** (o serve reiniciou entre conferir e adicionar): `adicionar` responde 409 `{ error: "ticket_invalido" }` e a UI volta à etapa 1 com "confira a pasta de novo". *Teste: Tarefa 4, `ticket de outro processo ou expirado → 409`.*
2. **Pasta com espaço, acento ou symlink** (`~/projetos/módulo horas`, ou link para outra pasta): o caminho gravado é o real (`realpath`), absoluto, e o módulo carrega. *Teste: Tarefa 2, `listarPastas e caminho real com espaço, acento e symlink`; Tarefa 4, `adicionar grava path real`.*
3. **Adicionar um id que já está na config** (outra pasta do mesmo módulo): 409 `{ error: "id_existente" }` com o caminho já configurado; nada é gravado. *Teste: Tarefa 4, `id já configurado → 409`.*
4. **Tentativas de frase-senha em sequência** (sessão roubada tentando adivinhar): depois de 5 erros em 60 s, 429 até a janela passar, mesmo com a frase certa. *Teste: Tarefa 4, `limite de tentativas da frase-senha`.*
5. **Reinício com tarefa em andamento**: o processo antigo fecha pelo mesmo caminho do SIGTERM (aborta a tarefa pelo `sinal`, apaga `serve.json`, libera `serve.lock`) e o novo só sobe depois que o pid antigo some. *Teste: Tarefa 3, `processo novo espera o pid antigo`.*

---

### Tarefa 1: Resumo e validação de módulo, `configJson` no SDK e `brain modules check --json`

**Arquivos:**
- Modificar: `packages/module-sdk/src/index.ts` (`ModuleDef.configJson?`), `packages/cli/src/modules.ts` (`checarModulo` usa o resumo; `check --json` e `--config`), `examples/modules/lembrete/src/index.ts` (exporta `configJson` via `z.toJSONSchema`)
- Criar: `packages/core/src/modules/resumo.ts` (exportado no index de módulos)
- Teste: `packages/core/test/modules-resumo.test.ts`, `packages/cli/test/modules-cli.test.ts` (estender)

**Interfaces:**
- Produz (SDK): `ModuleDef.configJson?: Record<string, unknown>` (JSON Schema da config; opcional; `SDK_VERSION` continua 1).
- Produz (core, `resumo.ts`):
  - `interface ResumoDoModulo { id: string; nome: string; versao: string; sdk: number; aba?: { titulo: string }; tarefas: Array<{ id: string; quando: string; quandoTexto: string }>; ferramentas: string[]; rotas: { total: number; humanas: number }; usaIa: boolean; configJson?: Record<string, unknown> }`. `ferramentas` com o nome MCP `<id>_<nome>`. `usaIa` = o módulo declara uso de IA (ver passo 3).
  - `resumirModulo(def: ModuleDef): ResumoDoModulo`.
  - `descreverCron(expr: string): string` (pt-BR curto: `"30 17 * * 1-5"` → `"dias úteis às 17:30"`, `"0 10 * * *"` → `"todo dia às 10:00"`, `"0 18 * * 5"` → `"sexta às 18:00"`; fora dos padrões simples devolve a própria expressão).
  - `validarConfigDoModulo(def: ModuleDef, config: unknown): Promise<{ ok: true } | { ok: false; erros: Array<{ campo: string; mensagem: string }> }>` — usa `validar` (Standard Schema) e `scanSecrets`; segredo → erro no campo com a mensagem "use variável de ambiente ou o cofre do sistema; o módulo lê a credencial por conta própria".
- Produz (CLI): `brain modules check <pasta> --json` imprime uma linha JSON `{ ok: boolean; causas: string[]; resumo?: ResumoDoModulo }` e sai 0/1; com `--config <arquivo|->` (JSON; `-` = stdin) inclui `config: { ok: true } | { ok: false; erros: [...] }`. É a interface que a Tarefa 4 chama como processo filho.

- [ ] **Passo 1: testes que falham** em `modules-resumo.test.ts`:
  - `resumirModulo do lembrete`: importa `examples/modules/lembrete/dist/index.js` → `{ id: "lembrete", aba: { titulo: … }, tarefas: [{ id: "diario", quando: "0 10 * * *", quandoTexto: "todo dia às 10:00" }], ferramentas: ["lembrete_listar"], rotas: { total: 2, humanas: 1 }, configJson: (objeto com propriedade "horario") }`.
  - `descreverCron`: os três exemplos acima; `"*/15 * * * *"` → a própria expressão.
  - `validarConfigDoModulo`: `{ horario: "25:00" }` → `ok: false` com `campo: "horario"`; `{ horario: "10:00" }` → `ok: true`; `{ horario: "10:00", token: "ghp_" + "a".repeat(36) }` → erro em `token` sem conter `ghp_`.
  - Em `modules-cli.test.ts`: `check --json` do lembrete → `ok: true` e `resumo.id === "lembrete"`; fixture `sdk2` → `ok: false`, causa com `sdk`; `--config -` com `{"horario":"x"}` via stdin → `config.ok === false`.
- [ ] **Passo 2:** `pnpm vitest run packages/core/test/modules-resumo.test.ts packages/cli/test/modules-cli.test.ts` → FALHA.
- [ ] **Passo 3:** implementar. `usaIa`: o SDK ganha também `usaIa?: boolean` opcional em `ModuleDef` (declaração do autor; o lembrete declara `usaIa: true` porque usa IA quando `config.ia`); documente no guia. `checarModulo` passa a reutilizar `resumirModulo` e `rotasComCaminhoInvalido` (mesma regra).
- [ ] **Passo 4:** mesmo comando → PASSA; `pnpm typecheck && pnpm lint`.
- [ ] **Passo 5: commit** `feat(modules): resumo do módulo, configJson no SDK e brain modules check --json`.

### Tarefa 2: Listagem de pastas e escrita dedicada do bloco `modules`

**Arquivos:**
- Criar: `packages/core/src/modules/pastas.ts`
- Modificar: `packages/core/src/brain.ts` (método novo), exports
- Teste: `packages/core/test/modules-pastas.test.ts`, `packages/core/test/modules-config.test.ts` (estender)

**Interfaces:**
- Produz:
  - `listarPastas(caminho?: string, o?: { home?: string; mostrarOcultas?: boolean }): { caminho: string; pai?: string; pastas: Array<{ nome: string; caminho: string; provavelModulo: boolean }> }` — `caminho` padrão: `<home>/projetos` se existir, senão `<home>`. Caminho relativo → `BrainError("invalid")`. Só diretórios (symlink para diretório conta, com `caminho` = realpath); sem ocultos por padrão; ordenados por nome (`localeCompare` pt-BR); pasta ilegível (EACCES) → `BrainError("forbidden", "sem permissão para ler <caminho>")`. `provavelModulo`: `package.json` legível com `@brain/module-sdk` em `dependencies`/`devDependencies`/`peerDependencies` (leitura estática, nunca importa).
  - `caminhoRealDePasta(caminho: string): string` — absoluto, normalizado, `realpath`; não é diretório → `BrainError("invalid", "<caminho> não é uma pasta")`.
  - `Brain.setModuleEntry(id: string, entry: ModuleEntry | null, who: Principal): Promise<BrainConfig>` — `authorize(who, "admin")`; `null` remove a chave; grava o bloco `modules` inteiro (sem `deepMerge`, que não remove chaves); valida com `ConfigSchema`; auditoria `config_update` com `{ modulo: id, acao: "adicionar" | "atualizar" | "remover" }`. `ModuleEntry` = o tipo de `ConfigSchema.modules[id]` exportado.

- [ ] **Passo 1: testes que falham:**
  - `listarPastas e caminho real com espaço, acento e symlink`: home temporário com `projetos/módulo horas/package.json` (com `@brain/module-sdk` em `dependencies`), `projetos/.oculta/`, `projetos/arquivo.txt`, `projetos/link` → symlink para `módulo horas`. Esperado: padrão = `<home>/projetos`; pastas = `["link", "módulo horas"]` (sem `.oculta`, sem o arquivo); as duas com `provavelModulo: true`; `link.caminho` = realpath de `módulo horas`.
  - `relativo e arquivo`: `listarPastas("projetos")` → `invalid`; `caminhoRealDePasta(<arquivo>)` → `invalid`.
  - `setModuleEntry`: adicionar `lembrete` → relido do disco igual; atualizar `enabled: false` mantém `config`; `null` remove a chave e mantém os outros módulos; atividade registra `config_update` com `modulo` e `acao`; principal agente → `forbidden`.
- [ ] **Passo 2:** `pnpm vitest run packages/core/test/modules-pastas.test.ts packages/core/test/modules-config.test.ts` → FALHA.
- [ ] **Passo 3:** implementar.
- [ ] **Passo 4:** mesmo comando → PASSA; `pnpm typecheck && pnpm lint`.
- [ ] **Passo 5: commit** `feat(modules): listagem de pastas e escrita dedicada do bloco modules`.

### Tarefa 3: Reinício do `brain serve` sem depender de systemd

**Arquivos:**
- Criar: `packages/cli/src/reinicio.ts`
- Modificar: `packages/cli/src/serve.ts` (`ServeOptions.reiniciarServe?`, espera do pid antigo), `packages/cli/src/bin.ts` (liga o reinício), `packages/api/src/modules.ts` (`ModulesApiOptions.reiniciarServe?` repassado)
- Teste: `packages/cli/test/modules-reinicio.test.ts`

**Interfaces:**
- Produz:
  - `reiniciarProcesso(o: { fechar: () => Promise<void>; logPath: string; env?: NodeJS.ProcessEnv; spawnFn?: typeof spawn; sair?: (codigo: number) => never }): Promise<void>`. Regras (spec §7.1):
    - com `env.INVOCATION_ID` (systemd): chama `fechar()` e `sair(75)` (a unit `Restart=on-failure` reinicia em código ≠ 0; documente no comentário da unit).
    - senão: `spawnFn(process.execPath, [...process.execArgv, ...process.argv.slice(1)], { detached: true, stdio: ["ignore", fd(logPath), fd(logPath)], env: { ...env, BRAIN_SERVE_ESPERAR_PID: String(process.pid) }, cwd: process.cwd() })`; espera o evento `spawn` (erro → lança e **não** fecha); `unref()`; então `fechar()` e `sair(0)`.
  - `startServe` lê `BRAIN_SERVE_ESPERAR_PID`: antes de adquirir o `serve.lock`, espera esse pid sumir (`process.kill(pid, 0)` com ESRCH), com limite de 30 s (passado → segue para a aquisição normal, que recusa se ainda houver serve vivo).
  - `ServeOptions.reiniciarServe?: () => Promise<void>` repassado para `ModulesApiOptions.reiniciarServe`; o `bin.ts` monta com `fechar = h.close() + b.close()` e `logPath = <dir de estado do serve>/serve.log`.
  - Quando iniciado num terminal, antes de sair o processo antigo imprime `brain serve reiniciado em segundo plano; saída em <logPath>`.

- [ ] **Passo 1: testes que falham** (com `spawnFn` e `sair` falsos):
  - `systemd fecha e sai 75`: `env.INVOCATION_ID` → `fechar` chamado, `sair(75)`, `spawnFn` não chamado.
  - `sem systemd sobe cópia destacada e sai 0`: `spawnFn` chamado com `process.execPath`, argv atual, `detached: true` e `BRAIN_SERVE_ESPERAR_PID`; depois `fechar` e `sair(0)` nessa ordem.
  - `falha ao subir a cópia mantém o atual`: `spawnFn` emite `error` → `reiniciarProcesso` rejeita; `fechar` e `sair` não chamados.
  - `processo novo espera o pid antigo`: um processo filho dorme 1 s; `startServe` com `BRAIN_SERVE_ESPERAR_PID=<pid dele>` só adquire o lock depois que ele sai (meça: aquisição ≥ saída do filho); com pid inexistente segue na hora.
- [ ] **Passo 2:** `pnpm vitest run packages/cli/test/modules-reinicio.test.ts` → FALHA.
- [ ] **Passo 3:** implementar.
- [ ] **Passo 4:** mesmo comando → PASSA; `pnpm typecheck && pnpm lint && pnpm test`.
- [ ] **Passo 5: commit** `feat(cli): brain serve reinicia a si mesmo (cópia destacada ou systemd)`.

### Tarefa 4: API de gerenciamento (`_gerenciar`, pastas, frase-senha, ticket) e o atalho fechado

**Arquivos:**
- Criar: `packages/api/src/modules-gerenciar.ts`
- Modificar: `packages/api/src/modules.ts` (roteia `/api/modules/_gerenciar/*` antes do lookup de módulo; matriz), `packages/api/src/index.ts` (`/api/fs/pastas`; `PUT /api/settings` recusa `modules`/`review`), `packages/cli/src/serve.ts` (fornece `conferir`), `packages/cli/src/modules.ts` (função que roda o check como processo filho)
- Teste: `packages/api/test/modules-gerenciar.test.ts`, `packages/cli/test/modules-cli.test.ts` (estender: conferência por processo filho)

**Interfaces:**
- Consome: Tarefa 1 (`check --json`, `ResumoDoModulo`), Tarefa 2 (`listarPastas`, `caminhoRealDePasta`, `Brain.setModuleEntry`), Tarefa 3 (`reiniciarServe`), `hasReviewerPassphrase`/`checkReviewerPassphrase` (`packages/core/src/sessions.ts`).
- Produz:
  - `ModulesApiOptions.conferir?: (caminho: string, config?: unknown) => Promise<{ ok: boolean; causas: string[]; resumo?: ResumoDoModulo; config?: { ok: true } | { ok: false; erros: Array<{ campo: string; mensagem: string }> } }>` — implementada na CLI como `conferirEmProcessoFilho(caminho, config?)`: `spawn(process.execPath, [binDaCli, "modules", "check", caminho, "--json", "--config", "-"])`, config pelo stdin, `BRAIN_STATE_DIR` temporário, env sem `BRAIN_API_TOKEN`/sessões, timeout 30 s (estourou → `ok: false`, causa "a conferência do módulo passou de 30 s").
  - Rotas (todas só `sessao`; api-token, desktop e página → 403 em `negarAntesDoRoteamento`, inclusive `/api/fs/pastas`, que é rota do core e hoje passaria para o api-token):
    - `GET /api/fs/pastas?caminho=` → `listarPastas` (relativo → 400; EACCES → 403 com a mensagem).
    - `POST /api/modules/_gerenciar/inspecionar` `{ caminho, fraseSenha? }` → frase quando houver; `caminhoRealDePasta`; `conferir(caminho)`; responde `{ ok, causas, resumo, ticket? }` (ticket só se `ok`).
    - `POST /api/modules/_gerenciar/adicionar` `{ ticket, config, soNestaMaquina }` → ticket válido da mesma sessão (hash do token de sessão) e não expirado (15 min), senão 409 `{ error: "ticket_invalido" }`; id já na config → 409 `{ error: "id_existente", caminho }`; `conferir(caminho, config)` → `config.ok === false` → 400 `{ error: "config_invalida", erros }`; grava `{ enabled: true, path: <real>, config, host?: os.hostname() }` via `setModuleEntry`; consome o ticket; responde 200 `{ mensagem: "Módulo adicionado. O brain serve será reiniciado para aplicar as alterações." }` e chama `reiniciarServe()` **depois** de a resposta ser enviada (`res.on("finish")`); sem `reiniciarServe` → `reiniciar: true` na resposta e nada mais.
    - `PUT /api/modules/_gerenciar/<id>` `{ config?, enabled?, soNestaMaquina?, fraseSenha? }` → id ausente da config → 404; virar `enabled: true` partindo de desligado → frase quando houver; com `config`: se o módulo carrega, `conferir(path, config)` (inválida → 400); se não carrega (falho/ausente), grava sem schema mas com `scanSecrets` (segredo → 400); grava e reinicia como acima.
    - `DELETE /api/modules/_gerenciar/<id>` → remove a entrada (nunca toca disco do módulo), reinicia.
    - `POST /api/modules/_gerenciar/reiniciar` → reinicia.
  - Frase-senha: errada → 403 `{ error: "frase_senha" , message: "frase-senha incorreta" }`; ausente quando exigida → 403 com `message: "este vault exige a frase-senha do revisor"`; limite: 5 erros por janela de 60 s por processo → 429 `{ error: "tentativas" }` (inclusive com a frase certa) até a janela passar.
  - Ticket: aleatório (`randomBytes(32)` base64url), em memória (`Map`), ligado a `{ caminhoReal, sessaoHash, expira }`.
  - `PUT /api/settings` com chave `modules` ou `review` no corpo → 403 `{ error: "forbidden", message: "use Configurações › Módulos" | "a frase-senha se configura no terminal (brain admin passphrase)" }`.

- [ ] **Passo 1: testes que falham** em `modules-gerenciar.test.ts` (com `conferir` e `reiniciarServe` falsos; um teste usa a `conferirEmProcessoFilho` real com o lembrete):
  - `matriz`: as 6 rotas com api-token, credencial do desktop e token de página → 403; com sessão `full` → não-403.
  - `inspecionar sem frase configurada`: → 200 com `resumo.id === "lembrete"` e `ticket`.
  - `frase-senha`: com frase configurada (`setReviewerPassphrase` num store temporário), `inspecionar` sem frase → 403, com frase errada → 403, com a certa → 200; `PUT {enabled:true}` de um desligado sem frase → 403; `PUT {config}` de um ligado sem frase → 200.
  - `limite de tentativas da frase-senha`: 5 erradas → a 6ª (mesmo certa) → 429; com relógio avançado 61 s → certa → 200.
  - `adicionar grava path real`: ticket de uma pasta via symlink → entrada com `path` = realpath, `enabled: true`, `config` igual, `host` só com `soNestaMaquina`; resposta com a mensagem exata; `reiniciarServe` chamado depois da resposta.
  - `ticket de outro processo ou expirado → 409`: ticket inventado → 409 `ticket_invalido`; ticket de outra sessão → 409; ticket com 15 min + 1 s → 409.
  - `id já configurado → 409`: config com `lembrete` em outra pasta → 409 `id_existente` com `caminho`; config inalterada.
  - `config inválida`: `{ horario: "x" }` → 400 `config_invalida` com `erros[0].campo === "horario"`; nada gravado.
  - `remover não apaga a pasta nem o estado`: após `DELETE`, a pasta do módulo e `<modulesStateRoot>/lembrete` continuam existindo; a entrada sumiu.
  - `módulo falho: configurar sem schema mas com scanSecrets`: entrada apontando para pasta inexistente → `PUT {config:{a:1}}` → 200; `PUT {config:{token:"ghp_"+…}}` → 400.
  - `settings recusa modules e review`: `PUT /api/settings {modules:{}}` → 403; `{review:{passphrase_required:false}}` → 403; `{git:{auto_commit:false}}` → 200.
  - `fs/pastas`: relativo → 400; sessão → lista; api-token → 403.
  - Em `modules-cli.test.ts`: `conferirEmProcessoFilho` do lembrete → `ok: true`; com `{horario:"x"}` → `config.ok === false`; fixture que dorme 60 s no import → `ok: false` com a causa de 30 s (use timeout injetável curto no teste).
- [ ] **Passo 2:** `pnpm vitest run packages/api/test/modules-gerenciar.test.ts packages/cli/test/modules-cli.test.ts` → FALHA.
- [ ] **Passo 3:** implementar.
- [ ] **Passo 4:** `pnpm vitest run packages/api packages/cli` → PASSA; `pnpm typecheck && pnpm lint && pnpm test`.
- [ ] **Passo 5: commit** `feat(api): gerenciamento de módulos só para sessão humana, com frase-senha e ticket de conferência`.

### Tarefa 5: UI — Configurações › Módulos, lista e assistente de 4 etapas

**Arquivos:**
- Criar: `apps/web/src/ModulesPage.tsx` (lista + ações), `apps/web/src/AddModuleWizard.tsx` (4 etapas), `apps/web/src/configForm.ts` (funções puras), `apps/web/src/configForm.test.ts`
- Modificar: `apps/web/src/App.tsx` (rota `settings/modulos`), `apps/web/src/pages3.tsx` (a seção Módulos vira um cartão com link "Gerenciar módulos"), `apps/web/src/api.ts` (tipos e chamadas), `apps/web/src/styles.css`

**Interfaces:**
- Consome: rotas da Tarefa 4; `GET /api/modules` (lista atual, `useModulos()`), `GET /api/serve` (`{ pid, vault }`).
- Produz:
  - `camposDoSchema(schema: unknown): Campo[] | undefined` — `Campo = { nome: string; tipo: "texto" | "numero" | "booleano" | "opcoes"; rotulo: string; descricao?: string; obrigatorio: boolean; opcoes?: string[]; padrao?: unknown }`; `undefined` quando o schema não é um objeto raso só com string/number/integer/boolean/enum (→ editor JSON).
  - `valoresIniciais(campos: Campo[], config?: Record<string, unknown>): Record<string, unknown>`.
  - `esperarReinicio(pidAntigo: number, o?: { buscar?: () => Promise<{ pid: number } | undefined>; intervaloMs?: number; limiteMs?: number }): Promise<"ok" | "tempo">` — consulta `GET /api/serve` até o `pid` mudar (falhas de rede durante o reinício são esperadas); limite 60 s.
- Comportamento (spec §2 e §6):
  - Rota `#/settings/modulos`; o menu lateral não muda.
  - Lista: um cartão por módulo com nome, versão, situação e causa+dica, pasta, tarefas (próxima/última/resultado), IA do dia; ações Configurar, Ligar/Desligar, Rodar agora (já existe), Ver erros, Remover, e Tentar de novo no falho. Ações que reiniciam pedem `confirm("<ação> <nome>? O brain serve será reiniciado.")`. Ligar pede a frase-senha (campo) quando o servidor responder 403 `frase_senha`/exigida.
  - Assistente: etapa 1 navegador de pastas (`/api/fs/pastas`, botão "subir", campo de caminho) → ao Continuar, diálogo com o texto de confiança literal e campo de frase-senha (mostrado quando o servidor exigir) → etapa 2 resumo (`quandoTexto` das tarefas, ferramentas, "N rotas, M agem fora (só com você logado)", "usa IA (até US$ <teto>/dia)", "propõe notas como module/<id>") ou causas com Continuar desabilitado → etapa 3 formulário (`camposDoSchema`) ou editor JSON, erros por campo vindos do 400, "Só nesta máquina" → etapa 4 resumo e "Adicionar e reiniciar o serve" → toast com a mensagem literal → `esperarReinicio` → `location.reload()`. 409 `ticket_invalido` → volta à etapa 1 com "confira a pasta de novo".

- [ ] **Passo 1: testes que falham** em `configForm.test.ts`:
  - `camposDoSchema` do `configJson` do lembrete (copie o JSON gerado na Tarefa 1 para o teste) → campo `horario` tipo `texto` e `ia` tipo `booleano` com `padrao: false`.
  - schema com objeto aninhado ou array → `undefined`.
  - enum → `tipo: "opcoes"` com as opções.
  - `valoresIniciais` usa `config` existente e cai no `padrao`.
  - `esperarReinicio`: `buscar` devolve pid antigo, depois rejeita (rede), depois pid novo → `"ok"`; sempre o antigo com `limiteMs` curto → `"tempo"`.
- [ ] **Passo 2:** `pnpm vitest run apps/web/src/configForm.test.ts` → FALHA.
- [ ] **Passo 3:** implementar, seguindo o estilo atual de Configurações (classes `card`, `field`, `switch`, `btn`).
- [ ] **Passo 4:** `pnpm vitest run apps/web && pnpm --filter @brain/web typecheck && pnpm lint` → PASSA.
- [ ] **Passo 5: commit** `feat(web): Configurações › Módulos com lista e assistente de adicionar`.

### Tarefa 6: Ponta a ponta no navegador e documentação

**Arquivos:**
- Modificar: `e2e/modules.e2e.test.ts` (novo `describe` ou testes), `docs/modules.md` (seção "Gerenciar pela UI"), `docs/decisions/0015-modulos.md` (um parágrafo: gerenciamento pela UI, frase-senha, processo filho, reinício), `README.md` (uma linha), `scripts/second-brain.service` (comentário: código 75 reinicia com `on-failure`)

**Interfaces:**
- Consome: tudo acima. No e2e, `startServe` recebe um `reiniciarServe` de teste que registra a chamada e reinicia o serve programaticamente (fecha e sobe outro `startServe` na mesma porta).

- [ ] **Passo 1: teste que falha** (skipIf sem Chrome/dist, como os outros e2e): vault sem módulos → Configurações › Módulos mostra lista vazia e "+ Adicionar módulo" → etapa 1 navega até `examples/modules/lembrete` (ou cola o caminho) → Continuar mostra o texto de confiança → etapa 2 mostra "lembrete_listar" e "todo dia às 10:00" → etapa 3 preenche `horario` com `"09:30"` → etapa 4 "Adicionar e reiniciar o serve" → o `reiniciarServe` de teste é chamado, a página volta e o item "Lembretes" aparece no menu → Desligar (confirm aceito) → o item some do menu → Remover → a lista volta vazia e a pasta do exemplo continua existindo.
- [ ] **Passo 2:** `pnpm vitest run e2e/modules.e2e.test.ts` → FALHA.
- [ ] **Passo 3:** ajustar o que faltar; escrever a documentação (o fluxo, as regras de frase-senha, o processo filho, o reinício e o `serve.log`, Remover sem apagar nada, e o que fica de fora — spec §3).
- [ ] **Passo 4:** `pnpm vitest run e2e/modules.e2e.test.ts` 3× → PASSA; `pnpm build && pnpm typecheck && pnpm lint && pnpm test`; `cd apps/desktop && npx vitest run`.
- [ ] **Passo 5: commit** `feat(modules): e2e do gerenciamento pela UI e documentação`.
