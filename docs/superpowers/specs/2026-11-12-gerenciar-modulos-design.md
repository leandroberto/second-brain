# Gerenciar módulos pela UI: adicionar, configurar, ligar/desligar e remover

Data: 2026-11-12 · Status: proposta (aguarda aprovação do dono)

## 1. Intenção e porquê

Hoje um módulo só entra no second-brain editando `.brain/config.yaml` à mão (`modules.<id>`), rodando
`brain modules check` e reiniciando o `brain serve`. O dono quer fazer isso pela UI: "entra no brain, vai em Módulos,
adiciona novo, seleciona a pasta e dá OK". O primeiro uso real é o módulo de horas, desenvolvido em outro repositório e
clonado dentro do WSL.

Gerenciar é coisa rara; usar o módulo é diária. Por isso o gerenciamento fica em **Configurações**, e o menu lateral continua
mostrando só os módulos em si (as abas deles), como hoje.

Base: o sistema de módulos já está na `main` (ADR 0015, `docs/modules.md`, spec `2026-11-11-modulos-design.md`).

## 2. Objetivos

1. Uma página **Configurações › Módulos** com a lista dos módulos configurados e o botão **+ Adicionar módulo**.
2. **Adicionar** em um passo a passo de 4 etapas, com "Voltar" e "Continuar":
   1. **Pasta:** navegador de pastas do WSL (servido pelo `serve`), começando em `~/projetos` (ou `~` se não existir); marca
      "módulo provável" nas pastas que parecem módulos (leitura estática do `package.json`, sem executar nada); campo para
      colar o caminho. Ao clicar **Continuar**, aparece o aviso de confiança **antes de qualquer código rodar**: "Para
      conferir, o código desta pasta será carregado no seu computador. Continue só com módulos em que você confia." Se houver
      frase-senha de revisor, ela é pedida aqui.
   2. **Conferir:** nome, versão, id, `sdk` compatível e, em destaque, **o que o módulo vai fazer**: aba no menu, tarefas
      agendadas (com quando rodam, em linguagem simples), ferramentas MCP (nomes `<id>_<nome>`), rotas (quantas e quantas com
      `humano: true`, descritas como "agem fora, só com você logado"), uso de IA (teto diário) e que propõe notas como
      `module/<id>`. Se a pasta não é um módulo válido, mostra as causas (as mesmas de `brain modules check`) e não deixa
      continuar.
   3. **Configurar:** os campos que o próprio módulo declara, com o erro ao lado do campo, mais "Só nesta máquina"
      (grava `host` com o hostname atual).
   4. **Confirmar:** resumo (módulo, pasta, campos configurados) e o botão **Adicionar e reiniciar o serve** (o aviso de
      confiança já foi aceito na etapa 1).
   Depois do OK: "Módulo adicionado. O brain serve será reiniciado para aplicar as alterações." O `serve` se reinicia sozinho
   e a página volta quando ele estiver no ar.
3. **Lista dos instalados**, um cartão por módulo: nome, versão, situação (ativo · desligado · falho com o motivo e uma dica ·
   inativo nesta máquina · ausente), pasta, próxima/última execução de cada tarefa com o resultado, gasto de IA do dia.
   Ações: **Configurar** (os mesmos campos da etapa 3), **Ligar/Desligar**, **Rodar agora** (já existe), **Ver erros**,
   **Remover**; módulo falho também tem **Tentar de novo** (reinicia o serve).
4. Salvar configuração, Ligar, Desligar, Remover e Tentar de novo **pedem confirmação** ("… O brain serve será reiniciado") e
   reiniciam o `serve`.
5. **Remover** só tira `modules.<id>` da configuração. A pasta e o estado do módulo ficam no disco; adicionar de novo recupera
   tudo.

## 3. Não-objetivos

- Instalar a partir de link do git, URL ou marketplace; baixar código pela tela.
- Atualizar o módulo (`git pull`, build) pela tela.
- Carregar/descarregar módulo sem reiniciar o `serve` (continua fora, como no spec de módulos).
- Editar o código ou os arquivos do módulo.
- Pasta do lado Windows (`C:\…`): o dono clona os módulos no WSL; caminhos `/mnt/c/...` funcionam se colados, mas o
  navegador de pastas não é pensado para o disco do Windows.

## 4. Anti-objetivos (falha mesmo que funcione)

- Uma sessão roubada no navegador conseguir **adicionar ou ligar** um módulo sem a frase-senha, quando ela existe.
- Agente local (api-token), desktop ou página de módulo conseguir gerenciar módulos.
- Um caminho na API **contornar** estas regras (ex.: `PUT /api/settings` gravando `modules` direto).
- Apagar a pasta ou o estado de um módulo.
- Um clique sem querer reiniciar o `serve` sem confirmação.
- O menu lateral ganhar itens de gerenciamento.

## 5. Restrições

- Mesmo stack e padrões do repo (TypeScript estrito, zod 4, vitest, React/Vite, pnpm). Sem dependência nova pesada.
- Repositório público: nada privado em código, testes ou docs (o módulo de horas é citado só como cenário, sem detalhes).
- Sem módulos configurados, o comportamento atual não muda (a página só mostra a lista vazia e o "+ Adicionar").
- A validação do módulo é a mesma de `brain modules check` (hoje `checarModulo` em `packages/cli/src/modules.ts:217`): uma
  regra só, usada pela CLI e pela API.
- O `serve` roda no WSL e a UI num navegador do Windows: o navegador não entrega caminho de pasta, então a escolha da pasta é
  feita por uma API do `serve` que lista diretórios.
- Gravação no `config.yaml` sempre pela fachada `Brain` (`updateConfig` ou função equivalente com o mesmo lock e auditoria).

## 6. Decidido com o dono

- Gerenciamento em Configurações › Módulos; menu só com os módulos em si.
- Passo a passo de 4 etapas, com a etapa "Conferir" mostrando o que o módulo faz.
- Configuração do módulo preenchida na tela (formulário), na etapa 3 e em "Configurar".
- Depois do OK, o `serve` reinicia sozinho, com a mensagem "Módulo adicionado. O brain serve será reiniciado para aplicar as
  alterações."
- Lista com Configurar, Ligar/Desligar, Rodar agora, Ver erros, Remover (e Tentar de novo no falho); confirmação antes de
  reiniciar.
- Remover não apaga pasta nem estado.
- Prova de humano: **adicionar e ligar** exigem sessão humana `full`; **se houver frase-senha de revisor, ela é pedida**;
  sem frase-senha, estar logado como humano basta. Configurar, desligar, remover e tentar de novo exigem só sessão humana
  `full`.
- O aviso de confiança (e a frase-senha, quando existir) vem no **Continuar da etapa 1**, antes de o código do módulo ser
  carregado para a conferência; a etapa 4 fica só com o resumo e o botão.
- A conferência carrega o módulo num **processo separado e descartável**, sem mexer no `serve` em execução.
- Fora: instalar por link/URL, atualizar pela tela, recarregar sem reiniciar.

## 7. Decisões técnicas do autor do design (o dono pode reverter)

1. **Reinício do serve sem depender de systemd:** o `serve` sobe uma cópia nova de si mesmo (mesmo executável, argumentos,
   ambiente e diretório), destacada, e encerra a atual pelo mesmo caminho do SIGTERM (para agendador e módulos, libera
   `serve.lock`, apaga `serve.json`); a nova espera o lock/porta liberar. Sob systemd (`INVOCATION_ID` presente), em vez
   disso encerra com código que a unit reinicia (a unit do repo passa a ter `Restart=always` ou o builder escolhe o código
   adequado a `on-failure`). A UI mostra "reiniciando…" e consulta `GET /api/health` até voltar, depois recarrega a página.
   Falha em subir a cópia nova → o processo atual **não** encerra e a UI mostra o erro. A cópia usa `process.execPath` e os
   mesmos `process.execArgv`/`process.argv`, então funciona também quando o `serve` foi iniciado por `pnpm brain serve` ou
   `scripts/start.sh`. Iniciado em primeiro plano num terminal, a cópia nova fica destacada e grava a saída em
   `<diretório de estado>/serve.log` (o terminal original volta ao prompt e mostra onde está o log); isso é aceitável porque o
   dono não sabe/não precisa saber como o serve foi iniciado. A unit do repo continua válida; o caminho do systemd é a
   contingência, não o principal.
2. **Rotas novas, todas só para sessão humana `full`** (credencial checada antes do roteamento, como a matriz atual; api-token,
   desktop e token de página → 403):
   - `GET /api/fs/pastas?caminho=` → lista subpastas (nome, se é módulo provável) de um diretório absoluto; padrão
     `~/projetos` ou `~`. Não lista arquivos, não segue para fora de caminhos absolutos válidos, esconde pastas ocultas por
     padrão.
   - `POST /api/modules/_gerenciar/inspecionar` `{ caminho, fraseSenha? }` → exige a frase-senha quando existir (é o momento
     em que o código passa a rodar). Roda a checagem num **processo filho descartável** (o mesmo binário da CLI, ex.: um
     subcomando interno de `brain modules check` com saída JSON), com estado em diretório temporário, sem `iniciar`, com
     timeout (ex.: 30 s) e sem herdar o api-token nem credenciais do serve além do necessário. Devolve: o resultado do check
     (id, nome, versão, sdk, causas), o resumo do que o módulo faz (aba, tarefas com `quando`, ferramentas, rotas e quantas
     `humano`, usa IA?), o formulário de configuração (item 4) e um **ticket de conferência** (aleatório, em memória, 15 min,
     ligado ao caminho real e à sessão que conferiu).
   - `POST /api/modules/_gerenciar/adicionar` `{ ticket, config, soNestaMaquina }` → exige ticket válido da mesma sessão (não
     pede a frase de novo), valida a config pelo `configSchema` no processo filho, recusa id já configurado, grava
     `modules.<id> = { enabled: true, path, config, host? }` e dispara o reinício.
   - `PUT /api/modules/_gerenciar/<id>` `{ config?, enabled?, soNestaMaquina?, fraseSenha? }` → configurar/ligar/desligar.
     Qualquer `PUT` que deixe `enabled: true` partindo de desligado (inclusive junto com `config`) é tratado como **ligar** e
     exige a frase-senha quando existir. Mudar só a `config` de um módulo já ligado exige só sessão `full` (decidido com o
     dono). A `config` é validada pelo `configSchema` no processo filho quando o módulo pode ser carregado; para módulo
     **falho ou ausente** (não carrega), "Configurar" abre o editor JSON com o aviso "não foi possível validar agora: a
     configuração será conferida quando o módulo voltar a carregar" e grava sem validar pelo schema (o detector de segredos
     continua valendo); ligar um módulo que não carrega é permitido (ele aparece falho/ausente depois do reinício, como hoje).
   - `DELETE /api/modules/_gerenciar/<id>` → remove a entrada da config (nunca toca disco do módulo).
   - `POST /api/modules/_gerenciar/reiniciar` → "Tentar de novo".
   `_gerenciar` não colide com id de módulo (a regex de id exige começar com letra).
3. **Frase-senha:** quando `hasReviewerPassphrase()` é verdadeiro, adicionar e ligar exigem `fraseSenha` válida
   (`checkReviewerPassphrase`, tempo constante; já existe em `packages/core/src/sessions.ts:141`). Erro → 403
   "frase-senha incorreta", sem dizer mais. Limite simples de tentativas (ex.: 5 por minuto por processo).
4. **Formulário da configuração:** o SDK ganha o campo opcional `configJson` (JSON Schema, gerado pelo módulo com
   `z.toJSONSchema`), sem mudar `SDK_VERSION` (é opcional). A UI renderiza campos para os tipos simples (string, número,
   booleano, enum, objeto raso); fora disso, ou sem `configJson`, mostra um editor de texto JSON. Em qualquer caso a validação
   final é a do `configSchema` (Standard Schema), e o detector de segredos continua recusando valores sensíveis. Credenciais
   nunca vão na config: o formulário mostra a `description` de cada campo (do `configJson`), e a recusa por segredo explica
   "use variável de ambiente ou o cofre do sistema; o módulo lê a credencial por conta própria" (regra do spec de módulos,
   §7.3). O exemplo `lembrete` passa a exportar `configJson`. O guia explica.
5. **Fechar o atalho:** `PUT /api/settings` passa a recusar as chaves `modules` e `review` (403 com mensagem apontando para a
   página Módulos / para o terminal). O `review.passphrase_required` hoje pode ser desligado pela UI, o que anularia a
   frase-senha. Conferido em 2026-11-12: a UI só grava `agents`, `embeddings`, `git`, `governance` e `retention` por essa rota
   (`apps/web/src/pages3.tsx`), e o `brain admin passphrase` grava `review` direto pelo `Brain.updateConfig`, não pela rota;
   nenhum uso existente quebra.
6. **Caminho gravado:** `path` absoluto, como digitado/escolhido (sem `~`), normalizado. Vault sincronizado entre máquinas:
   "Só nesta máquina" grava `host`; sem ele, o módulo aparece `ausente` nas máquinas onde o caminho não existe (comportamento
   atual).
7. **Auditoria:** cada ação de gerenciamento entra na atividade como ação humana (`config_update` com o id do módulo e a ação).
8. **Página:** substitui a seção Módulos atual de Configurações (`apps/web/src/pages3.tsx`) por uma página/rota própria dentro de
   Configurações; o resto de Configurações não muda.

## 8. Testes esperados

- Matriz de credenciais das rotas novas (api-token, desktop, token de página → 403; sessão `full` → ok).
- Frase-senha: com frase configurada, adicionar/ligar sem ou com frase errada → 403; com a certa → ok; sem frase configurada →
  ok só com sessão humana.
- `PUT /api/settings` com `modules` ou `review` → 403; outras chaves seguem funcionando.
- Inspecionar: módulo válido (resumo correto do `lembrete`), pasta que não é módulo, sdk errado, rota inválida.
- Adicionar: grava a entrada certa; id repetido → erro; segredo na config → recusado; reinício disparado.
- Remover não apaga a pasta nem o estado.
- Reinício: a cópia nova sobe e a antiga sai; falha ao subir a nova mantém a antiga; sob systemd, sai com o código esperado.
- `GET /api/fs/pastas`: só diretórios, sem ocultos por padrão, caminho relativo recusado.
- E2E no navegador: adicionar o `lembrete` pelo passo a passo, ver a aba aparecer depois do reinício, desligar, remover.

## 9. Fica com o builder

- Nomes finais de rotas e componentes (a forma do fluxo e as regras de segurança acima são fixas).
- Visual dos cartões e do passo a passo, seguindo o estilo atual de Configurações.
- Como detectar "módulo provável" no navegador de pastas (ex.: `package.json` com dependência do SDK ou `exports`).
- O mecanismo exato de troca de processo no reinício (desde que cumpra o item 7.1).
