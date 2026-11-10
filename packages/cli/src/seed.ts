import { Brain, principal, seedPrincipal } from "@brain/core";
import { rmSync, existsSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// vault DEMO: o seed escreve notas direto pelo canal "seed", que o Core só aceita num vault marcado como DEMO
const user = seedPrincipal();
const claude = principal("agent", "claude-code", "mcp");
const codex = principal("agent", "codex", "mcp");
const demo = { type: "other" as const, ref: "DEMO SEED — dados fictícios" };

/** Gera um vault DEMO claramente separado. Todos os fatos aqui são inventados. */
export async function seedDemo(root: string, tpl: { agentsMd?: string; skillMd?: string; readme?: string }): Promise<void> {
  // nunca apaga um diretório que não seja um vault DEMO (ex.: `brain seed ~/second-brain` por engano)
  if (existsSync(root)) {
    const empty = readdirSync(root).length === 0;
    if (!empty && !existsSync(join(root, ".brain", "DEMO"))) throw new Error(`recusado: ${root} existe e não é um vault DEMO (o seed só recria vaults criados por ele)`);
    rmSync(root, { recursive: true, force: true });
  }
  const b = await Brain.init(root, tpl);
  writeFileSync(join(root, ".brain", "DEMO"), "vault de demonstração criado por `brain seed` — dados fictícios\n");
  const n = (title: string, type: Parameters<Brain["createNote"]>[0]["type"], project: string | undefined, body: string, tags: string[] = []) =>
    b.createNote({ title, type, project, body, tags: ["demo", ...tags], source: demo, confidence: "medium" }, user);

  await b.createProject("promo-watcher", "Promo Watcher (demo)", "Projeto fictício: monitora promoções em marketplaces e notifica via Telegram.", user);
  await b.createProject("menu-litoral", "MenuLitoral (demo)", "Projeto fictício: cardápio digital para restaurantes do litoral.", user);
  await b.createProject("second-brain", "Second Brain (demo)", "Camada de memória compartilhada entre humanos e agentes.", user);

  const a = await n("Resolução de identidade de listings", "decision", "promo-watcher", "Um listing é identificado por `marketplace + product_id canônico`, nunca pela URL.\n\n**Por quê:** a mesma oferta aparece com URLs diferentes (afiliados, parâmetros de rastreio).\n\n**Como aplicar:** normalizar a URL antes de resolver o id.", ["marketplace", "identity-resolution"]);
  const c = await n("Marketplaces suportados", "concept", "promo-watcher", "Mercado Livre e Shopee são os marketplaces da V1 (demo).", ["marketplace"]);
  await b.link(a.id, c.id, "applies_to", user);
  await n("Notificações via fila durável", "decision", "promo-watcher", "Notificações passam por fila durável com retry exponencial.\n\n**Por quê:** evitar perda quando o Telegram limita requisições.", ["telegram", "queue"]);
  await n("Versão do Python do projeto", "fact", "promo-watcher", "O projeto utiliza Python 3.12 em produção.", ["python"]);
  await n("Janela de cancelamento de pedidos", "decision", "menu-litoral", "Pedidos podem ser cancelados até 5 minutos após a confirmação.", ["pedidos"]);
  await n("Preço por fuso de maré", "learning", "menu-litoral", "Cardápios sazonais têm pico aos fins de semana de verão; cachear por 10 minutos.", ["cache"]);
  await n("Commits pequenos e descritivos", "preference", undefined, "Prefiro commits pequenos, com mensagem no imperativo e escopo claro.", ["git"]);
  await n("Testes de integração antes de mocks", "preference", undefined, "Preferir testes de integração a mocks excessivos; mockar apenas bordas externas.", ["testing"]);
  await n("Markdown é a fonte de verdade", "decision", "second-brain", "SQLite e embeddings são índices derivados e reconstruíveis; o Markdown no Git é a fonte primária.", ["architecture"]);
  const q = await n("Como lidar com timeouts de scraping?", "open-question", "promo-watcher", "Ainda não decidimos o orçamento de timeout por marketplace; quando sair, a decisão vai para o Second Brain.", ["scraping"]);
  const rel = (from: string, to: string, t: "applies_to" | "related_to") => { const a = b.db.getRow(from); const c = b.db.getRow(to); return a && c ? b.link(a.id, c.id, t, user) : undefined; };
  await rel("decision-promo-watcher-notificacoes-via-fila-duravel", "project-promo-watcher", "applies_to");
  await rel(q.id, "decision-second-brain-markdown-e-a-fonte-de-verdade", "related_to");
  await rel("fact-promo-watcher-versao-do-python-do-projeto", "project-promo-watcher", "applies_to");
  await rel("decision-menu-litoral-janela-de-cancelamento-de-pedidos", "project-menu-litoral", "applies_to");

  // propostas pendentes para demonstrar a Review Queue
  await b.propose({ title: "Python do projeto", type: "fact", project: "promo-watcher", body: "Versão Python do projeto: 3.12", reason: "reconfirmado no CI" }, claude);
  await b.propose({ title: "Versão do Python do projeto", type: "fact", project: "promo-watcher", body: "O projeto utiliza Python 3.13 em produção." }, codex);
  await b.propose({ title: "Janela de cancelamento de pedidos", type: "decision", project: "menu-litoral", body: "Pedidos não podem ser cancelados até 5 minutos após a confirmação." }, codex);
  await b.propose({ title: "Mercado Livre /lists expõe vários product_ids", type: "learning", project: "promo-watcher", body: "Páginas /lists do Mercado Livre podem expor múltiplos product_ids; escolher pela precedência do campo melidata.", source: { type: "pr", repository: "promo-watcher", ref: "#12" }, reason: "armadilha na resolução de listings", confidence: "high" }, claude);
  await b.propose({ title: "Usar WAL no SQLite do índice", type: "pattern", project: "second-brain", body: "O índice SQLite usa WAL com busy_timeout para suportar vários processos MCP lendo e escrevendo.", intent: "new", confidence: "high" }, claude);

  await b.search("listing identidade", {}, 5, claude);
  await b.context({ project: "promo-watcher", topic: "notificações" }, codex);
  b.close();
}
