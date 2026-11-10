import { afterAll, describe, expect, it } from "vitest";
import { cleanup, claude, human, tempBrain } from "./helpers.js";

afterAll(cleanup);

describe("busca híbrida", () => {
  it("FTS ignora acentos, filtra por projeto/tipo e ranqueia título", async () => {
    const b = await tempBrain();
    await b.createNote({ title: "Resolução de identidade de listings", type: "decision", project: "promo-watcher", tags: ["marketplace"], body: "Mercado Livre /lists pode expor múltiplos product_ids; usar precedência do melidata." }, human);
    await b.createNote({ title: "Política de cancelamento", type: "decision", project: "menu-litoral", body: "Cancelamento até 5 minutos após confirmação do pedido." }, human);
    await b.createNote({ title: "Preferência de testes", type: "preference", body: "Prefiro testes de integração a mocks excessivos." }, human);

    const r = await b.search("resolucao listing mercado livre");
    expect(r[0]!.title).toMatch(/Resolução/);
    expect(r[0]!.snippet.length).toBeGreaterThan(0);
    expect((await b.search("cancelamento", { project: "promo-watcher" })).length).toBe(0);
    expect((await b.search("cancelamento", { project: "menu-litoral" })).length).toBe(1);
    expect((await b.search("testes", { type: "preference" })).length).toBe(1);
    expect((await b.search("marketplace", { tags: ["marketplace"] })).length).toBe(1);
    expect(await b.search("zzzxxyy inexistente")).toEqual([]);
    b.close();
  });

  it("consulta com sintaxe maliciosa de FTS não quebra", async () => {
    const b = await tempBrain();
    await b.createNote({ title: "Nota", type: "learning", body: "texto qualquer" }, human);
    await expect(b.search('" OR * ) NEAR(a b) -- ; DROP')).resolves.toBeDefined();
    b.close();
  });

  it("brain_context devolve pacote pequeno, sem notas substituídas", async () => {
    const b = await tempBrain();
    await b.createProject("promo-watcher", "Promo Watcher", "Monitor de promoções.", human);
    await b.createNote({ title: "Usar fila para notificações", type: "decision", project: "promo-watcher", body: "Notificações passam por fila durável." }, human);
    await b.createNote({ title: "Estilo de commits", type: "preference", body: "Commits pequenos e em português." }, human);
    for (let i = 0; i < 20; i++) await b.createNote({ title: `Aprendizado ${i} sobre scraping`, type: "learning", project: "promo-watcher", body: `Scraping detalhe ${i} ${"palavra".repeat(i)} notificações.` }, human);
    const c = await b.context({ project: "promo-watcher", topic: "notificações", max_items: 6 }, claude);
    expect(c.items.length).toBeLessThanOrEqual(6);
    expect(c.items.map((i) => i.type)).toContain("project");
    expect(c.items.map((i) => i.title)).toContain("Estilo de commits");
    expect(c.items.every((i) => i.summary.length <= 280)).toBe(true);
    b.close();
  });

  it("registra consultas por agente na atividade (SQLite, não no Git)", async () => {
    const b = await tempBrain();
    const n = await b.createNote({ title: "Alvo", type: "learning", body: "conteúdo pesquisável xyzzy" }, human);
    await b.search("xyzzy", {}, 5, claude);
    const act = b.db.activity({ actor: "claude-code" });
    expect(act.some((a) => a.action === "search")).toBe(true);
    expect(act.some((a) => a.action === "retrieved" && a.target_id === n.id)).toBe(true);
    expect((await b.git.log(undefined, 50)).every((c) => !/search|retrieved/.test(c.subject))).toBe(true);
    b.close();
  });
});

describe("retenção da atividade", () => {
  it("apaga atividade mais antiga que retention.activity_days ao abrir (1×/dia) e mantém a recente", async () => {
    const b = await tempBrain();
    const old = new Date(Date.now() - 400 * 864e5).toISOString();
    b.db.db.prepare("INSERT INTO activity(ts,actor_kind,actor_name,action,target_id,detail) VALUES(?,?,?,?,?,?)").run(old, "agent", "claude-code", "search", null, "{}");
    await b.search("qualquer", {}, 3, claude);
    const root = b.vault.root; b.db.setMeta("last_prune", "0"); b.close();
    const { Brain } = await import("../src/index.js");
    const b2 = await Brain.open(root);
    const rows = b2.db.activity({ limit: 50 });
    expect(rows.some((r) => r.ts === old)).toBe(false);
    expect(rows.some((r) => r.action === "search")).toBe(true);
    b2.close();
  });
});
