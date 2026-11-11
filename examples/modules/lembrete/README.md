# lembrete

Módulo de exemplo do second-brain. Mostra, em pouco código, todos os pontos de extensão: aba na UI, rotas, tarefa agendada
com recuperação, estado próprio, ferramenta MCP, aviso e contador, e uso opcional da IA. Os testes de integração
(`packages/cli/test/modules-e2e.test.ts`) sobem o `serve` com ele. O guia de autoria é `docs/modules.md`.

## O que faz

- Tarefa `diario` (todo dia às 10:00, com `recuperar: true`): cria o lembrete do dia, avisa o dono e atualiza o contador.
  É idempotente: a chave é o dia local da `ocorrencia`.
- `GET /api/modules/lembrete/itens` lista os lembretes. `POST /api/modules/lembrete/itens/:id/feito` marca como feito e só
  aceita humano (`humano: true`).
- Ferramenta MCP `lembrete_listar`.
- Aba "Lembretes": lista os itens e tem o botão "feito" (`ui/index.html` + `ui/app.js`, JS puro, sem bundler).

## Instalar

O módulo é compilado (o second-brain não compila módulos). Dentro deste repositório:

```bash
pnpm install
pnpm --filter @brain/example-lembrete build   # gera dist/
```

Depois use **uma** das duas formas de apontar o second-brain para a pasta:

1. Symlink na pasta de módulos da máquina (o nome da pasta é o `id`):

   ```bash
   mkdir -p "${BRAIN_MODULES_DIR:-$HOME/.local/share/second-brain/modules}"
   ln -s "$PWD/examples/modules/lembrete" "${BRAIN_MODULES_DIR:-$HOME/.local/share/second-brain/modules}/lembrete"
   ```

2. `path` no `.brain/config.yaml` do vault (aceita `~` e `$VAR`):

   ```yaml
   modules:
     lembrete:
       enabled: true
       path: /caminho/para/second-brain/examples/modules/lembrete
       config: { horario: "10:00" }
   ```

Com o symlink, só a chave `modules.lembrete` com `enabled` e `config` basta. Reinicie o `brain serve`.

## Verificar

```bash
pnpm brain modules check examples/modules/lembrete
pnpm brain modules list
```

`check` valida o contrato sem ligar o módulo. `list` mostra o estado no `serve` em execução.
