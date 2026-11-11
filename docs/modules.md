# Módulos: guia de autoria

Um módulo estende o second-brain com coisas que só fazem sentido para o dono: uma aba na UI, rotas HTTP, tarefas agendadas,
ferramentas MCP, estado próprio, uso do motor de IA e avisos. O código mora num repositório próprio e é ligado por
configuração. Nada dele entra neste repositório. A decisão e seus limites estão no [ADR 0015](decisions/0015-modulos.md).

O exemplo completo e pequeno é [`examples/modules/lembrete`](../examples/modules/lembrete). Os trechos abaixo vêm dele.

**Modelo de confiança.** Um módulo é código instalado pelo dono e roda dentro do `brain serve`, com o poder do Node. A proteção
do desenho é contra erro e contra conteúdo hostil na página (XSS), não contra um módulo malicioso. Instale só o que você
confia.

## Estrutura

```
meu-modulo/
  package.json        "type": "module", exports apontando para dist/
  tsconfig.json
  src/index.ts        export default defineModule({...})
  ui/                 a aba (HTML + JS), sem bundler ou com o build que você preferir
  dist/               compilado (o second-brain não compila módulos)
```

O `id` segue `/^[a-z][a-z0-9-]{1,30}$/` e vira prefixo de rota, de ferramenta, de estado e de ator. Ele precisa ser igual à
chave de `modules` no vault. O carregador faz `import()` do `exports` (ou `main`) do `package.json`, já em JavaScript.

### Instalar

O código fica na máquina, em `$BRAIN_MODULES_DIR/<id>` (padrão `~/.local/share/second-brain/modules/<id>`). Pode ser um clone
ou um symlink para o repositório do módulo:

```bash
mkdir -p "${BRAIN_MODULES_DIR:-$HOME/.local/share/second-brain/modules}"
ln -s ~/projetos/meu-modulo "${BRAIN_MODULES_DIR:-$HOME/.local/share/second-brain/modules}/meu-modulo"
```

Alternativa: `modules.<id>.path` na config do vault (aceita `~` e `$VAR`), para quem não sincroniza o vault entre máquinas.

`BRAIN_MODULES_DIR` e `modules.<id>.path` precisam ser **absolutos** depois da expansão de `~` e `$VAR`: um caminho relativo
seria resolvido pela pasta atual de cada processo (o `serve` e o MCP divergem). Relativo deixa o módulo `ausente` com a causa
("BRAIN_MODULES_DIR deve ser absoluto", "modules.<id>.path deve ser absoluto").

## Configuração no vault

A chave `modules` do `.brain/config.yaml` diz quais módulos estão ligados e a configuração de cada um:

```yaml
modules:
  lembrete:
    enabled: true
    host: meu-desktop        # opcional: só esta máquina inicia o módulo e roda as tarefas
    ia_max_usd_dia: 2        # opcional: teto diário de IA (padrão 2)
    config: { horario: "10:00" }
```

- `config` passa pelo `configSchema` do módulo. Config inválida deixa o módulo `falho` com a mensagem do zod.
- A config também passa pelo detector de segredos: um achado bloqueia o carregamento. **Não coloque segredo na config.**
  O módulo obtém segredos por conta própria (variável de ambiente, cofre do sistema). O second-brain não oferece API de
  segredos.
- **Mudou a config de módulos: reinicie o `brain serve`.** Saúde avisa quando a config em disco difere da carregada.
- Módulo ligado mas sem pasta na máquina: aviso em Saúde, não erro fatal.
- Salvar Configurações na UI preserva a chave `modules`.

### Vault em mais de uma máquina

Se o vault é sincronizado e só uma máquina deve rodar o módulo (para a tarefa não disparar duas vezes), defina `host` com o
nome da máquina (`hostname`). Nas outras, o módulo aparece como "inativo nesta máquina": não roda `iniciar` nem tarefas. Sem
`host`, roda onde estiver instalado.

## O contrato do SDK

O pacote `@brain/module-sdk` tem só tipos e `defineModule` (identidade tipada). O módulo declara `sdk: 1`; o second-brain
recusa um `sdk` que ele não suporta.

```ts
import { defineModule } from "@brain/module-sdk";
import { z } from "zod";

export default defineModule({
  sdk: 1,
  id: "lembrete",
  nome: "Lembretes",
  versao: "0.1.0",
  configSchema: z.object({ horario: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/) }),
  aba: { titulo: "Lembretes", pasta: "ui" },
  rotas: [/* ... */],
  tarefas: [/* ... */],
  ferramentasMcp: [/* ... */],
  iniciar: async (ctx) => {},   // opcional: no serve, depois de validar a config (limite de 30 s)
  parar: async () => {},        // opcional: no desligamento (limite de 5 s)
});
```

O `ModuleContext` (`ctx`) tem só isto:

| Campo | Para quê |
|---|---|
| `id`, `config` | id do módulo e o bloco `config` já validado |
| `brain` | fachada de conhecimento: `search`, `context`, `get`, `similar`, `propose`, `amend` |
| `estado` | pasta própria e helpers de JSON (ver Estado) |
| `ia` | `ia.completar(...)` (ver IA) |
| `avisar(a)`, `badge(n)` | avisos e contador (ver Avisos e contador) |
| `log` | `log.info`, `log.erro` |

`ctx.brain` grava como `module/<id>`, com o mesmo poder de um agente (ADR 0013): propõe, nunca decide proposta alheia, nem
escreve nota direto. Tudo aparece na linha do tempo com esse ator. Um módulo nunca age como humano.

### zod 4

O módulo traz a própria cópia do **zod 4** (`"zod": "^4"` nas dependências). O second-brain nunca usa `instanceof`: valida
todo schema pela interface Standard Schema (`~standard.validate`), que o zod 4 implementa. Onde o second-brain precisa de
JSON Schema (entrada de ferramenta MCP), o módulo o fornece, com `z.toJSONSchema`.

## Rotas e quem pode chamá-las

Rotas ficam em `/api/modules/<id>/<caminho>`. O handler recebe `{ metodo, params, query, body, chamador }` e o `ctx`, e
devolve o JSON da resposta. Erro lançado vira `500 {"error":"module_error"}` e vai para Saúde; módulo falho responde
`503 {"error":"module_unavailable"}`. O handler não escolhe o status HTTP: o que não for sucesso volta no corpo (o `lembrete`
devolve `{ ok: false, erro }` para um item inexistente).

```ts
{
  metodo: "POST",
  caminho: "/itens/:id/feito",
  humano: true,
  async rodar(req, ctx) { /* req.params.id, req.chamador */ },
}
```

### Matriz de credenciais

| Credencial | Rotas de módulo | `chamador` |
|---|---|---|
| Sessão humana da UI | todas, exceto `_mcp` | `{ via: "ui", humano: true }` |
| Token de página (emitido só para sessão humana) | só as rotas do próprio módulo, exceto `ui-token`, `_mcp` e `_tarefas` | `{ via: "pagina", humano: true }` |
| api-token do vault (agentes, scripts, processo MCP) | só `POST .../_mcp/<ferramenta>` e `GET /api/modules` | `{ via: "mcp", humano: false }` |
| Credencial do desktop | nenhuma rota de módulo (só o assistente, `GET /api/health`, `GET /api/notifications` e `POST /api/notifications/<id>/visto`) | n/a |

"api-token" é sempre o token **local** do second-brain (`<stateDir>/api-token`), usado por processos da máquina para falar com
o `serve`. Não tem relação com a Anthropic.

### `humano: true` e `chamador.humano`

`chamador.humano` é a **única prova de humano** que o módulo deve usar. Nunca confie em cabeçalho, em nome de agente ou em
campo do corpo. **Toda rota que dispare ação externa** (enviar mensagem, executar algo fora do second-brain) deve declarar
`humano: true`: o second-brain recusa com `403` quem não for humano, antes de chamar o handler. Um agente local com o api-token
não consegue acionar essa rota.

O `_mcp` não repassa o nome do agente: `chamador` traz só `via: "mcp"`.

## Aba na UI

`aba: { titulo, pasta }` publica a pasta (relativa à raiz do módulo, com `index.html`) em `/modules/<id>/`. O módulo aparece
no menu lateral, entre os itens do core e Configurações, com o contador (`badge`). Módulos sem `aba` não aparecem no menu.

A página roda num iframe com origem opaca (`sandbox="allow-scripts allow-forms"`, sem `allow-same-origin`):

- ela **não** acessa a janela, o armazenamento nem a sessão do second-brain;
- chama a API com um **token de página**, curto, só em memória e só para as rotas do próprio módulo; ele morre junto com a
  sessão humana que abriu a aba (revogada ou expirada);
- a CSP (`default-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:;
  frame-ancestors 'self'; form-action 'self'; sandbox allow-scripts allow-forms`) não permite script inline: todo JavaScript
  fica em arquivo (`<script type="module" src="app.js">`); `fetch` e formulários só vão ao próprio second-brain;
- **links externos não funcionam dentro da aba**: se o iframe sair da página do módulo (link, formulário, `location = ...`),
  o second-brain corta o acesso da aba e mostra "Recarregar a aba". Para mudar de tela use `navegar(resto)`; para abrir uma
  nota, `abrirNota(id)`;
- renderize dado com `textContent`, nunca com `innerHTML`.

O SDK traz dois arquivos estáticos opcionais, servidos pelo second-brain:

```html
<link rel="stylesheet" href="/modules/_sdk/base.css">   <!-- tokens de cor e tipografia, claro/escuro -->
<script type="module" src="app.js"></script>
```

```js
import { conectar } from "/modules/_sdk/brain-module-client.js";

const sb = await conectar();                              // handshake com o second-brain
const { itens } = await sb.api("/api/modules/lembrete/itens");
await sb.api(`/api/modules/lembrete/itens/${id}/feito`, { method: "POST" });
```

`conectar()` devolve `resto` (o trecho da URL depois de `#/m/<id>/`, como o `link` de um aviso), `api(caminho, init)`,
`navegar(resto)`, `abrirNota(id)` e `aoMudarTema(fn)`. A renovação do token é automática.

## Tarefas agendadas

```ts
{ id: "diario", quando: "0 10 * * *", recuperar: true, timeoutS: 300, async rodar(ctx) { /* ctx.ocorrencia, ctx.sinal */ } }
```

- `quando` é cron de 5 campos, na hora local da máquina. O agendador roda só no `brain serve`.
- `recuperar: true`: se a máquina estava desligada na hora, a tarefa roda **uma vez** ao subir ou ao acordar da suspensão, não
  uma por ocorrência perdida. Na primeira subida sem histórico não há recuperação.
- `ctx.ocorrencia` é a data/hora prevista a que a execução se refere. `ctx.sinal` é um `AbortSignal`: o timeout (`timeoutS`,
  padrão 300) cancela por ele. **O timeout não mata o código:** a execução é dada como encerrada (resultado `timeout`), mas o
  que a tarefa ainda estiver fazendo continua rodando no `serve` até terminar. Repasse `ctx.sinal` a `fetch` e a toda espera
  longa, e confira `ctx.sinal.aborted` entre etapas, para parar de verdade.
- Uma tarefa não começa se a anterior ainda roda. Cinco erros seguidos suspendem a tarefa até reiniciar o `serve` ou rodar
  manualmente.
- **Uma ocorrência conta como atendida assim que a execução começa.** Falha, timeout ou queda do processo **não** geram nova
  tentativa automática: o second-brain não sabe se a ação externa já saiu. O resultado aparece em Saúde e o dono usa "rodar
  agora".

### Idempotência por `ocorrencia`

Por isso a tarefa deve ser **idempotente por `ocorrencia`**: grave em `ctx.estado` o que já fez para aquela ocorrência e pule
o que já saiu. O `lembrete` usa o dia local da `ocorrencia` como chave:

```ts
const dia = diaLocal(ctx.ocorrencia);          // AAAA-MM-DD
const id = `dia-${dia}`;
await ctx.estado.lock("itens.json", async () => {
  const atuais = ctx.estado.lerJson<Item[]>("itens.json") ?? [];
  if (atuais.some((i) => i.id === id)) return;  // já feito para este dia
  ctx.estado.gravarJson("itens.json", [...atuais, novoItem]);
});
```

### Rodar agora

- UI: `POST /api/modules/<id>/_tarefas/<tarefa>/rodar`, só com sessão humana (a tarefa pode causar ação externa; nem o token
  de página nem o api-token servem). O corpo aceita `{ "ocorrencia": "<data ISO>" }`; sem ele vale a última ocorrência
  atendida.
- Terminal: `brain modules run <id> <tarefa> [--ocorrencia AAAA-MM-DD]`. Exige terminal interativo (TTY) e prova de humano
  (com frase-senha, se `review.passphrase_required`). Emite uma sessão humana de 5 minutos, chama o `serve` por HTTP e a
  revoga ao terminar. A tarefa roda no `serve`, nunca no processo da CLI. Sem TTY, recusa.

## Avisos e contador

```ts
await ctx.avisar({ titulo: "Lembrete do dia", link: `item/${id}`, chave: `dia-${dia}` });
ctx.badge(3);   // pendências do módulo
```

- `avisar({ titulo, corpo?, link?, chave? })` grava o aviso. O app desktop o mostra como notificação nativa; um aviso não
  visto fica guardado. `link` é **relativo à aba**: vira `#/m/<id>/<link>` e a página o recebe em `sb.resto`. Caminho absoluto,
  `//host` e esquema (`https:`) são recusados.
- `chave` deduplica: um aviso novo com a mesma chave substitui o anterior ainda não visto. Use uma chave por assunto
  (`dia-2026-11-11`) para que reexecuções não acumulem avisos.
- Título, corpo, link e chave passam pelo detector de segredos.
- `badge(n)` é o **estado** de pendências, não um evento: aparece no menu da UI, em `GET /api/modules` e, somado, no ícone da
  bandeja do desktop. Chame de novo a cada mudança.

## Estado

`ctx.estado.dir` é uma pasta exclusiva do módulo, **fora do vault** (`<stateDir>/modules/<id>/`; sem `state.external`, em
`~/.local/state/second-brain/<slug do vault_name>-<impressão do caminho do vault>/modules/`, ou em
`$BRAIN_STATE_DIR/modules/`). O estado nunca viaja pelo sync do vault e nunca é dividido entre vaults: a pasta guarda o dono
em `vault-path`, e outro vault apontando para ela é recusado. Mover a pasta do vault muda a impressão (o estado dos módulos
recomeça vazio; copie a pasta antiga se precisar). O second-brain não interpreta o conteúdo.

- `lerJson(nome)` e `gravarJson(nome, valor)` (escrita atômica);
- `lock(nome, fn)`: exclusão mútua em volta de leitura + gravação. Use sempre que ler e depois gravar, porque rota e tarefa
  podem rodar ao mesmo tempo.

## IA: `ia.completar`

```ts
const r = await ctx.ia.completar({ prompt: "...", schemaJson, timeoutS: 30, orcamentoUsd: 0.1, comNotas: false });
if (r.ok) usar(r.dados); else ctx.log.erro(r.mensagem);   // r.tipo: auth | timeout | orcamento | erro
```

- Roda pelo `claude -p` da máquina, com o **login da assinatura do Claude** (o mesmo do assistente, `claude setup-token`).
  Nenhuma chave de API é necessária nem lida.
- Sem `comNotas`, o Claude roda **sem nenhuma ferramenta**. Com `comNotas: true`, ele ganha as ferramentas de leitura do vault,
  com o ator `module/<id>`.
- Os valores em US$ (`orcamentoUsd`, `custoUsd`, o teto diário) são **estimativas** do `claude`. Na assinatura servem como
  freio de consumo da cota, não como cobrança.
- Há um teto por chamada (`assistant.max_budget_usd`) e um **teto diário por módulo**, `modules.<id>.ia_max_usd_dia` (padrão
  2). Acima dele a chamada volta `{ ok: false, tipo: "orcamento" }`. O gasto do dia aparece em Saúde.
- Trate a IA como opcional: sem motor, sem login ou acima do teto, `ok` é `false`. O `lembrete` a deixa **desligada por padrão**
  (`config: { ia: true }` a liga): ligada, usa a assinatura do `claude` uma vez por dia, e se falhar o aviso sai sem corpo. Gaste a
  cota do dono só com o que ele ligou.

## Ferramentas MCP

```ts
{
  nome: "listar",
  descricao: "Lista os lembretes (todos, ou só os pendentes).",
  entrada: entradaListar,                                   // schema zod 4
  entradaJson: z.toJSONSchema(entradaListar),               // type "object"
  async rodar(args, ctx) { /* ... */ },
}
```

- O nome registrado é `<id>_<nome>` (`lembrete_listar`). O prefixo `brain_` é reservado ao core, e nome repetido recusa a
  ferramenta do módulo, nunca a do core.
- O processo `brain mcp` importa só as **definições** (não chama `iniciar`) para registrar as ferramentas. A **execução
  acontece no `serve`**: o MCP chama `POST /api/modules/<id>/_mcp/<nome>` com o api-token, e a resposta é
  `{ resultado, chamador }` com `chamador = { via: "mcp", humano: false }`. O estado do módulo tem um único dono.
- Com o `serve` fora do ar, a ferramenta responde que o `brain serve` não está rodando.
- Ferramenta de leitura é o caso natural. Ação externa não deve ficar em ferramenta MCP, pois o chamador não é humano.

## Isolamento de falhas

- Erro no `import()` ou no `iniciar()`: o módulo fica `falho` com a causa, o `serve` sobe e os outros módulos funcionam.
- `iniciar()` que estoura os 30 s também deixa o módulo `falho`, mas **o código dele continua rodando em segundo plano** (o
  second-brain não consegue interrompê-lo) e `parar()` **não** é chamado, porque o módulo nunca ficou ativo. Não deixe
  `iniciar` esperar por rede ou por tarefas longas: abra conexões sob demanda ou com timeout próprio.
- Erro em rota, tarefa ou ferramenta: capturado e registrado (os últimos 50 por módulo); o módulo continua ativo.
- Limite da abordagem: um **laço síncrono infinito** ou um **`process.exit`** no módulo derrubam o `serve`. Evite os dois.
- Saúde (UI) e `brain doctor` mostram, por módulo: status, versão, `sdk`, pasta, tarefas (próxima e última execução), erros
  recentes e gasto de IA do dia. `brain modules list` mostra o resumo no terminal (status, versão, gasto de IA, tarefas e
  erros).

## Verificar: `brain modules check`

```bash
brain modules check ./meu-modulo
```

Valida o módulo **sem ligá-lo**: carrega o `package.json#exports`, confere o contrato, o `sdk`, o `id`, o schema, as
ferramentas MCP (nome, `entradaJson`), as tarefas (cron) e se a pasta da aba tem `index.html`. Rode antes de configurar o
módulo no vault e a cada mudança de contrato.

## Distribuir o SDK

O `@brain/module-sdk` não está publicado. O módulo de fora o usa só para os tipos e `defineModule`. Três formas de trazê-lo, nesta
ordem de preferência:

1. **`file:` para um clone local** do second-brain. Rode `pnpm install && pnpm build` no clone antes, para existir o `dist/`:

   ```json
   { "dependencies": { "@brain/module-sdk": "file:../second-brain/packages/module-sdk" } }
   ```

2. **Dependência git com subcaminho**, só a partir de uma tag ou commit que inclua o `dist/` já gerado. A sintaxe `#path:` é do
   pnpm (o npm não a entende). O `dist/` não é versionado neste repositório e o pacote não compila sozinho fora do clone (o
   `tsconfig` estende o `tsconfig.base.json` da raiz e não há `typescript` nas dependências dele), então sem esse `dist/`
   o TypeScript não acha os tipos:

   ```json
   { "dependencies": { "@brain/module-sdk": "git+https://<repositório do second-brain>.git#<tag>&path:/packages/module-sdk" } }
   ```

3. **Copiar os tipos** para o módulo. O SDK quase não tem runtime (só `SDK_VERSION` e `defineModule`), então é aceitável.

Dentro deste repositório, o exemplo usa `workspace:*`.
