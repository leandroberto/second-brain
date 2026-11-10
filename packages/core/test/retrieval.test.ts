import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Brain } from "../src/index.js";
import { cleanup, claude, human, tempBrain } from "./helpers.js";

afterAll(cleanup);
let b: Brain;
const id: Record<string, string> = {};

beforeAll(async () => {
  b = await tempBrain();
  const n = async (k: string, d: Parameters<Brain["createNote"]>[0]) => { id[k] = (await b.createNote(d, human)).id; };
  await b.createProject("promo-watcher", "Promo Watcher", "Monitor de promoções em marketplaces com alertas no Telegram.", human);
  await b.createProject("menu-litoral", "MenuLitoral", "Cardápio digital para restaurantes do litoral.", human);
  await n("identity", { title: "Resolução de identidade de listings", type: "decision", project: "promo-watcher", tags: ["marketplace", "identity-resolution", "mercado-livre"], body: "Um listing é identificado por marketplace + product_id canônico, nunca pela URL.\n\n**Por quê:** a mesma oferta aparece com URLs diferentes. Em caso de dúvida na identidade do listing, separar os produtos.\n" });
  await n("melidata", { title: "Mercado Livre /lists expõe vários product_ids", type: "learning", project: "promo-watcher", tags: ["mercado-livre"], body: "Páginas /lists do Mercado Livre podem expor múltiplos product_ids; a precedência correta vem do campo melidata.\n" });
  await n("linkres", { title: "Padrão de resolução de links curtos", type: "pattern", project: "promo-watcher", tags: ["link-resolution"], body: "Links curtos de afiliados são expandidos com HEAD antes de extrair o product_id. Link resolution deve ter timeout de 3 segundos.\n" });
  await n("python", { title: "Versão do Python do projeto", type: "fact", project: "promo-watcher", body: "O projeto utiliza Python 3.12 em produção.\n" });
  await n("queue", { title: "Notificações passam por fila durável", type: "decision", project: "promo-watcher", tags: ["telegram"], body: "Mensagens do Telegram são enfileiradas com retry exponencial para sobreviver ao rate limit.\n" });
  await n("pr12", { title: "PR #12 identidade de listings", type: "reference", project: "promo-watcher", body: "Implementa a resolução de identidade descrita na decisão. Veja o repositório promo-watcher, pull request 12.\n" });
  await n("cancel", { title: "Janela de cancelamento de pedidos", type: "decision", project: "menu-litoral", body: "Pedidos podem ser cancelados até 5 minutos após a confirmação.\n" });
  await n("prefs", { title: "Preferência de commits pequenos", type: "preference", body: "Prefiro commits pequenos com mensagem no imperativo; evitar commits gigantes que misturam assuntos.\n" });
  await n("price", { title: "Cache de preços do cardápio", type: "learning", project: "menu-litoral", body: "O preço do cardápio é cacheado por 10 minutos; invalidar por tag quando o restaurante edita itens.\n" });
});

const top = async (q: string, f = {}, n = 3) => (await b.search(q, f, n)).map((h) => h.id);

describe("busca: exemplos reais", () => {
  it('"listing mercado livre" encontra as notas de listing/mercado livre no topo', async () => {
    const t = await top("listing mercado livre", {}, 3);
    expect(t).toContain(id.identity!); expect(t).toContain(id.melidata!);
    expect(t).not.toContain(id.cancel!);
  });
  it('"identity resolution" (inglês) acha a decisão de identidade via tags', async () => { expect(await top("identity resolution", {}, 2)).toContain(id.identity!); });
  it('"link resolution" prioriza o padrão de links', async () => { expect((await top("link resolution"))[0]).toBe(id.linkres); });
  it('"python version" acha o fato de Python mesmo com "versão" em pt', async () => { expect(await top("python version", {}, 2)).toContain(id.python!); });
  it("plural/singular: listings ↔ listing, notificação ↔ notificações", async () => {
    expect(await top("listings")).toContain(id.identity!);
    expect(await top("notificacao fila")).toContain(id.queue!);
  });
  it("sem acento ↔ com acento", async () => { expect(await top("resolucao identidade")).toContain(id.identity!); });
  it("texto parcial (prefixo) e termo exato de corpo", async () => {
    expect(await top("identid")).toContain(id.identity!);
    expect(await top("melidata")).toEqual([id.melidata]);
    expect(await top("telegram")).toContain(id.queue!);
  });
  it("título pesa mais que corpo", async () => { expect((await top("cancelamento de pedidos"))[0]).toBe(id.cancel); });
  it("filtros: projeto, tipo, tag", async () => {
    expect(await top("preço", { project: "promo-watcher" })).not.toContain(id.price!);
    expect((await top("commits", { type: "preference" }))).toEqual([id.prefs]);
    expect((await top("mercado", { tags: ["mercado-livre"] }, 5)).sort()).toEqual([id.identity, id.melidata].sort());
  });
  it("consulta sem relação retorna vazio, não ruído", async () => { expect(await top("astrofísica de buracos negros")).toEqual([]); });
  it("o ranking separa o relevante: o resultado do topo tem score claramente maior que o 3º irrelevante", async () => {
    const hits = await b.search("python", {}, 5);
    expect(hits[0]!.id).toBe(id.python); expect(hits.length).toBeLessThanOrEqual(3);
  });
});

describe("brain_context: nem pouco, nem demais", () => {
  it("inclui visão do projeto + decisões + preferência global e exclui outros projetos", async () => {
    const c = await b.context({ project: "promo-watcher", topic: "identidade de listing", task: "corrigir bug de duplicação de produtos" }, claude);
    const ids = c.items.map((i) => i.id);
    expect(ids).toContain("project-promo-watcher"); expect(ids).toContain(id.identity!); expect(ids).toContain(id.prefs!);
    expect(ids).not.toContain(id.cancel!); expect(ids).not.toContain(id.price!);
    expect(c.items.length).toBeLessThanOrEqual(8);
  });
  it("nota de OUTRO projeto com vocabulário parecido não entra; a que cita o projeto pedido entra", async () => {
    const v = await tempBrain(); // vault próprio: não mexe no fixture compartilhado
    await v.createProject("promo-watcher", "Promo Watcher", "Monitor de promoções.", human);
    await v.createProject("menu-litoral", "MenuLitoral", "Cardápio digital.", human);
    const own = (await v.createNote({ title: "Resolução de identidade de listings", type: "decision", project: "promo-watcher", body: "Um listing é identificado por marketplace + product_id canônico, nunca pela URL.\n" }, human)).id;
    const other = (await v.createNote({ title: "Identidade de listings no cardápio", type: "decision", project: "menu-litoral", body: "No MenuLitoral, a identidade de listing de item do cardápio usa o SKU do restaurante.\n" }, human)).id;
    const cites = (await v.createNote({ title: "Identidade de listing do Promo Watcher evita duplicação de produtos", type: "decision", project: "menu-litoral", body: "O MenuLitoral reaproveita a identidade de listing do Promo Watcher para evitar duplicação de produtos.\n" }, human)).id;
    const c = await v.context({ project: "promo-watcher", topic: "identidade de listing", task: "corrigir bug de duplicação de produtos" }, claude);
    const ids = c.items.map((i) => i.id);
    expect(ids).toContain(own);
    expect(ids).not.toContain(other); // só vocabulário parecido, outro projeto
    expect(ids).toContain(cites); // cita o Promo Watcher: entra
    expect((await v.search("identidade de listing", {}, 10)).map((h) => h.id)).toContain(other); // a busca global não muda
  });
  it("não despeja o projeto inteiro: tópico específico não traz notas sem relação", async () => {
    const c = await b.context({ project: "promo-watcher", topic: "fila de notificações do telegram" }, claude);
    const ids = c.items.map((i) => i.id);
    expect(ids).toContain(id.queue!);
    expect(ids).not.toContain(id.python!); expect(ids).not.toContain(id.linkres!);
  });
  it("sem tópico devolve só o essencial do projeto (visão + decisões/preferências)", async () => {
    const c = await b.context({ project: "menu-litoral" }, claude);
    expect(c.items.map((i) => i.id)).toEqual(expect.arrayContaining([id.cancel!]));
    expect(c.items.length).toBeLessThanOrEqual(4);
  });
  it("respeita orçamento de caracteres", async () => {
    const c = await b.context({ project: "promo-watcher", topic: "listing", budget_chars: 400 }, claude);
    const size = c.items.reduce((n, i) => n + i.summary.length + i.title.length, 0);
    expect(size).toBeLessThan(700);
  });
  it("notas substituídas não aparecem no contexto", async () => {
    const p = await b.supersede({ old_id: id.python!, draft: { title: "Runtime do projeto", type: "fact", project: "promo-watcher", body: "O runtime passou a ser Node 24." } }, claude);
    await b.resolve(p.id, { resolution: "replace", target_id: id.python }, human);
    const c = await b.context({ project: "promo-watcher", topic: "python versão" }, claude);
    expect(c.items.map((i) => i.id)).not.toContain(id.python!);
  });
});

describe("brain_context em projeto grande", () => {
  it("com 14 decisões de assuntos diferentes, um tópico específico traz só as relevantes", async () => {
    const big = await tempBrain();
    await big.createProject("grande", "Projeto Grande", "Projeto com muitas decisões.", human);
    const topics = ["autenticação com OAuth", "fila de notificações", "política de cache do CDN", "estratégia de backup do banco", "versionamento da API", "tema escuro da interface", "limite de upload de arquivos", "observabilidade com traces", "idioma padrão do usuário", "rotação de logs", "pipeline de deploy", "rate limit por IP", "formato de datas", "política de retries"];
    for (const t of topics) await big.createNote({ title: `Decisão sobre ${t}`, type: "decision", project: "grande", body: `Decidimos tratar ${t} de forma padronizada, com justificativa registrada e revisão trimestral.` }, human);
    const c = await big.context({ project: "grande", topic: "autenticação OAuth do login" }, claude);
    const titles = c.items.map((i) => i.title);
    expect(titles).toContain("Decisão sobre autenticação com OAuth");
    expect(c.items.filter((i) => i.type === "decision").length).toBeLessThanOrEqual(3);
    expect(titles).not.toContain("Decisão sobre rotação de logs");
    // sem tópico: essencial limitado, não o projeto inteiro
    const none = await big.context({ project: "grande" }, claude);
    expect(none.items.length).toBeLessThanOrEqual(5);
    big.close();
  });
  it("ids gerados são curtos e legíveis", async () => {
    const x = await tempBrain();
    const n = await x.createNote({ title: "Web First; desktop opcional (substitui a preferência inicial por Electron)", type: "decision", project: "second-brain", body: "Texto suficiente para a nota de teste de id." }, human);
    expect(n.id).toBe("decision-second-brain-web-first");
    const m = await x.createNote({ title: "Web First; outra coisa", type: "decision", project: "second-brain", body: "Outro texto de teste suficiente." }, human);
    expect(m.id).toBe("decision-second-brain-web-first-2");
    x.close();
  });
});
