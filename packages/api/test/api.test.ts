import { request as httpRequest } from "node:http";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Brain } from "@brain/core";
import { issueHumanSession, startApi, type ApiHandle } from "../src/index.js";
import { terminalHuman } from "../../core/test/helpers.js";

let dir: string; let brain: Brain; let api: ApiHandle; let humanToken: string;
// a UI usa uma sessão HUMANA (emitida num terminal); o api-token do vault identifica um agente local
const H = () => ({ authorization: `Bearer ${humanToken}`, "content-type": "application/json" });
const get = async (p: string) => (await fetch(api.url + p, { headers: H() })).json() as Promise<any>;
const post = async (p: string, body: unknown, method = "POST") => fetch(api.url + p, { method, headers: H(), body: JSON.stringify(body) });

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "brain-api-"));
  brain = await Brain.init(join(dir, "vault"));
  const sessions = { file: join(dir, "ui-sessions.json") };
  api = await startApi(brain, { port: 0, sessions });
  humanToken = issueHumanSession(brain.vault.root, await terminalHuman("alice", sessions), sessions);
});
afterAll(async () => { await api.close(); brain.close(); rmSync(dir, { recursive: true, force: true }); });

describe("API local", () => {
  it("exige token, host e origem válidos", async () => {
    expect((await fetch(api.url + "/api/health")).status).toBe(401);
    expect((await fetch(api.url + "/api/health", { headers: { authorization: "Bearer errado" } })).status).toBe(401);
    expect((await fetch(api.url + "/api/health", { headers: { ...H(), origin: "http://evil.example" } })).status).toBe(403);
    const status = await new Promise<number>((res) => {
      const rq = httpRequest({ host: "127.0.0.1", port: api.port, path: "/api/health", headers: { ...H(), host: "evil.example" } }, (r) => { r.resume(); res(r.statusCode ?? 0); });
      rq.end();
    });
    expect(status).toBe(403);
    expect((await fetch(api.url + "/api/health", { headers: H() })).status).toBe(200);
  });

  it("ciclo: criar projeto/nota, buscar, propor, revisar (complement), editar com revision", async () => {
    expect((await post("/api/projects", { slug: "meu-proj", title: "Meu Projeto", summary: "teste" })).status).toBe(200);
    const created = await (await post("/api/notes", { title: "Cache de preços", type: "decision", project: "meu-proj", body: "Preços são cacheados por 10 minutos no edge." })).json() as any;
    expect(created.id).toBeTruthy();
    expect((await get("/api/search?q=cache+precos")).map((h: any) => h.id)).toContain(created.id);
    expect((await get("/api/projects"))[0].notes).toBe(2);

    const prop = await (await post("/api/proposals", { title: "Cache de preços", type: "decision", project: "meu-proj", body: "A invalidação do cache é feita por tag a cada alteração de cardápio, via webhook interno." })).json() as any;
    expect(prop.analysis.classification).toBe("complement");
    expect((await get("/api/review")).length).toBe(1);
    const pv = await get(`/api/proposals/${prop.id}/preview?resolution=complement`);
    expect(pv.after).toContain("Complemento");
    const res = await (await post(`/api/proposals/${prop.id}/resolve`, { resolution: "complement" })).json() as any;
    expect(res.commit).toBeTruthy();
    expect((await get("/api/review")).length).toBe(0);

    const detail = await get(`/api/notes/${created.id}`);
    expect(detail.note.body).toContain("webhook");
    expect(detail.history.length).toBeGreaterThanOrEqual(2);
    // revision antiga => 409
    const stale = await post(`/api/notes/${created.id}`, { tags: ["x"], expected_revision: created.revision }, "PATCH");
    expect(stale.status).toBe(409);
    const ok = await post(`/api/notes/${created.id}`, { tags: ["x"], expected_revision: detail.note.revision }, "PATCH");
    expect(ok.status).toBe(200);
  });

  it("rejeita segredo com 422 e não ecoa o valor", async () => {
    const r = await post("/api/notes", { title: "x", type: "fact", body: "password = supersecret12345" });
    expect(r.status).toBe(422);
    expect(await r.text()).not.toContain("supersecret12345");
  });

  it("detecta edição externa (Obsidian) e atualiza o índice", async () => {
    const notes = await get("/api/notes");
    const n = notes.find((x: any) => x.title === "Cache de preços");
    const detail = await get(`/api/notes/${n.id}`);
    const f = join(brain.vault.root, detail.note.path);
    writeFileSync(f, readFileSync(f, "utf8") + "\nEditado manualmente no Obsidian: zxqvunique.\n");
    for (let i = 0; i < 30; i++) { if ((await get("/api/search?q=zxqvunique")).length) break; await new Promise((r) => setTimeout(r, 250)); }
    expect((await get("/api/search?q=zxqvunique")).length).toBe(1);
    expect((await get("/api/git/dirty")).length).toBe(1);
  });

  it("import: preview não grava; submit cria propostas; caminho fora da home é negado", async () => {
    const md = "# Proj\n\nProjeto de teste de importação via API.\n\n## Armadilhas conhecidas\nAtenção: o webhook reenvia a mesma atualização duas vezes; cuidado com idempotência por update_id.\n";
    const before = (await get("/api/proposals")).length;
    const prev = await (await post("/api/import/preview", { kind: "text", text: md, project: "meu-proj" })).json() as any;
    expect(prev.dry_run).toBe(true); expect(prev.items.length).toBeGreaterThanOrEqual(1);
    expect((await get("/api/proposals")).length).toBe(before);
    const sub = await (await post("/api/import/submit", { candidates: prev.items.map((i: any) => ({ ...i.candidate, source_ref: i.source_ref })), project: "meu-proj", repo: "teste" })).json() as any;
    expect(sub.queued).toBe(prev.items.length);
    expect((await get("/api/proposals")).length).toBe(before + sub.queued);
    expect((await post("/api/import/preview", { kind: "path", path: "/etc" })).status).toBe(403);
    expect((await post("/api/import/submit", { candidates: [{ title: "x", body: "password = supersecret12345 aaaa", type: "fact" }] })).status).toBe(200); // vira item rejected, não 500
    expect((await post("/api/import/submit", { candidates: [] })).status).toBe(400);
  });

  it("import: a atualidade vem do servidor, nunca do cliente (plano colado continua 'planned' mesmo forjando 'current')", async () => {
    const md = "## Decisões de cache\n\nImplementaremos Redis como cache de sessões para reduzir a latência do login, porque o banco não aguenta o pico.\n";
    const prev = await (await post("/api/import/preview", { kind: "text", text: md, project: "cache-proj" })).json() as any;
    expect(prev.items[0].candidate.freshness.state).toBe("planned");
    expect(prev.freshness.states.planned).toBe(1);
    const forged = prev.items.map((i: any) => ({ ...i.candidate, source_ref: i.source_ref, freshness: { ...i.candidate.freshness, state: "current", confidence: "high", suggestion: "accept_current" } }));
    const sub = await (await post("/api/import/submit", { candidates: forged, project: "cache-proj", repo: "teste", source: prev.source })).json() as any;
    expect(sub.queued).toBe(1);
    const p = (await get("/api/proposals")).find((x: any) => x.draft.project === "cache-proj");
    expect(p.freshness.state).toBe("planned");
    // fonte fora da home: nenhuma atualidade (nem a forjada)
    const sub2 = await (await post("/api/import/submit", { candidates: forged.map((c: any) => ({ ...c, title: c.title + " 2", body: c.body + " Segunda versão." })), project: "cache-proj-2", repo: "teste", source: "/etc" })).json() as any;
    expect(sub2.items[0].candidate.freshness).toBeUndefined();
  });

  it("settings: troca de config validada; opt-in externo obrigatório", async () => {
    const r = await post("/api/settings", { git: { auto_commit_external: true } }, "PUT");
    expect(r.status).toBe(200);
    const bad = await post("/api/settings", { governance: { stale_days: "abc" } }, "PUT");
    expect(bad.status).toBeGreaterThanOrEqual(400);
    const s = await get("/api/settings");
    expect(s.embedder.external).toBe(false);
  });
});
