import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { BRAIN_TOOLS, Brain } from "@brain/core";
import { terminalHuman } from "../../core/test/helpers.js";

const human = await terminalHuman("t");

const BIN = fileURLToPath(new URL("../../cli/dist/bin.js", import.meta.url));
let dir: string; let vault: string;
const clients: Client[] = [];

async function connect(name: string, at = vault): Promise<Client> {
  const c = new Client({ name, version: "1.0.0" });
  await c.connect(new StdioClientTransport({ command: process.execPath, args: [BIN, "mcp"], env: { ...(process.env as Record<string, string>), BRAIN_VAULT: at } }));
  clients.push(c);
  return c;
}
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
  const r = await c.callTool({ name, arguments: args }) as { content: Array<{ text: string }>; isError?: boolean };
  const text = r.content[0]!.text;
  let data: any; try { data = JSON.parse(text); } catch { data = text; }
  return { ...r, data };
};

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-mcp-"));
  vault = join(dir, "vault");
  const b = await Brain.init(vault);
  await b.createProject("promo-watcher", "Promo Watcher", "Projeto de teste.", human);
  await b.createNote({ title: "Resolução de identidade de listings", type: "decision", project: "promo-watcher", body: "Listings são identificados por marketplace e product_id canônico, nunca pela URL." }, human);
  b.close();
});
afterAll(async () => { await Promise.all(clients.map((c) => c.close().catch(() => undefined))); rmSync(dir, { recursive: true, force: true }); });

describe("MCP stdio (Claude Code e Codex compartilhando o mesmo cérebro)", () => {
  it("expõe as 12 ferramentas", async () => {
    const c = await connect("claude-code");
    const names = (await c.listTools()).tools.map((t) => t.name).sort();
    expect(names).toEqual(["brain_amend", "brain_commit", "brain_context", "brain_get", "brain_health", "brain_link", "brain_projects", "brain_propose", "brain_recent", "brain_search", "brain_similar", "brain_supersede"]);
    // o motor de assistente nega tudo o que não libera a partir desta lista: ferramenta nova precisa entrar nela
    expect(names).toEqual([...BRAIN_TOOLS].sort());
  });

  it("dois clientes enxergam a mesma base e propostas um do outro", async () => {
    const claude = await connect("claude-code");
    const codex = await connect("codex");
    const s1 = await call(claude, "brain_search", { query: "listing product_id" });
    const s2 = await call(codex, "brain_search", { query: "listing product_id" });
    expect(s1.data[0].id).toBe(s2.data[0].id);

    const ctx = await call(codex, "brain_context", { project: "promo-watcher", topic: "identidade de listing" });
    expect(ctx.data.items.length).toBeGreaterThan(0);

    const full = await call(claude, "brain_get", { id: s1.data[0].id });
    expect(full.data.body).toContain("product_id");

    const [p1, p2] = await Promise.all([
      call(claude, "brain_propose", { title: "Mercado Livre /lists expõe vários product_ids", type: "learning", project: "promo-watcher", body: "Páginas /lists podem expor múltiplos product_ids; usar a precedência do campo melidata.", source: { type: "pr", repository: "promo-watcher", ref: "#12" } }),
      call(codex, "brain_propose", { title: "Timeout de scraping por marketplace", type: "open-question", project: "promo-watcher", body: "Qual orçamento de timeout usar por marketplace? Ainda indefinido." }),
    ]);
    expect(p1.isError).toBeFalsy(); expect(p2.isError).toBeFalsy();
    // propostas de ambos aparecem na fila e têm autoria correta
    const b = await Brain.open(vault);
    const pend = b.listProposals();
    expect(pend.map((p) => p.proposed_by.name).sort()).toEqual(["claude-code", "codex"]);
    // nada foi persistido sem revisão
    expect(b.db.rows("title LIKE '%Timeout%'").length).toBe(0);
    b.close();
  });

  it("brain_commit é negado por política padrão; segredos são rejeitados", async () => {
    const c = await connect("claude-code");
    const pend = await call(c, "brain_propose", { title: "Regra de logs estruturados", type: "pattern", body: "Sempre usar logs estruturados em JSON com correlation id." });
    const denied = await call(c, "brain_commit", { proposal_id: pend.data.proposal_id, resolution: "create" });
    expect(denied.isError).toBe(true);
    expect(denied.data.error).toBe("forbidden");
    const secret = await call(c, "brain_propose", { title: "Credenciais", type: "fact", body: "A chave é sk-abcdefghijklmnopqrstuvwxyz012345 para produção." });
    expect(secret.isError).toBe(true);
    expect(secret.data.error).toBe("secret_detected");
    expect(JSON.stringify(secret.data)).not.toContain("abcdefghijklmnopqrstuvwxyz012345");
  });

  it("brain_similar, brain_recent, brain_projects, brain_health funcionam", async () => {
    const c = await connect("codex");
    const sim = await call(c, "brain_similar", { title: "Identidade de listings", body: "Listings são identificados por marketplace e product_id.", project: "promo-watcher" });
    expect(["duplicate", "complement", "update"]).toContain(sim.data.classification);
    expect((await call(c, "brain_recent", {})).data.length).toBeGreaterThan(0);
    expect((await call(c, "brain_projects")).data[0].id).toBe("promo-watcher");
    const h = await call(c, "brain_health");
    expect(h.data.git.repo).toBe(true);
    expect(h.data.embeddings.provider).toBe("hash-v1");
  });

  it("registra a consulta por agente (auditoria) sem poluir o Git", async () => {
    const b = await Brain.open(vault);
    const who = new Set(b.db.activity({ limit: 500 }).filter((a) => a.action === "search").map((a) => a.actor_name));
    expect(who.has("claude-code") && who.has("codex")).toBe(true);
    expect((await b.git.log(undefined, 100)).some((c) => /search/.test(c.subject))).toBe(false);
    b.close();
  });

  it("brain_context prefere o ATUAL e explica o substituído em `history` (atual sobre histórico)", async () => {
    const b = await Brain.open(vault);
    const h = human;
    const old = await b.createNote({ title: "Fila de notificações com outbox em Redis", type: "decision", project: "promo-watcher", body: "Notificações passam por um outbox em Redis antes do envio." }, h);
    const p = await b.supersede({ old_id: old.id, draft: { title: "Fila de notificações sem outbox (SQLite)", type: "decision", project: "promo-watcher", body: "Notificações são reservadas no SQLite; não há outbox durável nesta fase." } }, h);
    const r = await b.resolve(p.id, { resolution: "replace", target_id: old.id }, h);
    b.close();
    const c = await connect("codex");
    const ctx = await call(c, "brain_context", { project: "promo-watcher", topic: "outbox de notificações Redis" });
    expect(ctx.isError).toBeFalsy();
    expect(ctx.data.items.some((i: { id: string }) => i.id === r.note!.id)).toBe(true);
    expect(ctx.data.items.some((i: { id: string }) => i.id === old.id)).toBe(false);
    const hist = ctx.data.history.find((x: { id: string }) => x.id === old.id);
    expect(hist.superseded_by.id).toBe(r.note!.id);
    // busca padrão não devolve o substituído; com include_inactive, sim (histórico acessível)
    const s1 = await call(c, "brain_search", { query: "outbox Redis notificações", project: "promo-watcher" });
    expect(s1.data.some((x: { id: string }) => x.id === old.id)).toBe(false);
    const s2 = await call(c, "brain_search", { query: "outbox Redis notificações", project: "promo-watcher", include_inactive: true });
    expect(s2.data.find((x: { id: string }) => x.id === old.id)?.status).toBe("superseded");
  });
});

describe("MCP com a política additive (ADR 0014)", () => {
  it("brain_propose grava direto o que é aditivo e devolve auto; o resto segue na fila", async () => {
    const av = join(dir, "vault-additive");
    const b = await Brain.init(av);
    await b.updateConfig({ agents: { commit_policy: "additive" } }, human);
    const n = await b.createNote({ title: "Timeout do lote", type: "fact", project: "pagamentos-demo", body: "Timeout do lote é 30 s." }, human);
    b.close();
    const c = await connect("claude-code", av);
    const created = await call(c, "brain_propose", { title: "Observação inédita sobre zebras", type: "learning", body: "Zebras listradas confundem moscas hematófagas com o padrão das listras." });
    expect(created.isError).toBeFalsy();
    expect(created.data.auto.resolution).toBe("create");
    expect(created.data.auto.note_id).toBeTruthy();
    expect(created.data.next).toContain("gravado direto (política additive)");
    const queued = await call(c, "brain_propose", { title: "Timeout do lote", type: "fact", project: "pagamentos-demo", body: "Timeout do lote é 60 s.", intent: "complement", target_id: n.id });
    expect(queued.data.auto).toBeUndefined();
    expect(queued.data.classification).toBe("update");
    expect(queued.data.next).toContain("Aguardando revisão humana");
  });
});
