import { afterAll, describe, expect, it } from "vitest";
import { clearRepoCache, reconcileBatch } from "../src/freshness/index.js";
import { assignedInFile, productionStatement, stateClaims, toggleStatement } from "../src/freshness/propositions.js";
import { canonicalIdent } from "../src/freshness/semantics.js";
import { cleanupRepos, gitRepo } from "./git-fixture.js";

afterAll(cleanupRepos);

/** Atualidade SENSÍVEL À ORIGEM: notas de agente/humano são sínteses — palavras parecidas não as refutam; proposição incompatível sim. */
const check = async (root: string, note: { title: string; body: string }, asOf: string, origin: "agent" | "human" = "agent") => {
  clearRepoCache();
  const r = await reconcileBatch([{ ...note, origin, asOf }], { scanRoot: root, ignore: ["proj"] });
  return r.results[0]!;
};
const FLAG = new Set(["conflict", "superseded", "historical", "reverted"]);

describe("atualidade por origem (síntese de agente/humano)", () => {
  const flagNote = { title: "LINK_RESOLUTION está desligada em produção", body: "A flag `LINK_RESOLUTION` está desligada; a resolução de links roda só manualmente." };

  it("1. doc relacionado cita a feature sem falar de estado → NÃO contradiz", async () => {
    const { root } = gitRepo([
      { date: "2026-01-05T10:00:00Z", msg: "feat: init", files: { "src/links.py": "def resolve(url):\n    return url\n", "README.md": "# Proj\n" } },
      { date: "2026-03-01T10:00:00Z", msg: "docs: links", files: { "docs/links.md": "# Links\n\nO LINK_RESOLUTION controla a resolução de links do catálogo. Ver também o worker de mídia.\n" } },
    ]);
    const f = await check(root, flagNote, "2026-02-01");
    expect(FLAG.has(f.state)).toBe(false);
    expect(f.suggestion).not.toBe("revalidate");
    expect(f.evidence.some((e) => e.stance === "contradicts")).toBe(false);
    expect(f.origin).toBe("agent");
  });

  it("2. config do HEAD com LINK_RESOLUTION=true → revalidação (conflito com evidência)", async () => {
    const { root } = gitRepo([
      { date: "2026-01-05T10:00:00Z", msg: "feat: init", files: { "src/links.py": "def resolve(url):\n    return url\n", "config/features.yaml": "LINK_RESOLUTION: false\n" } },
      { date: "2026-03-01T10:00:00Z", msg: "feat: liga resolução de links", files: { "config/features.yaml": "LINK_RESOLUTION: true\n" } },
    ]);
    const f = await check(root, flagNote, "2026-02-01");
    expect(f.state).toBe("conflict"); expect(f.suggestion).toBe("revalidate"); expect(f.effort).toBe("quick");
    expect(f.evidence.find((e) => e.stance === "contradicts")!.ref).toBe("config/features.yaml:1");
  });

  const prodNote = { title: "Projeto ainda não está em produção", body: "Em 14/10/2026 o projeto ainda está em pré-produção; dados de ambientes de desenvolvimento podem ser recriados." };

  it("3. nota temporal + doc de planejamento (\"quando entrar em produção…\") → continua atual", async () => {
    const { root } = gitRepo([
      { date: "2026-09-01T10:00:00Z", msg: "feat: init", files: { "src/app.ts": "export const app = 1;\n", "README.md": "# Proj\n" } },
      { date: "2026-10-20T10:00:00Z", msg: "docs: plano de lançamento", files: { "docs/launch-plan.md": "# Plano\n\nQuando entrar em produção, executar a migration de backfill X. Após o lançamento em produção, ligar backups diários.\n" } },
    ]);
    const f = await check(root, prodNote, "2026-10-14", "human");
    expect(f.state).toBe("current");
    expect(f.evidence.some((e) => e.stance === "contradicts")).toBe(false);
  });

  it("4. nota temporal + release/config POSTERIOR dizendo produção → revalidação obrigatória", async () => {
    const { root } = gitRepo([
      { date: "2026-09-01T10:00:00Z", msg: "feat: init", files: { "src/app.ts": "export const app = 1;\n", "config/app.yaml": "production_enabled: false\n" } },
      { date: "2026-11-02T10:00:00Z", msg: "release: v1", files: { "config/app.yaml": "production_enabled: true\n", "RELEASES.md": "# Releases\n\n## v1\n\nProduction launch completed on 2026-11-02 for the first customers.\n" } },
    ]);
    const f = await check(root, prodNote, "2026-10-14", "human");
    expect(f.state).toBe("conflict"); expect(f.suggestion).toBe("revalidate");
    const refs = f.evidence.filter((e) => e.stance === "contradicts").map((e) => e.ref);
    expect(refs).toContain("config/app.yaml:1"); expect(refs).toContain("RELEASES.md");
  });

  it("4b. documento ANTERIOR à nota dizendo produção NÃO contradiz (fonte velha: vira contexto para corrigir a fonte)", async () => {
    const { root } = gitRepo([
      { date: "2026-05-29T10:00:00Z", msg: "docs: progress", files: { "docs/PROGRESS.md": "# Progresso\n\nHoje é uma plataforma SaaS B2B modular e multi-tenant em produção.\n", "src/app.ts": "export const app = 1;\n" } },
    ]);
    const f = await check(root, prodNote, "2026-10-14", "human");
    expect(f.state).toBe("current");
    expect(f.evidence.some((e) => e.ref === "docs/PROGRESS.md" && e.stance === "context" && /ANTERIOR/.test(e.detail))).toBe(true);
  });

  it("5. síntese com 3 evidências no código/testes + documento ANTIGO contra → CURRENT", async () => {
    const { root } = gitRepo([
      { date: "2026-01-02T10:00:00Z", msg: "docs: rascunho", files: { "docs/old-design.md": "# Design antigo\n\nA IngestQueue foi substituída por um cron simples.\n" } },
      { date: "2026-02-01T10:00:00Z", msg: "feat: ingest queue", files: { "src/ingest/queue.ts": "export class IngestQueue { push() {} }\nexport const ingest_batch_size = 50;\n", "src/ingest/worker.ts": "import { IngestQueue } from './queue';\nexport const q = new IngestQueue();\n", "test/ingest/queue.test.ts": "import { IngestQueue } from '../../src/ingest/queue';\ntest('push', () => new IngestQueue().push());\n" } },
    ]);
    const f = await check(root, { title: "Ingestão passa pela IngestQueue", body: "O worker usa `IngestQueue` (`src/ingest/queue.ts`) com lote `ingest_batch_size`; coberto por testes." }, "2026-03-01");
    expect(f.state).toBe("current"); expect(["medium", "high"]).toContain(f.confidence);
    expect(f.evidence.some((e) => e.stance === "contradicts")).toBe(false);
  });

  it("6. síntese contradita por ADR POSTERIOR + código atual → superseded/conflito com revalidação", async () => {
    const { root } = gitRepo([
      { date: "2026-01-02T10:00:00Z", msg: "feat: outbox redis", files: { "src/outbox.ts": "export class RedisOutbox { send() {} }\n" } },
      { date: "2026-03-10T10:00:00Z", msg: "feat: troca outbox para sqlite", files: { "src/outbox.ts": "export class SqliteOutbox { send() {} }\n", "docs/adr/0007-outbox.md": "# ADR 0007 — Outbox no SQLite\n\nStatus: aceito\n\n## Decisão\n\nO RedisOutbox foi substituído pelo SqliteOutbox: menos infraestrutura.\n" } },
    ]);
    const f = await check(root, { title: "Notificações saem pelo RedisOutbox", body: "Notificações usam o `RedisOutbox` antes do envio ao Telegram." }, "2026-02-01");
    expect(["superseded", "conflict"]).toContain(f.state);
    expect(f.suggestion).toBe("revalidate");
    expect(f.evidence.filter((e) => e.stance === "contradicts").length).toBeGreaterThan(0);
  });

  it("documento importado continua refutável por documento posterior (estratégia antiga preservada)", async () => {
    const { root } = gitRepo([
      { date: "2026-01-02T10:00:00Z", msg: "docs", files: { "docs/design.md": "# Design\n\nNotificações usam o `RedisOutbox`.\n", "src/outbox.ts": "export class SqliteOutbox {}\n" } },
      { date: "2026-03-10T10:00:00Z", msg: "docs: mudança", files: { "docs/changelog.md": "# Changelog\n\nO RedisOutbox foi substituído pelo SqliteOutbox.\n" } },
    ]);
    clearRepoCache();
    const r = await reconcileBatch([{ title: "Outbox", body: "Notificações usam o `RedisOutbox`.", path: "docs/design.md", origin: "imported" }], { scanRoot: root, ignore: ["proj"] });
    expect(["superseded", "historical"]).toContain(r.results[0]!.state);
  });

  describe("revisão independente (Codex) — proposições e datas", () => {
    it("camelCase no config é a MESMA chave; comentário não conta; atribuições conflitantes = ambíguo", async () => {
      const { root } = gitRepo([
        { date: "2026-01-05T10:00:00Z", msg: "feat", files: { "src/app.ts": "// featureEnabled = false (valor antigo)\nexport const featureEnabled = true;\n", "src/flags.ts": "export const otherFlag = true;\n// otherFlag = false\n" } },
      ]);
      const camel = await check(root, { title: "featureEnabled está desligada", body: "A flag `featureEnabled` está desligada em produção." }, "2026-02-01");
      expect(camel.state).toBe("conflict"); expect(camel.evidence.find((e) => e.stance === "contradicts")!.ref).toBe("src/app.ts:2");
      const viaComment = await check(root, { title: "otherFlag está desligada", body: "A flag `otherFlag` está desligada." }, "2026-02-01");
      expect(viaComment.state).toBe("conflict"); // a linha comentada (false) não "confirma" a nota
    });

    it("nome explícito removido (resta só em comentário) + outro nome presente → NÃO confirma a nota inteira", async () => {
      const { root } = gitRepo([
        { date: "2026-01-02T10:00:00Z", msg: "feat", files: { "src/h.ts": "export function oldHandler() {}\nexport function liveHandler() {}\n" } },
        { date: "2026-03-01T10:00:00Z", msg: "refactor: remove oldHandler", files: { "src/h.ts": "// oldHandler foi removido\nexport function liveHandler() {}\n" } },
      ]);
      const f = await check(root, { title: "Eventos passam por oldHandler e liveHandler", body: "O fluxo chama `oldHandler` e depois `liveHandler`." }, "2026-04-01");
      expect(f.state).not.toBe("current");
    });

    it("ADR posterior que diz o oposto de um toggle contradiz; ADR ANTERIOR à síntese não a substitui", async () => {
      const { root } = gitRepo([
        { date: "2026-01-02T10:00:00Z", msg: "feat", files: { "src/cfg.ts": "export const FEATURE_ENABLED = process.env.FEATURE_ENABLED;\n", "docs/adr/0001-feature.md": "# ADR 0001 — Feature\n\nStatus: aceito\n\nFEATURE_ENABLED está desligada por padrão.\n" } },
        { date: "2026-03-01T10:00:00Z", msg: "docs: liga feature", files: { "docs/adr/0002-liga.md": "# ADR 0002 — Liga a feature\n\nStatus: aceito\n\nA partir desta ADR, FEATURE_ENABLED está ligada.\n" } },
      ]);
      const late = await check(root, { title: "FEATURE_ENABLED está desligada", body: "A flag `FEATURE_ENABLED` está desligada." }, "2026-02-01");
      expect(late.state).toBe("conflict"); expect(late.suggestion).toBe("revalidate");
      const after = await check(root, { title: "FEATURE_ENABLED está ligada", body: "A flag `FEATURE_ENABLED` está ligada desde a ADR 0002." }, "2026-04-01");
      expect(after.evidence.some((e) => e.stance === "contradicts")).toBe(false);
    });

    it("modalidade: condição não vira fato; 'indisponível' não é pré-produção; ambíguo fica de fora", () => {
      expect(stateClaims("Se o sistema não está em produção, use dados fictícios.").some((c) => c.prop === "production")).toBe(false);
      expect(stateClaims("O sistema não está disponível agora.").some((c) => c.prop === "production")).toBe(false);
      expect(stateClaims("FEATURE_X fica desligada unless o cliente pedir.").some((c) => c.prop === "enabled")).toBe(false);
      expect(productionStatement("ate o lancamento da v2, o sistema esta em producao.")).toBeUndefined();
      expect(productionStatement("after launch, the system is in production.")).toBeUndefined();
      expect(productionStatement("o geoledger ainda nao esta em producao.")).toBe(false);
      expect(productionStatement("production launch completed on 2026-11-02.")).toBe(true);
      expect(stateClaims("O sistema não está rodando em produção.").map((c) => c.value)).toEqual([false]);
      expect(stateClaims("O sistema não foi lançado em produção.").map((c) => c.value)).toEqual([false]);
      expect(stateClaims("A plataforma SaaS B2B modular e multi-tenant em produção.").map((c) => c.value)).toEqual([true]);
    });

    it("ADR citada pela síntese já substituída ANTES da nota não a refuta; ADR substituta só PROPOSTA também não", async () => {
      const { root } = gitRepo([
        { date: "2026-01-02T10:00:00Z", msg: "docs", files: { "docs/adr/0001-fila.md": "# ADR 0001 — Fila em Redis\n\nStatus: substituída pela ADR 0002\n", "docs/adr/0002-fila.md": "# ADR 0002 — Fila em SQLite\n\nStatus: aceito\n\nSupersedes: ADR 0001\n", "src/q.ts": "export class SqliteQueue {}\n" } },
        { date: "2026-05-02T10:00:00Z", msg: "docs: proposta", files: { "docs/adr/0003-fila.md": "# ADR 0003 — Fila em Kafka\n\nStatus: proposto\n\nSupersedes: ADR 0002\n" } },
      ]);
      clearRepoCache();
      const r = await reconcileBatch([
        { title: "Histórico: a fila saiu do Redis", body: "A ADR 0001 (Redis) foi trocada pela ADR 0002; hoje a fila é `SqliteQueue`.", path: "docs/adr/0001-fila.md", origin: "agent", asOf: "2026-03-01" },
        { title: "Fila em SQLite", body: "A fila de jobs usa `SqliteQueue` (ADR 0002).", path: "docs/adr/0002-fila.md", origin: "agent", asOf: "2026-03-01" },
      ], { scanRoot: root, ignore: ["proj"] });
      expect(r.results[0]!.state).not.toBe("superseded");
      expect(r.results[1]!.state).toBe("current"); // a ADR 0003 só PROPÕE substituir
    });

    it("comentário no fim da linha não conta; camelCase em documento é reconhecido", () => {
      expect(assignedInFile(["const x = 1; // FEATURE_ENABLED = false", "FEATURE_ENABLED = true"], ["FEATURE_ENABLED"])).toEqual({ value: true, line: 2 });
      expect(assignedInFile(["FEATURE_ENABLED = false", "FEATURE_ENABLED = true"], ["FEATURE_ENABLED"])).toBeUndefined();
      expect(toggleStatement("A partir de hoje featureEnabled está ligada.", "feature_enabled", canonicalIdent)).toBe(true);
    });

    it("as_of só com data vale até o fim do dia: documento do MESMO dia não é posterior", async () => {
      const { root } = gitRepo([
        { date: "2026-10-14T12:00:00-03:00", msg: "docs", files: { "RELEASES.md": "# R\n\nProduction launch completed on 2026-10-14.\n", "src/a.ts": "export const a = 1;\n" } },
      ]);
      const f = await check(root, prodNote, "2026-10-14", "human");
      expect(f.evidence.some((e) => e.stance === "contradicts")).toBe(false);
    });
  });
});
