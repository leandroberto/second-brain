import { afterAll, describe, expect, it } from "vitest";
import { Brain, importPath, importText } from "../src/index.js";
import { cleanupRepos, gitRepo } from "./git-fixture.js";
import { cleanup, human, tempBrain } from "./helpers.js";

afterAll(() => { cleanup(); cleanupRepos(); });
const D = (s: string) => `${s}T12:00:00+00:00`;

/** Repositório com uma decisão antiga (catalog_id) substituída por uma nova (listing_id) e um plano nunca implementado. */
function evolvedRepo() {
  return gitRepo([
    { date: D("2026-01-10"), msg: "docs: identity", files: { "docs/specs/2026-01-10-identity-design.md": "# Identidade de ofertas\n\n## Decisão\n\nO resolver de ofertas deve usar `catalog_id` como identidade do produto, porque o catálogo agrupa variantes.\n" } },
    { date: D("2026-01-15"), msg: "feat: resolver", files: { "src/resolver.ts": "export function resolve(o: { catalog_id: string }) { return o.catalog_id; }\n" } },
    { date: D("2026-03-01"), msg: "refactor: resolver por listing", files: {
      "src/resolver.ts": "export function resolve(o: { listing_id: string }) { return o.listing_id; }\n",
      "test/resolver.test.ts": "import { resolve } from '../src/resolver';\nit('listing_id', () => resolve({ listing_id: 'a' }));\n",
      "docs/specs/2026-03-01-listing-design.md": "# Identidade por anúncio\n\n## Decisão\n\nMigramos o resolver de `catalog_id` para `listing_id`: o resolver de ofertas deve usar `listing_id` como identidade, porque o catálogo fragmentava ofertas.\n",
    } },
    { date: D("2026-03-05"), msg: "docs: plano", files: { "docs/specs/2026-03-05-queue-design.md": "# Fila\n\n## Decisões\n\nA ingestão deve usar `IngestQueue` com Kafka para desacoplar o resolver, porque picos de mensagens travam o worker.\n" } },
  ], "shop");
}

describe("fluxo: import reconciliado → proposta → revisão → contexto", () => {
  it("a proposta carrega a atualidade separada da confiança de extração, e o relatório resume estados/esforço", async () => {
    const b = await tempBrain(); const { root } = evolvedRepo();
    const rep = await importPath(b, root, { project: "shop" });
    expect(rep.freshness?.against).toMatch(/^shop@[0-9a-f]{7}/);
    const props = b.listProposals();
    const old = props.find((p) => /catalog_id/.test(p.draft.body) && !/listing_id/.test(p.draft.body))!;
    expect(old.freshness?.state).toMatch(/superseded|historical/);
    expect(old.draft.confidence).toBeDefined();                      // extração (o que a fonte diz) ≠ atualidade
    expect(old.freshness!.evidence.length).toBeGreaterThan(0);
    expect(old.draft.source?.kind).toBe("spec");
    const cur = props.find((p) => /listing_id/.test(p.draft.body) && /Migramos|listing_id como identidade/.test(p.draft.body))!;
    expect(cur.freshness?.state).toBe("current");
    const queue = props.find((p) => /IngestQueue/.test(p.draft.body))!;
    expect(queue.freshness?.state).toBe("planned");
    expect(queue.freshness?.suggestion).toBe("ignore");
    expect(Object.values(rep.freshness!.effort).reduce((a, n) => a + (n ?? 0), 0)).toBe(rep.candidates);
    b.close();
  });

  it("aprovar conhecimento substituído cria nota HISTÓRICA (status superseded + verification), fora do contexto padrão", async () => {
    const b = await tempBrain(); const { root } = evolvedRepo();
    await importPath(b, root, { project: "shop" });
    const old = b.listProposals().find((p) => /catalog_id/.test(p.draft.body) && !/listing_id/.test(p.draft.body))!;
    const cur = b.listProposals().find((p) => p.freshness?.state === "current")!;
    const r1 = await b.resolve(cur.id, { resolution: "create" }, human);
    expect(r1.note!.status).toBe("active");
    expect(r1.note!.verification?.state).toBe("current");
    const r2 = await b.resolve(old.id, { resolution: "create" }, human);
    expect(r2.note!.status).toBe("superseded");
    expect(r2.note!.verification?.state).toMatch(/superseded|historical/);
    expect(r2.note!.verification?.against).toMatch(/^shop@/);
    const ctx = await b.context({ project: "shop", topic: "identidade do resolver de ofertas" });
    expect(ctx.items.some((i) => i.id === r2.note!.id)).toBe(false);   // histórico nunca compete com o atual
    expect(ctx.items.some((i) => i.id === r1.note!.id)).toBe(true);
    expect(ctx.history?.some((h) => h.id === r2.note!.id)).toBe(true); // mas continua acessível, rotulado
    b.close();
  });

  it("'Aceitar' pode ser sobrescrito pelo revisor (as_historical: false cria como atual)", async () => {
    const b = await tempBrain(); const { root } = evolvedRepo();
    await importPath(b, root, { project: "shop" });
    const old = b.listProposals().find((p) => /catalog_id/.test(p.draft.body) && !/listing_id/.test(p.draft.body))!;
    const r = await b.resolve(old.id, { resolution: "create", as_historical: false }, human);
    expect(r.note!.status).toBe("active");
    b.close();
  });

  it("aprovação em lote recusa atualidade não confirmada mesmo com extração alta", async () => {
    const b = await tempBrain(); const { root } = evolvedRepo();
    await importPath(b, root, { project: "shop" });
    const notCurrent = b.listProposals().filter((p) => p.freshness && p.freshness.state !== "current");
    expect(notCurrent.length).toBeGreaterThan(0);
    // força extração alta para provar que a recusa vem da atualidade
    for (const p of notCurrent) { p.draft.confidence = "high"; b.proposals.savePending(p); expect(Brain.bulkEligible(p)).toBe(false); }
    const r = await b.approveMany(notCurrent.map((p) => p.id), human);
    expect(r.created).toHaveLength(0);
    expect(r.skipped.every((s) => /atualidade|semelhante|confiança|classe/.test(s.reason))).toBe(true);
    b.close();
  });

  it("conhecimento histórico parecido com nota ATIVA sugere complementar (anexar como histórico) em vez de criar memória solta", async () => {
    const b = await tempBrain(); const { root } = evolvedRepo();
    await b.createNote({ title: "Resolver de ofertas usa catalog_id como identidade do produto", type: "decision", project: "shop", body: "O resolver de ofertas deve usar `catalog_id` como identidade do produto, porque o catálogo agrupa variantes." }, human);
    const rep = await importPath(b, root, { project: "shop", dryRun: true });
    const it0 = rep.items.find((i) => /catalog_id/.test(i.candidate.body) && !/listing_id/.test(i.candidate.body))!;
    expect(it0.analysis.classification).not.toBe("new");
    expect(["complement_current", "accept_historical"]).toContain(it0.candidate.freshness?.suggestion);
    if (it0.candidate.freshness?.suggestion === "complement_current") expect(it0.candidate.freshness.suggestion_target).toBeTruthy();
    b.close();
  });

  it("texto colado formulado como plano é 'planned' mesmo sem repositório", async () => {
    const b = await tempBrain();
    const rep = await importText(b, "## Decisões de cache\n\nImplementaremos Redis como cache de sessões para reduzir a latência do login, porque o banco não aguenta o pico.\n", { dryRun: true });
    const c = rep.items[0]?.candidate;
    expect(c).toBeTruthy();
    expect(c!.freshness?.state).toBe("planned"); expect(c!.freshness?.suggestion).toBe("ignore");
    b.close();
  });
});

describe("recuperação: atual primeiro, histórico acessível", () => {
  it("brain_context entrega o ATUAL e explica o substituído em `history` (sem colocá-los lado a lado)", async () => {
    const b = await tempBrain();
    const a = await b.createNote({ title: "Listing identity: marketplace + catalog_id", type: "decision", project: "promo", body: "A identidade de listing é marketplace + catalog_id, porque o catálogo agrupa variantes." }, human);
    const p = await b.supersede({ old_id: a.id, draft: { title: "Listing identity: marketplace + listing_id com compatibilidade de título", type: "decision", project: "promo", body: "A identidade de listing passou a ser marketplace + listing_id, com compatibilidade de título, porque catalog_id fragmentava ofertas." } }, human);
    const r = await b.resolve(p.id, { resolution: "replace", target_id: a.id }, human);
    const ctx = await b.context({ project: "promo", topic: "listing identity catalog_id" });
    expect(ctx.items[0]?.id === r.note!.id || ctx.items.some((i) => i.id === r.note!.id)).toBe(true);
    expect(ctx.items.some((i) => i.id === a.id)).toBe(false);
    const h = ctx.history?.find((x) => x.id === a.id);
    expect(h?.superseded_by?.id).toBe(r.note!.id);
    expect(h?.why).toMatch(/não é o estado atual/);
    expect(ctx.items.find((i) => i.id === r.note!.id)?.supersedes?.[0]?.id).toBe(a.id);
    expect(ctx.hint).toMatch(/history/);
    b.close();
  });

  it("pedido explícito de histórico traz resumo do substituído", async () => {
    const b = await tempBrain();
    const a = await b.createNote({ title: "Fila de jobs com RabbitMQ", type: "decision", project: "promo", body: "Jobs usam RabbitMQ para desacoplar a ingestão." }, human);
    const p = await b.supersede({ old_id: a.id, draft: { title: "Fila de jobs com SQLite", type: "decision", project: "promo", body: "Jobs usam uma tabela SQLite como fila: menos infraestrutura." } }, human);
    await b.resolve(p.id, { resolution: "replace", target_id: a.id }, human);
    const ctx = await b.context({ project: "promo", topic: "por que mudou a fila de jobs (histórico)" });
    expect(ctx.history?.find((x) => x.id === a.id)?.summary).toMatch(/RabbitMQ/);
    b.close();
  });

  it("nota ativa com atualidade não confirmada vem rotulada e não compete de igual na busca", async () => {
    const b = await tempBrain();
    const { root } = gitRepo([{ date: D("2026-01-01"), msg: "x", files: { "docs/specs/cache-design.md": "# Cache\n\n## Decisões\n\nA API deve usar Redis como cache de respostas, porque o banco não aguenta o pico de leitura.\n", "src/a.ts": "export {};\n" } }], "api");
    await importPath(b, root, { project: "api" });
    const p = b.listProposals().find((x) => x.freshness?.state === "planned")!;
    expect(p).toBeTruthy();
    await b.resolve(p.id, { resolution: "create" }, human); // o revisor decidiu guardar mesmo assim
    const hits = await b.search("cache de respostas Redis", { project: "api" });
    expect(hits[0]?.freshness).toBe("planned");
    const ctx = await b.context({ project: "api", topic: "cache de respostas" });
    expect(ctx.items.find((i) => i.title === p.draft.title)?.freshness).toBe("planned");
    expect(ctx.hint).toMatch(/não foram confirmados/);
    b.close();
  });
});
