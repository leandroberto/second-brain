import { afterAll, describe, expect, it } from "vitest";
import { reconcileBatch, anchorsOf, changeSide, isPlanLanguage, sourceKindOf } from "../src/freshness/index.js";
import { cleanupRepos, gitRepo } from "./git-fixture.js";

afterAll(cleanupRepos);

/** Reconcilia UMA afirmação de um arquivo do repositório sintético. */
async function check(root: string, path: string, title: string, body: string) {
  const r = await reconcileBatch([{ title, body, path }], { scanRoot: root });
  return r.results[0]!;
}
const D = (s: string) => `${s}T12:00:00+00:00`;
const PKG = (deps: Record<string, string>) => JSON.stringify({ name: "app", dependencies: deps }, null, 2);

describe("atualidade: 10 casos obrigatórios", () => {
  it("1. plano 'Implementaremos Redis' sem Redis no HEAD → planned, nunca current", async () => {
    const { root } = gitRepo([
      { date: D("2026-01-05"), msg: "docs: plano", files: { "docs/plans/2026-01-05-cache.md": "# Plano\n\n## Task 1: Sessões\n\nImplementaremos Redis como cache de sessões.\n", "src/app.ts": "export const app = () => 1;\n", "package.json": PKG({ express: "^4" }) } },
      { date: D("2026-02-01"), msg: "feat: app", files: { "src/app.ts": "export const app = () => 2;\n" } },
    ]);
    const f = await check(root, "docs/plans/2026-01-05-cache.md", "Sessões", "Implementaremos Redis como cache de sessões.");
    expect(f.state).toBe("planned");
    expect(f.source.kind).toBe("plan");
    expect(f.implementation).toBe("absent");
    expect(f.suggestion).not.toBe("accept_current");
    expect(f.evidence.some((e) => e.stance === "contradicts" && /Redis/i.test(e.detail))).toBe(true);
  });

  it("2. spec 'Usaremos SQLite' com SQLite + testes no HEAD → current (implementado)", async () => {
    const { root } = gitRepo([
      { date: D("2026-01-05"), msg: "docs: spec", files: { "docs/specs/storage-design.md": "# Storage\n\n## Decisão\n\nUsaremos SQLite como banco local.\n" } },
      { date: D("2026-01-20"), msg: "feat: storage", files: { "src/db.ts": "import Database from \"better-sqlite3\";\nexport const open = (f: string) => new Database(f);\n", "package.json": PKG({ "better-sqlite3": "^11" }), "test/db.test.ts": "import Database from \"better-sqlite3\";\nit('opens sqlite', () => { new Database(':memory:'); });\n" } },
    ]);
    const f = await check(root, "docs/specs/storage-design.md", "Banco local", "Usaremos SQLite como banco local.");
    expect(f.state).toBe("current");
    expect(f.implementation).toBe("confirmed");
    expect(f.confidence).toBe("high");
    expect(f.evidence.some((e) => e.stance === "supports" && /teste/.test(e.detail))).toBe(true);
  });

  it("3. ADR-001 'REST' substituída explicitamente pela ADR-005 'gRPC' → superseded com a ADR posterior como evidência", async () => {
    const { root } = gitRepo([
      { date: D("2025-03-01"), msg: "docs: adr 1", files: { "docs/adr/0001-api-rest.md": "# ADR 0001 — API REST\n\nStatus: Accepted\n\n## Decisão\n\nUsar REST para a API pública.\n" } },
      { date: D("2026-02-01"), msg: "docs: adr 5", files: { "docs/adr/0005-api-grpc.md": "# ADR 0005 — gRPC\n\nStatus: Accepted\n\nSupersedes ADR-0001.\n\n## Decisão\n\nUsar gRPC para a API pública.\n", "src/server.ts": "import * as grpc from \"@grpc/grpc-js\";\nexport const s = new grpc.Server();\n", "package.json": PKG({ "@grpc/grpc-js": "^1" }) } },
    ]);
    const old = await check(root, "docs/adr/0001-api-rest.md", "API REST", "**Decisão:** Usar REST para a API pública.");
    expect(old.state).toBe("superseded");
    expect(old.intent).toBe("superseded");
    expect(old.confidence).toBe("high");
    expect(old.evidence.some((e) => e.ref === "docs/adr/0005-api-grpc.md")).toBe(true);
    const cur = await check(root, "docs/adr/0005-api-grpc.md", "gRPC", "**Decisão:** Usar gRPC para a API pública.");
    expect(cur.state).toBe("current");
  });

  it("4. spec antiga 'resolver usa catalog_id', código com listing_id e doc posterior explicando a migração → superseded", async () => {
    const { root } = gitRepo([
      { date: D("2026-01-10"), msg: "docs: identity spec", files: { "docs/specs/2026-01-10-identity-design.md": "# Identidade\n\n## Decisão\n\nO resolver usa `catalog_id` como identidade do produto.\n" } },
      { date: D("2026-01-15"), msg: "feat: resolver", files: { "src/resolver.ts": "export function resolve(o: { catalog_id: string }) { return o.catalog_id; }\n", "test/resolver.test.ts": "it('uses catalog_id', () => {});\n" } },
      { date: D("2026-03-01"), msg: "refactor: resolver por listing", files: { "src/resolver.ts": "export function resolve(o: { listing_id: string }) { return o.listing_id; }\n", "test/resolver.test.ts": "it('uses listing_id', () => {});\n", "docs/specs/2026-03-01-listing-migration-design.md": "# Migração de identidade\n\nMigramos o resolver de `catalog_id` para `listing_id`, porque o catálogo fragmentava ofertas.\n" } },
    ]);
    const f = await check(root, "docs/specs/2026-01-10-identity-design.md", "Identidade", "O resolver usa `catalog_id` como identidade do produto.");
    expect(["superseded", "historical"]).toContain(f.state);
    expect(f.state).not.toBe("current");
    expect(f.evidence.some((e) => e.ref === "docs/specs/2026-03-01-listing-migration-design.md")).toBe(true);
    expect(f.suggestion).toBe("accept_historical");
  });

  it("5. ADR antiga 'PostgreSQL' ainda configurada e testada → current apesar da idade e de muitos commits", async () => {
    const steps = [{ date: D("2023-04-01"), msg: "docs: adr", files: { "docs/adr/0002-postgres.md": "# ADR 0002 — Banco\n\nStatus: Accepted\n\n## Decisão\n\nUsar PostgreSQL como banco principal.\n", "docker-compose.yml": "services:\n  db:\n    image: postgres:16\n", "package.json": PKG({ pg: "^8" }), "src/db.ts": "import { Pool } from \"pg\";\nexport const pool = new Pool({ connectionString: process.env.POSTGRES_URL });\n", "test/db.test.ts": "it('connects to postgres', () => {});\n" } }];
    for (let i = 0; i < 25; i++) steps.push({ date: D(`2025-${String((i % 12) + 1).padStart(2, "0")}-0${(i % 8) + 1}`), msg: `feat: change ${i}`, files: { [`src/f${i}.ts`]: `export const v${i} = ${i};\n` } } as never);
    const { root } = gitRepo(steps);
    const f = await check(root, "docs/adr/0002-postgres.md", "Banco", "**Decisão:** Usar PostgreSQL como banco principal.");
    expect(f.state).toBe("current");
    expect(f.intent).toBe("in_force");
    expect(f.implementation).toBe("confirmed");
  });

  it("6. plano 'Adicionar cache' implementado e depois revertido; HEAD sem cache → reverted", async () => {
    const { root } = gitRepo([
      { date: D("2026-01-01"), msg: "docs: plano", files: { "docs/plans/2026-01-01-perf.md": "# Performance\n\n- [ ] Adicionar cache de respostas.\n", "src/api.ts": "export const get = () => fetch('/x');\n" } },
      { date: D("2026-01-10"), msg: "feat: add response cache", files: { "src/cache.ts": "export class ResponseCache { map = new Map(); }\n" } },
      { date: D("2026-01-20"), msg: "revert", revert: 1 },
    ]);
    const f = await check(root, "docs/plans/2026-01-01-perf.md", "Performance", "- [ ] Adicionar cache de respostas.");
    expect(f.state).toBe("reverted");
    expect(f.evidence.some((e) => e.kind === "git" && /revertido/.test(e.detail))).toBe(true);
    expect(f.suggestion).toBe("accept_historical");
  });

  it("7. docs dizem MySQL; código + testes usam PostgreSQL → conflict (doc desatualizada), não current", async () => {
    const { root } = gitRepo([
      { date: D("2025-06-01"), msg: "docs", files: { "docs/operations.md": "# Operação\n\n## Banco\n\nO armazenamento usa MySQL em produção.\n" } },
      { date: D("2026-01-01"), msg: "feat: db", files: { "package.json": PKG({ pg: "^8" }), "src/db.ts": "import { Pool } from \"pg\";\nconst postgresUrl = process.env.POSTGRES_URL;\nexport const pool = new Pool({ connectionString: postgresUrl });\n", "test/db.test.ts": "it('postgres pool', () => {});\n" } },
    ]);
    const f = await check(root, "docs/operations.md", "Banco", "O armazenamento usa MySQL em produção.");
    expect(f.state).toBe("conflict");
    expect(f.implementation).toBe("diverges");
    expect(f.suggestion).not.toBe("accept_current");
    expect(f.evidence.some((e) => e.stance === "contradicts" && /postgres/i.test(e.detail))).toBe(true);
  });

  it("8. ADR antiga 'MongoDB', código usa PostgreSQL, nada explica → estado de implementação ≠ intenção; uncertain, sem inventar decisão", async () => {
    const { root } = gitRepo([
      { date: D("2025-01-01"), msg: "docs: adr", files: { "docs/adr/0003-banco.md": "# ADR 0003 — Banco\n\nStatus: Accepted\n\n## Decisão\n\nUsar MongoDB para persistência.\n" } },
      { date: D("2026-01-01"), msg: "feat: db", files: { "package.json": PKG({ pg: "^8" }), "src/db.ts": "import { Pool } from \"pg\";\nexport const pool = new Pool();\n" } },
    ]);
    const f = await check(root, "docs/adr/0003-banco.md", "Banco", "**Decisão:** Usar MongoDB para persistência.");
    expect(f.state).toBe("uncertain");
    expect(f.implementation).toBe("diverges");
    expect(f.intent).toBe("unknown");                 // código NÃO prova intenção
    expect(f.suggestion).toBe("investigate");
    expect(f.effort).toBe("investigate");
    expect(f.summary).not.toMatch(/decid/i);          // não inventa uma decisão nova
  });

  it("9. dois documentos antigos concordam em Kafka; HEAD sem evidência → não current, e repetição não aumenta a confiança", async () => {
    const { root } = gitRepo([
      { date: D("2025-01-01"), msg: "docs", files: { "docs/specs/events-design.md": "# Eventos\n\n## Decisão\n\nUsaremos Kafka para eventos de domínio.\n", "docs/specs/billing-design.md": "# Cobrança\n\n## Decisão\n\nUsaremos Kafka para eventos de domínio.\n", "src/app.ts": "export const app = 1;\n" } },
    ]);
    const r = await reconcileBatch([
      { title: "Eventos", body: "Usaremos Kafka para eventos de domínio.", path: "docs/specs/events-design.md" },
      { title: "Cobrança", body: "Usaremos Kafka para eventos de domínio.", path: "docs/specs/billing-design.md" },
    ], { scanRoot: root });
    const [a, b] = r.results as [NonNullable<(typeof r.results)[0]>, NonNullable<(typeof r.results)[0]>];
    expect(a.state).not.toBe("current"); expect(b.state).not.toBe("current");
    expect(a.state).toBe("planned");
    expect(a.confidence).toBe(b.confidence);
    expect(a.confidence).not.toBe("high");
    // a outra spec não aparece como evidência de suporte
    expect(a.evidence.some((e) => e.stance === "supports" && e.kind === "doc")).toBe(false);
  });

  it("10. fonte antiga mas comprovadamente válida → current", async () => {
    const steps = [{ date: D("2023-02-01"), msg: "docs: readme", files: { "README.md": "# Ferramenta\n\nA CLI lê a configuração de `config.yaml` com `loadConfig`.\n", "src/config.ts": "import { readFileSync } from \"node:fs\";\nexport function loadConfig(p = \"config.yaml\") { return readFileSync(p, \"utf8\"); }\n", "test/config.test.ts": "import { loadConfig } from \"../src/config\";\nit('loadConfig reads config.yaml', () => loadConfig);\n", "config.yaml": "port: 1\n" } }];
    for (let i = 0; i < 10; i++) steps.push({ date: D(`2025-0${(i % 9) + 1}-10`), msg: `chore: ${i}`, files: { [`src/x${i}.ts`]: `export const x${i} = ${i};\n` } } as never);
    const { root } = gitRepo(steps);
    const f = await check(root, "README.md", "Configuração", "A CLI lê a configuração de `config.yaml` com `loadConfig`.");
    expect(f.state).toBe("current");
    expect(f.implementation).toBe("confirmed");
  });
});

describe("atualidade: casos reais sanitizados", () => {
  it("gate de rollback (feature) NÃO é revert: commits 'rollback' e código com o gate → current", async () => {
    // padrão do Promo Watcher: "LINK_RESOLUTION a real rollback gate"; nenhum commit foi revertido
    const { root } = gitRepo([
      { date: D("2026-09-17"), msg: "docs: make LINK_RESOLUTION a real rollback gate in the listing identity spec", files: { "docs/superpowers/specs/2026-09-17-listing-identity-design.md": "# Listing identity\n\n## Rollback\n\nO gate `LINK_RESOLUTION` desliga a resolução de links e permite rollback para o modo anterior.\n" } },
      { date: D("2026-09-18"), msg: "test: cover listing identity resolution end to end and LINK_RESOLUTION rollback", files: { "src/link_resolver.py": "LINK_RESOLUTION = os.getenv('LINK_RESOLUTION', 'off')\n", "tests/unit/test_link_resolver.py": "def test_link_resolution_rollback():\n    assert LINK_RESOLUTION\n" } },
    ]);
    const f = await check(root, "docs/superpowers/specs/2026-09-17-listing-identity-design.md", "Rollback", "O gate `LINK_RESOLUTION` desliga a resolução de links e permite rollback para o modo anterior.");
    expect(f.state).toBe("current");
    expect(f.evidence.some((e) => /revertido/.test(e.detail))).toBe(false);
  });

  it("ADR que rejeita Electron, sem Electron no HEAD → current (polaridade negativa satisfeita)", async () => {
    const { root } = gitRepo([
      { date: D("2026-10-01"), msg: "docs", files: { "docs/decisions/0001-web-first.md": "# ADR 0001 — Web First; desktop opcional (substitui a preferência inicial por Electron)\n\nStatus: aceito\n\n## Decisão\n\nA interface é web servida pela API local; não usaremos Electron na V1.\n", "apps/web/src/main.tsx": "import React from \"react\";\n", "package.json": PKG({ react: "^18" }) } },
    ]);
    const f = await check(root, "docs/decisions/0001-web-first.md", "Web First; desktop opcional (substitui a preferência inicial por Electron)", "**Decisão:** A interface é web servida pela API local; não usaremos Electron na V1.");
    expect(f.state).toBe("current");
    expect(f.evidence.some((e) => e.stance === "supports" && /Electron/i.test(e.detail))).toBe(true);
  });

  it("ADR com Electron presente no HEAD apesar de dizer que não usaria → não current", async () => {
    const { root } = gitRepo([
      { date: D("2026-10-01"), msg: "docs", files: { "docs/decisions/0001-web-first.md": "# ADR 0001 — Web First\n\nStatus: aceito\n\n## Decisão\n\nNão usaremos Electron na V1.\n" } },
      { date: D("2026-10-05"), msg: "feat: shell", files: { "package.json": PKG({ electron: "^30" }), "desktop/main.ts": "import { app } from \"electron\";\napp.whenReady();\n" } },
    ]);
    const f = await check(root, "docs/decisions/0001-web-first.md", "Web First", "**Decisão:** Não usaremos Electron na V1.");
    expect(f.state).not.toBe("current");
    expect(f.implementation).toBe("diverges");
  });

  it("documento removido do HEAD e implementação ausente → historical", async () => {
    const { root } = gitRepo([
      { date: D("2026-01-01"), msg: "docs", files: { "docs/specs/queue-design.md": "# Fila\n\n## Decisão\n\nUsar RabbitMQ para jobs.\n", "src/a.ts": "export {};\n" } },
      { date: D("2026-04-01"), msg: "docs: remove old spec", files: { "docs/specs/queue-design.md": null } },
    ]);
    const f = await check(root, "docs/specs/queue-design.md", "Fila", "Usar RabbitMQ para jobs.");
    expect(f.state).toBe("historical");
    expect(f.source.in_head).toBe(false);
  });

  it("identificador que existiu no código e saiu (pickaxe) → historical, com o commit que o removeu", async () => {
    const { root } = gitRepo([
      { date: D("2026-01-01"), msg: "docs", files: { "docs/specs/score-design.md": "# Score\n\n## Decisão\n\nO ranking usa `legacyScore` para ordenar ofertas.\n" } },
      { date: D("2026-01-05"), msg: "feat: score", files: { "src/rank.ts": "export const legacyScore = (x: number) => x;\n" } },
      { date: D("2026-02-05"), msg: "refactor: novo ranking", files: { "src/rank.ts": "export const rank = (x: number) => x * 2;\n" } },
    ]);
    const f = await check(root, "docs/specs/score-design.md", "Score", "O ranking usa `legacyScore` para ordenar ofertas.");
    expect(f.state).toBe("historical");
    expect(f.evidence.some((e) => e.kind === "git" && /refactor: novo ranking/.test(e.detail))).toBe(true);
  });

  it("teste pulado não conta como evidência de comportamento atual", async () => {
    const { root } = gitRepo([
      { date: D("2026-01-01"), msg: "x", files: { "docs/specs/fx-design.md": "# FX\n\n## Decisão\n\nConversão usa `convertCurrency` com taxa diária.\n", "test/fx.test.ts": "it.skip('convertCurrency', () => {\n  convertCurrency(1);\n});\n" } },
    ]);
    const f = await check(root, "docs/specs/fx-design.md", "FX", "Conversão usa `convertCurrency` com taxa diária.");
    expect(f.state).not.toBe("current");
  });

  it("identificador entre crases no documento continua explícito mesmo com o corpo limpo pelo extrator", async () => {
    const { root } = gitRepo([{ date: D("2026-01-01"), msg: "x", files: { "docs/specs/q-design.md": "# Fila\n\n## Decisões\n\nA ingestão deve usar `IngestQueue` para desacoplar o resolver.\n", "src/a.ts": "export {};\n" } }]);
    const f = await check(root, "docs/specs/q-design.md", "Fila", "A ingestão deve usar IngestQueue para desacoplar o resolver.");
    expect(f.state).toBe("planned");
    expect(f.evidence.some((e) => /IngestQueue/.test(e.detail) && e.stance === "contradicts")).toBe(true);
    // PascalCase solto na prosa (nome de produto) ausente do código NÃO é contradição
    const g = await check(root, "docs/specs/q-design.md", "Stack", "O projeto inteiro é escrito em TypeScript moderno com tipagem estrita.");
    expect(g.evidence.some((e) => /TypeScript/.test(e.detail))).toBe(false);
  });

  it("negação sem verbo de escolha é ambígua: 'o serviço não conhece aiogram' não rejeita aiogram (Promo Watcher, Fase 2)", async () => {
    const { root } = gitRepo([{ date: D("2026-08-23"), msg: "x", files: { "docs/specs/fase2-design.md": "# Fase 2\n\n## Arquitetura\n\nO serviço de query não conhece aiogram, e o controller Telegram não conhece SQL.\n", "pyproject.toml": "[project]\ndependencies = [\n  \"aiogram>=3\",\n]\n", "src/bot.py": "import aiogram\n" } }]);
    const f = await check(root, "docs/specs/fase2-design.md", "Arquitetura da Fase 2", "O serviço de query não conhece aiogram, e o controller Telegram não conhece SQL.");
    expect(f.evidence.some((e) => /rejeita/.test(e.detail))).toBe(false);
    expect(f.effort).not.toBe("investigate");
  });

  it("'todo' em português (= inteiro) não transforma decisão em plano; TODO maiúsculo sim", () => {
    expect(isPlanLanguage("Sinais de cabeçalho devem ser ancorados no início do título, não em todo o título.")).toBe(false);
    expect(isPlanLanguage("TODO: migrar o resolver.")).toBe(true);
  });

  it("ADR vigente ainda não implementada (decisão adiada) → planned com sugestão 'confirmar', não 'ignorar'", async () => {
    const { root } = gitRepo([{ date: D("2026-10-01"), msg: "x", files: { "docs/decisions/0009-desktop.md": "# ADR 0009 — Shell desktop futuro (decisão adiada)\n\nStatus: aceito\n\n## Decisão\n\nQuando houver shell desktop, comparar Tauri e Electron pelos critérios abaixo.\n", "src/a.ts": "export {};\n" } }]);
    const f = await check(root, "docs/decisions/0009-desktop.md", "Shell desktop futuro", "**Decisão:** Quando houver shell desktop, comparar Tauri e Electron pelos critérios abaixo.");
    expect(f.state).toBe("planned");
    expect(f.intent).toBe("in_force");
    expect(f.suggestion).toBe("confirm");
  });

  it("termo presente em arquivo-vocabulário do HEAD não vira 'existiu e saiu' pelo pickaxe", async () => {
    const vocab = "export const TECH = ['redis','postgres','mysql','kafka','rabbitmq','electron','tauri','react','vue'];\n";
    const { root } = gitRepo([
      { date: D("2026-01-01"), msg: "docs", files: { "docs/specs/cache-design.md": "# Cache\n\n## Decisão\n\nUsaremos Redis como cache.\n", "src/a.ts": "export {};\n" } },
      { date: D("2026-02-01"), msg: "feat: lexicon", files: { "src/lexicon.ts": vocab } },
    ]);
    const f = await check(root, "docs/specs/cache-design.md", "Cache", "Usaremos Redis como cache.");
    expect(f.state).toBe("planned");
    expect(f.evidence.some((e) => /existiu no código/.test(e.detail))).toBe(false);
  });

  it("ADR: 'X desligado' não contradiz ausência; alternativa citada só no contexto não contradiz; item da decisão ausente sim (delivery-saas ADR-023)", async () => {
    const { root } = gitRepo([{ date: D("2026-10-11"), msg: "x", files: { "docs/adr/ADR-023-ts.md": "# ADR-023 — TypeScript 6\n\n**Status:** Aceito\n\n## Contexto\nO Next só usa o TS 7 com `experimental.useTypeScriptCli`.\n\n## Decisão\nTypeScript 6 com `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` desligado, `verbatimModuleSyntax`.\n", "tsconfig.json": "{ \"compilerOptions\": { \"noUncheckedIndexedAccess\": true } }\n" } }]);
    const f = await check(root, "docs/adr/ADR-023-ts.md", "TypeScript 6", "**Decisão:** TypeScript 6 com noUncheckedIndexedAccess, exactOptionalPropertyTypes desligado, verbatimModuleSyntax.\n\n**Por quê:** O Next só usa o TS 7 com experimental.useTypeScriptCli.");
    const contra = f.evidence.filter((e) => e.stance === "contradicts").map((e) => e.detail).join(" ");
    expect(contra).toMatch(/verbatimModuleSyntax/);            // drift real: a decisão inclui, o tsconfig não
    expect(contra).not.toMatch(/exactOptionalPropertyTypes/);  // "desligado": ausência é coerente
    expect(contra).not.toMatch(/useTypeScriptCli/);            // alternativa citada no porquê
  });

  it("documento genérico que é lista de tarefas é tratado como plano", () => {
    expect(sourceKindOf("docs/roadmap-q3.md")).toBe("plan");
    expect(sourceKindOf("docs/notes.md", "# Notas\n\n- [ ] a\n- [x] b\n- [ ] c\n")).toBe("plan");
    expect(sourceKindOf("docs/superpowers/specs/2026-09-17-listing-identity-resolution-design.md")).toBe("spec");
    expect(sourceKindOf("docs/superpowers/plans/2026-09-18-fix.md")).toBe("plan");
    expect(sourceKindOf("CLAUDE.md")).toBe("agents");
    expect(sourceKindOf("docs/decisions/0004-basic-memory.md")).toBe("adr");
  });
});

describe("atualidade: semântica (unidades)", () => {
  it("lado antigo/novo em frases de mudança", () => {
    expect(changeSide("migramos o resolver de catalog_id para listing_id", "catalog_id")).toBe("old");
    expect(changeSide("migramos o resolver de catalog_id para listing_id", "listing_id")).toBe("new");
    expect(changeSide("usar grpc em vez de rest", "rest")).toBe("old");
    expect(changeSide("usar grpc em vez de rest", "grpc")).toBe("new");
    expect(changeSide("substituir redis por memcached", "redis")).toBe("old");
    expect(changeSide("substituir redis por memcached", "memcached")).toBe("new");
    expect(changeSide("redis foi substituido por memcached", "redis")).toBe("old");
    expect(changeSide("a meta antiga (listing_id_ratio_7d) deixou de refletir o objetivo", "listing_id_ratio_7d")).toBe("old");
    expect(changeSide("o resolver usa listing_id", "listing_id")).toBeUndefined();
  });
  it("polaridade das âncoras: 'sem/não/em vez de' marca como negada; nome do projeto é ignorado", () => {
    const a = anchorsOf("Web", "Usamos React em vez de Vue.js e não usaremos Electron.", ["promo-watcher"]);
    expect(a.find((x) => x.key === "tech:react")?.polarity).toBe("pos");
    expect(a.find((x) => x.key === "tech:vue")?.polarity).toBe("neg");
    expect(a.find((x) => x.key === "tech:electron")?.polarity).toBe("neg");
    expect(anchorsOf("Promo Watcher", "O promo_watcher usa Telethon.", ["promo-watcher"]).some((x) => /promo/.test(x.key))).toBe(false);
  });
});
