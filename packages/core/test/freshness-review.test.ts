import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { importPath, reconcilePending } from "../src/index.js";
import { changeSide, reconcileBatch } from "../src/freshness/index.js";
import { cleanupRepos, gitRepo } from "./git-fixture.js";
import { cleanup, human, tempBrain } from "./helpers.js";

/** Regressões dos 22 achados da revisão independente (Codex) da reconciliação de atualidade. */
afterAll(() => { cleanup(); cleanupRepos(); });
const D = (s: string) => `${s}T12:00:00+00:00`;
const PKG = (deps: Record<string, string>) => JSON.stringify({ name: "app", dependencies: deps });
async function one(root: string, path: string, title: string, body: string, limits?: object) {
  return (await reconcileBatch([{ title, body, path }], { scanRoot: root, ...(limits ? { limits } : {}) })).results[0]!;
}

describe("revisão independente: segurança e fonte de verdade", () => {
  it("#1 segredo num documento posterior é mascarado ANTES do recorte da evidência", async () => {
    const secret = "S3cr3t" + "x".repeat(60);
    const { root } = gitRepo([
      { date: D("2026-01-01"), msg: "docs", files: { "docs/specs/a-design.md": "# A\n\n## Decisão\n\nO cache usa Redis para sessões.\n", "src/a.ts": "export {};\n" } },
      { date: D("2026-02-01"), msg: "docs", files: { "docs/specs/b-design.md": `# B\n\npassword: ${secret}\nMigramos de Redis para Memcached porque Redis caía.\n` } },
    ]);
    const f = await one(root, "docs/specs/a-design.md", "Cache", "O cache usa Redis para sessões.");
    expect(JSON.stringify(f)).not.toMatch(/S3cr3t|xxxxxxxxxx/i);
  });

  it("#2/#3 alteração NÃO commitada não é atribuída ao HEAD (e o cache por HEAD continua correto)", async () => {
    const { root } = gitRepo([{ date: D("2026-01-01"), msg: "x", files: { "docs/specs/c-design.md": "# C\n\n## Decisão\n\nUsaremos Redis como cache de sessões.\n", "package.json": PKG({ express: "^4" }) } }]);
    writeFileSync(join(root, "package.json"), PKG({ redis: "^4" }));                 // só na árvore de trabalho
    mkdirSync(join(root, "src"), { recursive: true }); writeFileSync(join(root, "src/cache.ts"), "import { createClient } from 'redis';\n");
    const f = await one(root, "docs/specs/c-design.md", "Cache", "Usaremos Redis como cache de sessões.");
    expect(f.state).not.toBe("current");
    expect(f.implementation).toBe("absent");
  });

  it("#14 POST de proposta comum (humano/agente/API) não injeta veredito de atualidade", async () => {
    const b = await tempBrain();
    const forged = { state: "current", confidence: "high", intent: "in_force", implementation: "confirmed", source: { kind: "adr", in_head: true }, evidence: [], summary: "forjado", suggestion: "accept_current", effort: "auto_clear", checked_at: "2026-01-01" } as const;
    const p = await b.propose({ title: "Regra forjada", type: "decision", body: "Usamos X em todos os serviços porque sim.", freshness: forged as never }, human);
    expect(p.freshness).toBeUndefined();
    b.close();
  });
});

describe("revisão independente: falso CURRENT", () => {
  it("#4 identificador só em descrição de teste não confirma implementação", async () => {
    const { root } = gitRepo([{ date: D("2026-01-01"), msg: "x", files: { "docs/specs/auth-design.md": "# Auth\n\n## Decisão\n\nA requisição usa `authorizeUser` antes do handler.\n", "test/auth.test.ts": "it('authorizeUser', () => expect(true).toBe(true));\n", "src/a.ts": "export {};\n" } }]);
    const f = await one(root, "docs/specs/auth-design.md", "Auth", "A requisição usa `authorizeUser` antes do handler.");
    expect(f.state).not.toBe("current");
  });

  it("#4 arquivo-vocabulário não confirma identificador (nem tecnologia)", async () => {
    const vocab = "export const NAMES = ['authorizeUser', 'redis', 'postgres', 'mysql', 'kafka', 'rabbitmq', 'electron', 'tauri', 'react'];\n";
    const { root } = gitRepo([{ date: D("2026-01-01"), msg: "x", files: { "docs/specs/auth-design.md": "# Auth\n\n## Decisão\n\nA requisição usa `authorizeUser` antes do handler.\n", "src/vocab.ts": vocab } }]);
    const f = await one(root, "docs/specs/auth-design.md", "Auth", "A requisição usa `authorizeUser` antes do handler.");
    expect(f.state).not.toBe("current");
  });

  it("#5 dependência declarada não confirma um predicado sobre ela ('Redis criptografa as sessões')", async () => {
    const { root } = gitRepo([{ date: D("2026-01-01"), msg: "x", files: { "docs/plans/p.md": "# Plano\n\n- [ ] Redis criptografa todas as sessões.\n", "package.json": PKG({ redis: "^4" }), "src/a.ts": "import 'redis';\n" } }]);
    const f = await one(root, "docs/plans/p.md", "Sessões", "Redis criptografa todas as sessões.");
    expect(f.state).not.toBe("current");
    expect(f.implementation).not.toBe("confirmed");
  });

  it("#6 commit só de documentação não promove nome próximo a implementado", async () => {
    const { root } = gitRepo([
      { date: D("2026-01-01"), msg: "docs", files: { "docs/specs/z-design.md": "# Z\n\n## Decisão\n\nA autorização usa `authorize_user_strict` em toda rota.\n", "src/auth.ts": "export const authorize_user = () => true;\n" } },
      { date: D("2026-02-01"), msg: "fix: authorize_user_strict typo in docs", files: { "docs/notes.md": "authorize_user_strict\n" } },
    ]);
    const f = await one(root, "docs/specs/z-design.md", "Z", "A autorização usa `authorize_user_strict` em toda rota.");
    expect(f.implementation).not.toBe("confirmed");
    expect(f.state).not.toBe("current");
  });

  it("#12 índice incompleto não prova ausência: Electron fora do índice impede 'atual'", async () => {
    const big = "x".repeat(2000) + "\nimport { app } from 'electron';\n";
    const { root } = gitRepo([{ date: D("2026-01-01"), msg: "x", files: { "docs/decisions/0001-web.md": "# ADR 0001 — Web\n\nStatus: aceito\n\n## Decisão\n\nNão usaremos Electron na V1.\n", "desktop/main.ts": big, "src/a.ts": "export {};\n" } }]);
    const f = await one(root, "docs/decisions/0001-web.md", "Web", "**Decisão:** Não usaremos Electron na V1.", { maxFileBytes: 1000 });
    expect(f.evidence.some((e) => /ausente do HEAD, como a afirmação diz/.test(e.detail))).toBe(false);
    expect(f.evidence.some((e) => /índice parcial/.test(e.detail))).toBe(true);
  });
});

describe("revisão independente: falso SUPERSEDED/REVERTED/HISTORICAL", () => {
  it("#7 voz ativa e negação em frases de troca", () => {
    expect(changeSide("redis replaced memcached for sessions", "redis")).toBe("new");
    expect(changeSide("redis replaced memcached for sessions", "memcached")).toBe("old");
    expect(changeSide("redis was not replaced by memcached", "redis")).toBeUndefined();
    expect(changeSide("redis nao foi substituido por memcached", "redis")).toBeUndefined();
    expect(changeSide("redis was replaced by memcached", "redis")).toBe("old");
  });

  it("#8 adendo que REVERTE a afirmação no mesmo documento não é confundido com a própria afirmação", async () => {
    const { root } = gitRepo([{ date: D("2026-01-01"), msg: "x", files: { "docs/specs/s-design.md": "# Sessões\n\n## Decisão\n\nWe use Redis for session caching.\n\n## Adendo\n\nWe no longer use Redis for session caching.\n", "package.json": PKG({ redis: "^4" }), "src/q.ts": "import { createClient } from 'redis';\nexport const queue = createClient();\n" } }]);
    const f = await one(root, "docs/specs/s-design.md", "Sessões", "We use Redis for session caching.");
    expect(f.state).not.toBe("current");
  });

  it("#9 termo só em comentário TODO no HEAD não vira 'existiu e saiu'", async () => {
    const { root } = gitRepo([
      { date: D("2026-01-01"), msg: "docs", files: { "docs/plans/c.md": "# Plano\n\n- [ ] Implementar `futureCache` na API.\n", "src/a.ts": "export {};\n" } },
      { date: D("2026-02-01"), msg: "chore: note", files: { "src/a.ts": "// TODO: futureCache\nexport {};\n" } },
    ]);
    const f = await one(root, "docs/plans/c.md", "Cache", "Implementar `futureCache` na API.");
    expect(f.state).toBe("planned");
    expect(f.evidence.some((e) => /existiu no código/.test(e.detail))).toBe(false);
  });

  it("#10 revert de melhoria relacionada não reverte o que continua implementado", async () => {
    const { root } = gitRepo([
      { date: D("2026-01-01"), msg: "docs", files: { "docs/specs/k-design.md": "# Cache\n\n## Decisão\n\nAs chaves de cache usam `cacheKey` por usuário.\n", "src/cache.ts": "export const cacheKey = (u: string) => u;\n" } },
      { date: D("2026-02-01"), msg: "feat: cacheKey telemetry", files: { "src/telemetry.ts": "import { cacheKey } from './cache';\nexport const t = cacheKey;\n" } },
      { date: D("2026-03-01"), msg: "revert", revert: 1 },
    ]);
    const f = await one(root, "docs/specs/k-design.md", "Cache", "As chaves de cache usam `cacheKey` por usuário.");
    expect(f.state).not.toBe("reverted");
  });

  it("#11 documento intermediário não vence uma revisão POSTERIOR da própria fonte", async () => {
    const { root } = gitRepo([
      { date: D("2026-01-01"), msg: "spec", files: { "docs/specs/r-design.md": "# R\n\n## Decisão\n\nO cache usa Redis.\n", "src/a.ts": "export {};\n" } },
      { date: D("2026-02-01"), msg: "migração", files: { "docs/specs/m-design.md": "# M\n\nMigramos de Redis para Memcached.\n" } },
      { date: D("2026-03-01"), msg: "spec: volta ao Redis", files: { "docs/specs/r-design.md": "# R\n\n## Decisão\n\nO cache usa Redis (voltamos, Memcached não atendeu).\n", "package.json": PKG({ redis: "^4" }), "src/cache.ts": "import { createClient } from 'redis';\nexport const c = createClient();\n" } },
    ]);
    const f = await one(root, "docs/specs/r-design.md", "R", "O cache usa Redis (voltamos, Memcached não atendeu).");
    expect(f.state).not.toBe("superseded");
    expect(f.state).not.toBe("conflict");
  });

  it("#13 ADR 'proposta' implementada não vira decisão em vigor; plano com rival presente continua 'planned'", async () => {
    const { root } = gitRepo([{ date: D("2026-01-01"), msg: "x", files: {
      "docs/adr/0007-db.md": "# ADR 0007 — Banco\n\nStatus: Proposed\n\n## Decisão\n\nUsar PostgreSQL como banco principal.\n",
      "docs/plans/redis.md": "# Plano\n\n- [ ] We will add Redis as the session cache.\n",
      "package.json": PKG({ pg: "^8", memcached: "^2" }), "src/db.ts": "import { Pool } from 'pg';\nexport const p = new Pool();\n", "src/mc.ts": "import Memcached from 'memcached';\nexport const m = new Memcached();\n",
    } }]);
    const adr = await one(root, "docs/adr/0007-db.md", "Banco", "**Decisão:** Usar PostgreSQL como banco principal.");
    expect(adr.intent).not.toBe("in_force");
    const plan = await one(root, "docs/plans/redis.md", "Cache", "We will add Redis as the session cache.");
    expect(plan.state).toBe("planned");
  });

  it("#17 fonte renomeada continua no HEAD (não vira histórica)", async () => {
    const { root } = gitRepo([
      { date: D("2026-01-01"), msg: "x", files: { "docs/decisions/0003-ops.md": "# ADR 0003 — Operação\n\nStatus: aceito\n\n## Decisão\n\nToda operação passa por revisão humana antes de produção.\n", "src/a.ts": "export {};\n" } },
      { date: D("2026-02-01"), msg: "docs: rename", files: { "docs/decisions/0003-ops.md": null, "docs/decisions/0003-operacao.md": "# ADR 0003 — Operação\n\nStatus: aceito\n\n## Decisão\n\nToda operação passa por revisão humana antes de produção.\n" } },
    ]);
    const f = await one(root, "docs/decisions/0003-ops.md", "Operação", "**Decisão:** Toda operação passa por revisão humana antes de produção.");
    expect(f.state).not.toBe("historical");
    expect(f.source.in_head).toBe(true);
    expect(f.source.path).toBe("docs/decisions/0003-operacao.md");
  });
});

describe("revisão independente: governança e recuperação", () => {
  const evolved = () => gitRepo([
    { date: D("2026-01-10"), msg: "docs", files: { "docs/specs/2026-01-10-identity-design.md": "# Identidade\n\n## Decisão\n\nO resolver de ofertas deve usar `catalog_id` como identidade do produto, porque o catálogo agrupa variantes.\n" } },
    { date: D("2026-01-15"), msg: "feat: resolver", files: { "src/resolver.ts": "export const r = (o: { catalog_id: string }) => o.catalog_id;\n" } },
    { date: D("2026-03-01"), msg: "refactor: listing", files: { "src/resolver.ts": "export const r = (o: { listing_id: string }) => o.listing_id;\n", "docs/specs/2026-03-01-listing-design.md": "# Listing\n\nMigramos o resolver de `catalog_id` para `listing_id` porque o catálogo fragmentava ofertas.\n" } },
  ], "shop");

  it("#15 editar o rascunho rebaixa a verificação (sem cair na exceção 'sem verificação' do lote)", async () => {
    const b = await tempBrain(); const { root } = evolved();
    await importPath(b, root, { project: "shop" });
    const p = b.listProposals().find((x) => x.freshness)!;
    const e = await b.editProposal(p.id, { body: p.draft.body + "\n\nE também criptografa tudo com Redis." }, human);
    expect(e.freshness?.state).toBe("uncertain");
    expect(e.freshness?.summary).toMatch(/editado/);
    b.close();
  });

  it("#16 proposta histórica não pode atualizar/substituir nota atual sem as_historical=false explícito", async () => {
    const b = await tempBrain(); const { root } = evolved();
    const cur = await b.createNote({ title: "Resolver usa catalog_id como identidade do produto", type: "decision", project: "shop", body: "O resolver de ofertas deve usar catalog_id como identidade do produto, porque o catálogo agrupa variantes." }, human);
    await importPath(b, root, { project: "shop", includeDuplicates: true });
    const old = b.listProposals().find((x) => x.freshness && /superseded|historical/.test(x.freshness.state))!;
    await expect(b.resolve(old.id, { resolution: "update", target_id: cur.id }, human)).rejects.toThrow(/histórica/);
    await expect(b.resolve(old.id, { resolution: "replace", target_id: cur.id, as_historical: true }, human)).rejects.toThrow(/histórica/);
    b.close();
  });

  it("#18 import de SUBPASTA grava origem relativa ao repositório e brain reconcile a reencontra", async () => {
    const b = await tempBrain(); const { root } = evolved();
    await importPath(b, join(root, "docs"), { project: "shop" });
    const p = b.listProposals().find((x) => x.freshness)!;
    expect(p.draft.source?.ref).toMatch(/^docs\/specs\//);
    const r = await reconcilePending(b, root);
    expect(r.items.find((x) => x.id === p.id)?.freshness?.source.in_head).toBe(true);
    b.close();
  });

  it("#19/#20/#21 histórico vem de busca separada; o sucessor atual entra mesmo com max_items=1; orçamento inclui o histórico", async () => {
    const b = await tempBrain();
    for (let i = 0; i < 10; i++) await b.createNote({ title: `Fila de jobs observação ${i}`, type: "learning", project: "promo", body: `Observação ${i} sobre fila de jobs e workers.` }, human);
    const a = await b.createNote({ title: "Fila de jobs com RabbitMQ e workers dedicados", type: "decision", project: "promo", body: "A fila de jobs usa RabbitMQ com workers dedicados." }, human);
    const p = await b.supersede({ old_id: a.id, draft: { title: "Tabela SQLite como fila", type: "decision", project: "promo", body: "Persistência de tarefas pendentes numa tabela, sem broker." } }, human);
    const r = await b.resolve(p.id, { resolution: "replace", target_id: a.id }, human);
    const ctx = await b.context({ project: "promo", topic: "fila de jobs RabbitMQ workers", max_items: 2 });
    expect(ctx.history?.some((h) => h.id === a.id)).toBe(true);                        // #19
    expect(ctx.items.some((i) => i.id === r.note!.id)).toBe(true);                     // #20
    const tiny = await b.context({ project: "promo", topic: "histórico: por que mudou a fila de jobs RabbitMQ", budget_chars: 200 });
    const size = JSON.stringify([tiny.items, tiny.history ?? []]).length;
    expect(size).toBeLessThan(1400);                                                    // #21
    expect(tiny.truncated).toBe(true);
    b.close();
  });
});

describe("revisão independente: desempenho", () => {
  it("#22 documentos normalizados/indexados uma vez: 20 candidatos × 400 documentos grandes em tempo razoável", async () => {
    const files: Record<string, string> = { "src/a.ts": "export {};\n" };
    for (let i = 0; i < 400; i++) files[`docs/notes/n${i}.md`] = `# Nota ${i}\n\n` + "Contexto geral do projeto sem relação. ".repeat(700);
    const { root } = gitRepo([{ date: D("2026-01-01"), msg: "x", files }]);
    appendFileSync(join(root, "README.md"), "");
    const items = Array.from({ length: 20 }, (_, i) => ({ title: `Afirmação ${i}`, body: `Usaremos Redis e Kafka com \`worker_queue_${i}\` e Electron.`, path: "docs/notes/n1.md" }));
    const t0 = Date.now();
    await reconcileBatch(items, { scanRoot: root });
    expect(Date.now() - t0).toBeLessThan(15_000);
  });
});

describe("revisão independente — 2ª passada (verificação das correções)", () => {
  it("assunto de commit do pickaxe é mascarado antes do recorte", async () => {
    const token = "ghp_" + "A".repeat(36);
    const { root } = gitRepo([
      { date: D("2026-01-01"), msg: "docs", files: { "docs/specs/x-design.md": "# X\n\n## Decisão\n\nO ranking usa `legacyScore` para ordenar.\n" } },
      { date: D("2026-01-05"), msg: "feat: score", files: { "src/rank.ts": "export const legacyScore = 1;\n" } },
      { date: D("2026-02-05"), msg: `refactor: ${"x".repeat(60)} ${token}`, files: { "src/rank.ts": "export const rank = 1;\n" } },
    ]);
    const f = await one(root, "docs/specs/x-design.md", "X", "O ranking usa `legacyScore` para ordenar.");
    expect(JSON.stringify(f)).not.toMatch(/ghp_A/);
  });

  it("caminho que aponta para arquivo-vocabulário não confirma", async () => {
    const vocab = "export const V = ['redis','postgres','mysql','kafka','rabbitmq','electron','tauri','react','vue'];\n";
    const { root } = gitRepo([{ date: D("2026-01-01"), msg: "x", files: { "docs/specs/a-design.md": "# A\n\n## Decisão\n\nA autorização está implementada em `src/vocab.ts`.\n", "src/vocab.ts": vocab } }]);
    const f = await one(root, "docs/specs/a-design.md", "A", "A autorização está implementada em `src/vocab.ts`.");
    expect(f.state).not.toBe("current");
  });

  it("tecnologia só confirma frase de escolha pura: predicado ('to encrypt…') fica parcial; cópula ('O cache é Redis') confirma", async () => {
    const files = { "package.json": PKG({ redis: "^4" }), "src/cache.ts": "import { createClient } from 'redis';\nexport const c = createClient();\n", "src/s.ts": "import { createClient } from 'redis';\nexport const s = createClient();\n", "test/c.test.ts": "import 'redis';\nit('redis', () => {});\n", "docs/specs/c-design.md": "# C\n" };
    const { root } = gitRepo([{ date: D("2026-01-01"), msg: "x", files }]);
    const a = await one(root, "docs/specs/c-design.md", "Sessões", "We use Redis to encrypt every session, rotate keys daily, and reject expired credentials before processing requests.");
    expect(a.state).not.toBe("current");
    const b = await one(root, "docs/specs/c-design.md", "Cache", "O cache é Redis.");
    expect(b.state).toBe("current");
  });

  it("commit 'fix: typo in comment' no arquivo do nome próximo não promove o nome exato", async () => {
    const { root } = gitRepo([
      { date: D("2026-01-01"), msg: "docs", files: { "docs/specs/z-design.md": "# Z\n\n## Decisão\n\nA autorização usa `authorize_user_strict` em toda rota.\n", "src/auth.ts": "export const authorize_user = () => true;\n" } },
      { date: D("2026-02-01"), msg: "fix: authorize_user_strict typo in comment", files: { "src/auth.ts": "// authorize_user_strict\nexport const authorize_user = () => true;\n" } },
    ]);
    const f = await one(root, "docs/specs/z-design.md", "Z", "A autorização usa `authorize_user_strict` em toda rota.");
    expect(f.state).not.toBe("current");
  });

  it("descontinuação em português ('não usamos mais X') é reconhecida, inclusive como emenda no próprio documento", async () => {
    expect(changeSide("nao usamos mais redis para sessoes", "redis")).toBe("old");
    expect(changeSide("redis nao e mais usado para sessoes", "redis")).toBe("old");
    const { root } = gitRepo([{ date: D("2026-01-01"), msg: "x", files: { "docs/specs/s-design.md": "# Sessões\n\n## Decisão\n\nUsamos Redis para sessões.\n\n## Adendo\n\nNão usamos mais Redis para sessões.\n", "package.json": PKG({ redis: "^4" }), "src/q.ts": "import { createClient } from 'redis';\nexport const q = createClient();\n" } }]);
    const f = await one(root, "docs/specs/s-design.md", "Sessões", "Usamos Redis para sessões.");
    expect(f.state).not.toBe("current");
  });

  it("âncora NÃO verificada (índice parcial + orçamento de grep esgotado) impede confirmação, positiva ou negativa", async () => {
    const big = "x".repeat(3000) + "\nexport function encryptSession() {}\nimport 'electron';\n";
    const { root } = gitRepo([{ date: D("2026-01-01"), msg: "x", files: { "docs/specs/e-design.md": "# E\n", "package.json": PKG({ redis: "^4" }), "src/r.ts": "import { createClient } from 'redis';\nexport const r = createClient();\n", "src/big.ts": big } }]);
    const lim = { maxFileBytes: 2000, grep: 0 };
    const a = await one(root, "docs/specs/e-design.md", "E", "We use Redis with `encryptSession`.", lim);
    expect(a.state).not.toBe("current");
    const b = await one(root, "docs/specs/e-design.md", "E", "We use Redis. We do not use Electron.", lim);
    expect(b.state).not.toBe("current");
  });

  it("revert relacionado + verificação impossível não vira 'revertido/alta'", async () => {
    const big = "y".repeat(3000) + "\nexport const ResponseCache = 1;\n";
    const { root } = gitRepo([
      { date: D("2026-01-01"), msg: "docs", files: { "docs/plans/2026-01-01-perf.md": "# Perf\n\n- [ ] Adicionar `ResponseCache` na API.\n", "src/huge.ts": big } },
      { date: D("2026-01-10"), msg: "feat: add ResponseCache telemetry", files: { "src/tele.ts": "export const t = 'ResponseCache';\n" } },
      { date: D("2026-01-20"), msg: "revert", revert: 1 },
    ]);
    const f = await one(root, "docs/plans/2026-01-01-perf.md", "Perf", "- [ ] Adicionar `ResponseCache` na API.", { maxFileBytes: 2000, grep: 0 });
    expect(f.state).not.toBe("reverted");
  });

  it("documento de migração REVISADO depois da fonte conta como posterior", async () => {
    const { root } = gitRepo([
      { date: D("2026-01-01"), msg: "mig v1", files: { "docs/specs/m-design.md": "# M\n\nNotas de infraestrutura.\n", "src/a.ts": "export {};\n" } },
      { date: D("2026-02-01"), msg: "spec", files: { "docs/specs/r-design.md": "# R\n\n## Decisão\n\nO cache usa `RedisSessionStore` para sessões.\n" } },
      { date: D("2026-03-01"), msg: "mig v2", files: { "docs/specs/m-design.md": "# M\n\nMigramos de `RedisSessionStore` para `MemorySessionStore` porque o Redis caía.\n", "src/store.ts": "export class MemorySessionStore {}\n" } },
    ]);
    const f = await one(root, "docs/specs/r-design.md", "R", "O cache usa `RedisSessionStore` para sessões.");
    expect(["superseded", "historical"]).toContain(f.state);
  });

  it("ADR NÃO versionada: 'Proposed' não vira em vigor; 'Superseded by' é respeitado", async () => {
    const { root } = gitRepo([{ date: D("2026-01-01"), msg: "x", files: { "package.json": PKG({ redis: "^4" }), "src/r.ts": "import { createClient } from 'redis';\nexport const r = createClient();\n" } }]);
    mkdirSync(join(root, "docs/adr"), { recursive: true });
    writeFileSync(join(root, "docs/adr/0001-cache.md"), "# ADR 0001 — Cache\n\nStatus: Proposed\n\n## Decisão\n\nUsar Redis como cache.\n");
    writeFileSync(join(root, "docs/adr/0002-old.md"), "# ADR 0002 — Old\n\nStatus: Accepted\n\nSuperseded by: ADR 0003\n\n## Decisão\n\nUsar Redis como cache.\n");
    const a = await one(root, "docs/adr/0001-cache.md", "Cache", "**Decisão:** Usar Redis como cache.");
    expect(a.intent).not.toBe("in_force");
    const b = await one(root, "docs/adr/0002-old.md", "Old", "**Decisão:** Usar Redis como cache.");
    expect(b.state).toBe("superseded");
  });

  it("fonte com acento no nome renomeada é seguida (core.quotePath=false)", async () => {
    const body = "# ADR 0004 — Operação\n\nStatus: aceito\n\n## Decisão\n\nToda operação passa por revisão humana.\n";
    const { root } = gitRepo([
      { date: D("2026-01-01"), msg: "x", files: { "docs/decisions/0004-operação.md": body, "src/a.ts": "export {};\n" } },
      { date: D("2026-02-01"), msg: "rename", files: { "docs/decisions/0004-operação.md": null, "docs/decisions/0004-operacao.md": body } },
    ]);
    const f = await one(root, "docs/decisions/0004-operação.md", "Operação", "**Decisão:** Toda operação passa por revisão humana.");
    expect(f.source.in_head).toBe(true);
    expect(f.state).not.toBe("historical");
  });
});

describe("revisão independente — 2ª passada: governança e contexto", () => {
  const evolved = () => gitRepo([
    { date: D("2026-01-10"), msg: "docs", files: { "docs/specs/2026-01-10-identity-design.md": "# Identidade\n\n## Decisão\n\nO resolver de ofertas deve usar `catalog_id` como identidade do produto, porque o catálogo agrupa variantes.\n" } },
    { date: D("2026-01-15"), msg: "feat: resolver", files: { "src/resolver.ts": "export const r = (o: { catalog_id: string }) => o.catalog_id;\n" } },
    { date: D("2026-03-01"), msg: "refactor: listing", files: { "src/resolver.ts": "export const r = (o: { listing_id: string }) => o.listing_id;\n", "docs/specs/2026-03-01-listing-design.md": "# Listing\n\nMigramos o resolver de `catalog_id` para `listing_id` porque o catálogo fragmentava ofertas.\n" } },
  ], "shop");

  it("editar o título de uma proposta histórica não remove a proteção contra update/replace", async () => {
    const b = await tempBrain(); const { root } = evolved();
    const cur = await b.createNote({ title: "Resolver usa catalog_id como identidade do produto", type: "decision", project: "shop", body: "O resolver de ofertas deve usar catalog_id como identidade do produto, porque o catálogo agrupa variantes." }, human);
    await importPath(b, root, { project: "shop", includeDuplicates: true });
    const old = b.listProposals().find((x) => x.freshness && /superseded|historical/.test(x.freshness.state))!;
    const e = await b.editProposal(old.id, { title: old.draft.title + "." }, human);
    expect(e.freshness?.stale_from).toMatch(/superseded|historical/);
    await expect(b.resolve(old.id, { resolution: "update", target_id: cur.id }, human)).rejects.toThrow(/histórica/);
    b.close();
  });

  it("histórico pode atualizar nota que já é histórica (nada atual a proteger)", async () => {
    const b = await tempBrain(); const { root } = evolved();
    const a = await b.createNote({ title: "Resolver usa catalog_id como identidade do produto", type: "decision", project: "shop", body: "O resolver de ofertas deve usar catalog_id como identidade do produto, porque o catálogo agrupa variantes." }, human);
    await b.updateNote(a.id, { status: "superseded", expected_revision: a.revision }, human);
    await importPath(b, root, { project: "shop", includeDuplicates: true });
    const old = b.listProposals().find((x) => x.freshness && /superseded|historical/.test(x.freshness.state))!;
    const r = await b.resolve(old.id, { resolution: "update", target_id: a.id, as_historical: true }, human);
    expect(r.proposal.state).toBe("accepted");
    b.close();
  });

  it("max_items=1 com visão geral do projeto: o sucessor atual tem prioridade sobre a visão geral", async () => {
    const b = await tempBrain();
    await b.createProject("promo", "Promo", "Projeto de teste.", human);
    const a = await b.createNote({ title: "Fila de jobs com RabbitMQ e workers dedicados", type: "decision", project: "promo", body: "A fila de jobs usa RabbitMQ com workers dedicados." }, human);
    const p = await b.supersede({ old_id: a.id, draft: { title: "Tabela SQLite como fila", type: "decision", project: "promo", body: "Persistência de tarefas pendentes numa tabela, sem broker." } }, human);
    const r = await b.resolve(p.id, { resolution: "replace", target_id: a.id }, human);
    const ctx = await b.context({ project: "promo", topic: "fila de jobs RabbitMQ workers", max_items: 1 });
    expect(ctx.items.map((i) => i.id)).toEqual([r.note!.id]);
    b.close();
  });

  it("FTS filtra o status ANTES do limite: muitas ativas melhor ranqueadas não escondem a substituída", async () => {
    const b = await tempBrain();
    await b.updateConfig({ git: { auto_commit: false } }, human);
    for (let i = 0; i < 85; i++) await b.createNote({ title: `Workers de fila ${i}`, type: "learning", project: "promo", body: `Workers de fila ${i}: fila fila fila workers workers.` }, human);
    const a = await b.createNote({ title: "Broker RabbitMQ para a fila", type: "decision", project: "promo", body: "A fila usa RabbitMQ como broker." }, human);
    const p = await b.supersede({ old_id: a.id, draft: { title: "Fila em tabela SQLite", type: "decision", project: "promo", body: "Sem broker: tabela de tarefas." } }, human);
    await b.resolve(p.id, { resolution: "replace", target_id: a.id }, human);
    const hits = await b.searcher.search("fila workers rabbitmq", { status: ["superseded"] }, 10);
    expect(hits.some((h) => h.id === a.id)).toBe(true);
    b.close();
  });
});

describe("revisão independente — 3ª passada (sondas do Codex antes da cota acabar)", () => {
  it("escolha pura não aceita predicado ('para criptografar'), frase extra nem parêntese explicativo", async () => {
    const { pureChoice } = await import("../src/freshness/semantics.js");
    expect(pureChoice("Usaremos SQLite como banco local.", "SQLite")).toBe(true);
    expect(pureChoice("O cache é Redis.", "Redis")).toBe(true);
    expect(pureChoice("Usamos Redis para criptografar sessões.", "Redis")).toBe(false);
    expect(pureChoice("We use Redis. Every session is encrypted and credentials expire daily.", "Redis")).toBe(false);
    expect(pureChoice("We use Redis (encrypts all sessions).", "Redis")).toBe(false);
  });

  it("descontinuação NEGADA não é descontinuação", () => {
    expect(changeSide("redis nao deixou de ser usado", "redis")).toBeUndefined();
    expect(changeSide("redis nao e mais obsoleto", "redis")).toBeUndefined();
    expect(changeSide("nao e verdade que nao usamos mais redis", "redis")).toBeUndefined();
    expect(changeSide("nao usamos mais redis", "redis")).toBe("old");
  });

  it("ADR com âncora não verificada não vira atual; falha ao ler o HEAD gera 'incerta' (nunca 'sem verificação')", async () => {
    const big = "z".repeat(3000) + "\nexport function encryptSession() {}\n";
    const { root } = gitRepo([{ date: D("2026-01-01"), msg: "x", files: { "docs/adr/0001-cache.md": "# ADR 0001 — Cache\n\nStatus: Accepted\n\n## Decisão\n\nUsar Redis com `encryptSession`.\n", "package.json": PKG({ redis: "^4" }), "src/r.ts": "import { createClient } from 'redis';\nexport const r = createClient();\n", "src/big.ts": big } }]);
    const f = await one(root, "docs/adr/0001-cache.md", "Cache", "**Decisão:** Usar Redis com `encryptSession`.", { maxFileBytes: 2000, grep: 0 });
    expect(f.state).not.toBe("current");
    const { reconcile } = await import("../src/freshness/index.js");
    const broken = { name: "x", head: undefined } as never;
    const g = await reconcile({ title: "Cache", body: "Usamos Redis.", path: "docs/adr/0001-cache.md" }, { index: broken });
    expect(g?.state).toBe("uncertain");
  });
});
