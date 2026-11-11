# FUTURE — deliberadamente fora da V1

Deixado de fora **de propósito** para não virar feature creep. Entra quando houver necessidade concreta.

**Interface / desktop**
- Shell desktop (Tauri 2 ou Electron — critérios no ADR 0009): bandeja, atalho global (`Ctrl+Alt+Space`), janela quick-access estilo Raycast/Spotlight, clipboard. Será um cliente fino da API; nada disto vai para o Core.
- PWA instalável; atalhos de teclado adicionais (`g h`, `j/k` na fila).
- Grafo avançado (filtros por relação, clusters, minimapa); hoje é layout simples sem zoom.
- Diff semântico (hoje: diff por linha + prévia heurística).
- Edição WYSIWYG; anexos/imagens.

**Conhecimento / governança**
- Provider de embeddings local "de verdade" (ex.: ONNX/transformers.js ou Ollama) empacotado e com cache; reranker.
- Classificação com LLM (opt-in) para paráfrases/conflitos semânticos; hoje: heurística explicável (números/negação).
- Detecção de obsolescência guiada por código (comparar com repo/commit referenciado).
- Fusão automática de duplicatas já existentes; limpeza em lote.
- Políticas por projeto/agente (hoje global), expiração (`review_after`), níveis de confiança por agente.
- Importadores (Basic Memory, Obsidian vault existente, histórico de chats).
- Múltiplos vaults / vault de equipe com merge de propostas entre máquinas.

**Importação**
- Extrator de conversas exportadas (ChatGPT/Claude/Codex) e provider LLM opcional para extração — ambos só precisam produzir `Candidate[]`.
- Importação incremental por `git diff` (só o que mudou desde o último import) e detecção de documentos que ficaram obsoletos.

**Integração**
- MCP sobre HTTP (streamable) com OAuth para ChatGPT/clientes remotos; hoje stdio local.
- Hooks (`SessionStart`/`Stop`) de Claude Code/Codex para recuperar/propor automaticamente.
- Resources/prompts MCP (`brain://nota/<id>`).
- Assinatura de commits, criptografia do vault em repouso.

**Grafo e governança (registrado em 2026-10-14)**
- Vizinhos por semelhança no grafo devem ser **derivados** (calculados na hora, com um toggle "Relações explícitas × Vizinhos semelhantes"). Nunca gravar `similar_to` no Markdown só porque um embedding deu nota alta.
- Isolamento real entre agentes e revisor: rodar os agentes com outro usuário do SO (ou contêiner), para que o vault e a frase-senha não sejam legíveis por eles (ADR 0013, modelo de ameaça).
- Revalidação periódica agendada (hoje `brain revalidate` é sob demanda) e gatilhos por evento vindos de CI/deploy.

**Módulos (fora do escopo do sistema de módulos, spec de 2026-11-11 §3)**
- Marketplace, descoberta ou instalação remota de módulos.
- Isolamento de processo ou sandbox do código do módulo no servidor (hoje: código instalado pelo dono, ADR 0015).
- Recarregar módulo sem reiniciar o `brain serve`.
- Módulos em outras linguagens.
- Comunicação entre módulos.
- Janelas próprias de módulo no app desktop (o desktop só mostra avisos e abre a UI).

**Operação**
- Empacotamento (instalador, `npx`), auto-update, telemetria zero por padrão.
- Escalar a busca vetorial (HNSW/sqlite-vec) acima de ~50 mil notas.
